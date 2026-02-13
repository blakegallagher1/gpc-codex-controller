import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AppServerClient } from "./appServerClient.js";
import { Controller } from "./controller.js";
import { startRpcServer } from "./rpcServer.js";

interface CliOptions {
  workspace: string;
  stateFile?: string;
  serverCommand: string;
  serverArgs: string;
  workspacesRoot?: string;
  requestTimeoutMs?: string;
  loginTimeoutMs?: string;
  prompt?: string;
  threadId?: string;
  taskId?: string;
  maxIterations?: string;
  title?: string;
  body?: string;
}

function parsePositiveInteger(value: string | undefined, optionName: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${optionName}: expected a positive integer, got ${value}`);
  }

  return parsed;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      workspace: {
        type: "string",
        default: process.cwd(),
      },
      stateFile: {
        type: "string",
      },
      serverCommand: {
        type: "string",
        default: "codex",
      },
      workspacesRoot: {
        type: "string",
      },
      serverArgs: {
        type: "string",
        default: "app-server",
      },
      requestTimeoutMs: {
        type: "string",
      },
      loginTimeoutMs: {
        type: "string",
      },
      prompt: {
        type: "string",
      },
      threadId: {
        type: "string",
      },
      taskId: {
        type: "string",
      },
      maxIterations: {
        type: "string",
      },
      title: {
        type: "string",
      },
      body: {
        type: "string",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  const cli = values as unknown as CliOptions;
  const command = positionals[0];
  if (!command) {
    throw new Error("Missing command. Use one of: serve, start, continue, verify, fix, pr, mutate, eval, garden, parallel, review, review-loop, quality, lint, arch-validate, doc-validate, reproduce-bug, gc-sweep");
  }

  const workspacePath = resolve(cli.workspace);
  const stateFilePath = resolve(cli.stateFile ?? `${workspacePath}/.gpc-codex-controller/state.json`);

  const requestTimeoutMs = parsePositiveInteger(cli.requestTimeoutMs, "requestTimeoutMs");
  const loginTimeoutMs = parsePositiveInteger(cli.loginTimeoutMs, "loginTimeoutMs");
  const serverArgs = cli.serverArgs.split(" ").map((part) => part.trim()).filter(Boolean);

  const appServerClientOptions: ConstructorParameters<typeof AppServerClient>[0] = {
    command: cli.serverCommand,
    args: serverArgs,
    cwd: workspacePath,
  };
  if (requestTimeoutMs !== undefined) {
    appServerClientOptions.requestTimeoutMs = requestTimeoutMs;
  }

  const appServerClient = new AppServerClient(appServerClientOptions);

  appServerClient.on("stderr", (text: string) => {
    process.stderr.write(`[codex app-server] ${text}`);
  });

  appServerClient.on("protocolError", (error: Error) => {
    process.stderr.write(`[codex app-server protocol error] ${error.message}\n`);
  });

  const controllerOptions: ConstructorParameters<typeof Controller>[1] = {
    workspacePath,
    stateFilePath,
  };
  if (cli.workspacesRoot?.trim()) {
    controllerOptions.workspacesRoot = cli.workspacesRoot.trim();
  }
  if (loginTimeoutMs !== undefined) {
    controllerOptions.loginTimeoutMs = loginTimeoutMs;
  }

  const controller = new Controller(appServerClient, controllerOptions);

  const shutdown = async (): Promise<void> => {
    await appServerClient.stop();
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(130));
  });

  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(143));
  });

  switch (command) {
    case "serve": {
      const bindHost = process.env.MCP_BIND ?? "127.0.0.1";
      const portText = process.env.MCP_PORT ?? process.env.CONTROLLER_PORT ?? "8787";
      const port = Number(portText);
      if (!Number.isFinite(port) || port <= 0) {
        throw new Error(`Invalid MCP_PORT: ${portText}`);
      }

      const bearerToken = process.env.MCP_BEARER_TOKEN;
      const server = await startRpcServer({
        controller,
        bindHost,
        port,
        ...(bearerToken && bearerToken.trim().length > 0 ? { bearerToken } : {}),
      });

      const baseUrl = (process.env.MCP_BASE_URL ?? "").replace(/\/+$/, "");
      const localBase = `http://${bindHost}:${port}`;
      const mcpEndpoint = baseUrl ? `${baseUrl}/rpc` : `${localBase}/rpc`;

      process.stdout.write(
        JSON.stringify({
          ok: true,
          command,
          bindHost,
          port,
          mcpEndpoint,
          routes: { health: "/healthz", rpc: "/rpc", mcp: "/mcp" },
          auth: bearerToken ? "bearer" : "none",
        }) + "\n",
      );

      process.stderr.write(`\n`);
      process.stderr.write(`  MCP server running.\n`);
      process.stderr.write(`\n`);
      process.stderr.write(`  ➜  MCP endpoint: ${mcpEndpoint}\n`);
      if (baseUrl) {
        process.stderr.write(`  ➜  Local server: ${localBase}\n`);
      }
      process.stderr.write(`  ➜  Health check: ${baseUrl ? `${baseUrl}/healthz` : `${localBase}/healthz`}\n`);
      process.stderr.write(`\n`);
      process.stderr.write(`  Add the MCP endpoint URL above to ChatGPT under Settings → MCP / Tools.\n`);
      process.stderr.write(`\n`);

      const stop = async (): Promise<void> => {
        await server.close();
        await shutdown();
      };

      process.on("SIGINT", () => {
        void stop().finally(() => process.exit(130));
      });

      process.on("SIGTERM", () => {
        void stop().finally(() => process.exit(143));
      });

      // Keep process alive.
      await new Promise<void>(() => {});
    }
    case "start": {
      if (!cli.prompt || cli.prompt.trim().length === 0) {
        throw new Error("start requires --prompt");
      }

      const result = await controller.startTask(cli.prompt);
      console.log(JSON.stringify({ ok: true, command, ...result }));
      break;
    }
    case "continue": {
      if (!cli.threadId || cli.threadId.trim().length === 0) {
        throw new Error("continue requires --threadId");
      }
      if (!cli.prompt || cli.prompt.trim().length === 0) {
        throw new Error("continue requires --prompt");
      }

      const result = await controller.continueTask(cli.threadId, cli.prompt);
      console.log(JSON.stringify({ ok: true, command, ...result }));
      break;
    }
    case "verify": {
      if (!cli.taskId || cli.taskId.trim().length === 0) {
        throw new Error("verify requires --taskId");
      }

      const result = await controller.runVerify(cli.taskId);
      console.log(
        JSON.stringify({
          ok: true,
          command,
          taskId: result.taskId,
          workspacePath: result.workspacePath,
          success: result.success,
          exitCode: result.exitCode,
          failureCount: result.parsedFailures.length,
        }),
      );
      break;
    }
    case "fix": {
      if (!cli.taskId || cli.taskId.trim().length === 0) {
        throw new Error("fix requires --taskId");
      }

      const maxIterations = parsePositiveInteger(cli.maxIterations, "maxIterations") ?? 5;
      const result = await controller.fixUntilGreen(cli.taskId, maxIterations);
      console.log(
        JSON.stringify({
          ok: true,
          command,
          taskId: result.taskId,
          success: result.success,
          iterations: result.iterations,
          verifyExitCode: result.lastVerify.exitCode,
        }),
      );
      break;
    }
    case "pr": {
      if (!cli.taskId || cli.taskId.trim().length === 0) {
        throw new Error("pr requires --taskId");
      }
      if (!cli.title || cli.title.trim().length === 0) {
        throw new Error("pr requires --title");
      }

      const prUrl = await controller.createPullRequest(cli.taskId, cli.title, cli.body ?? "");
      console.log(JSON.stringify({ ok: true, command, taskId: cli.taskId, prUrl }));
      break;
    }
    case "mutate": {
      if (!cli.taskId || cli.taskId.trim().length === 0) {
        throw new Error("mutate requires --taskId");
      }
      if (!cli.prompt || cli.prompt.trim().length === 0) {
        throw new Error("mutate requires --prompt (feature description)");
      }

      const result = await controller.runMutation(cli.taskId, cli.prompt);
      console.log(
        JSON.stringify({
          ok: true,
          command,
          taskId: result.taskId,
          branch: result.branch,
          prUrl: result.prUrl,
          iterations: result.iterations,
          success: result.success,
          evalScore: result.evalScore,
        }),
      );
      break;
    }
    case "eval": {
      if (!cli.taskId || cli.taskId.trim().length === 0) {
        throw new Error("eval requires --taskId");
      }

      const result = await controller.runEval(cli.taskId);
      console.log(
        JSON.stringify({
          ok: true,
          command,
          taskId: cli.taskId,
          overallScore: result.overallScore,
          passed: result.passed,
          checks: result.checks.map((c) => ({ name: c.name, passed: c.passed, score: c.score })),
        }),
      );
      break;
    }
    case "garden": {
      if (!cli.taskId || cli.taskId.trim().length === 0) {
        throw new Error("garden requires --taskId");
      }

      const result = await controller.runDocGardening(cli.taskId);
      console.log(JSON.stringify({ ok: true, command, ...result }));
      break;
    }
    case "parallel": {
      // Parallel mode reads tasks from stdin as JSON: [{ "taskId": "...", "featureDescription": "..." }, ...]
      const stdinChunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        stdinChunks.push(chunk as Buffer);
      }
      const stdinText = Buffer.concat(stdinChunks).toString("utf8").trim();
      if (stdinText.length === 0) {
        throw new Error("parallel requires JSON array of tasks on stdin");
      }

      const tasks = JSON.parse(stdinText) as Array<{ taskId: string; featureDescription: string }>;
      if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new Error("parallel requires a non-empty JSON array of { taskId, featureDescription }");
      }

      const result = await controller.runParallel(tasks);
      console.log(
        JSON.stringify({
          ok: true,
          command,
          totalTasks: result.totalTasks,
          succeeded: result.succeeded,
          failed: result.failed,
          results: result.results.map((r) => ({
            taskId: r.taskId,
            success: r.success,
            error: r.error,
          })),
        }),
      );
      break;
    }
    case "review": {
      if (!cli.taskId || cli.taskId.trim().length === 0) {
        throw new Error("review requires --taskId");
      }

      const result = await controller.reviewPR(cli.taskId);
      console.log(
        JSON.stringify({
          ok: true,
          command,
          taskId: cli.taskId,
          approved: result.approved,
          errorCount: result.errorCount,
          warningCount: result.warningCount,
          suggestionCount: result.suggestionCount,
        }),
      );
      break;
    }
    case "review-loop": {
      if (!cli.taskId || cli.taskId.trim().length === 0) {
        throw new Error("review-loop requires --taskId");
      }

      const maxRounds = parsePositiveInteger(cli.maxIterations, "maxIterations") ?? 3;
      const result = await controller.runReviewLoop(cli.taskId, maxRounds);
      console.log(JSON.stringify({ ok: true, command, ...result }));
      break;
    }
    case "quality": {
      if (!cli.taskId || cli.taskId.trim().length === 0) {
        throw new Error("quality requires --taskId");
      }

      const result = await controller.getQualityScore(cli.taskId);
      console.log(JSON.stringify({ ok: true, command, ...result }));
      break;
    }
    case "lint": {
      if (!cli.taskId || cli.taskId.trim().length === 0) {
        throw new Error("lint requires --taskId");
      }

      const result = await controller.runLinter(cli.taskId);
      console.log(
        JSON.stringify({
          ok: true,
          command,
          taskId: cli.taskId,
          passed: result.passed,
          errorCount: result.errorCount,
          warningCount: result.warningCount,
        }),
      );
      break;
    }
    case "arch-validate": {
      if (!cli.taskId || cli.taskId.trim().length === 0) {
        throw new Error("arch-validate requires --taskId");
      }

      const result = await controller.validateArchitecture(cli.taskId);
      console.log(
        JSON.stringify({
          ok: true,
          command,
          taskId: cli.taskId,
          passed: result.passed,
          violationCount: result.violations.length,
        }),
      );
      break;
    }
    case "doc-validate": {
      if (!cli.taskId || cli.taskId.trim().length === 0) {
        throw new Error("doc-validate requires --taskId");
      }

      const result = await controller.validateDocs(cli.taskId);
      console.log(
        JSON.stringify({
          ok: true,
          command,
          taskId: cli.taskId,
          passed: result.passed,
          issueCount: result.issues.length,
        }),
      );
      break;
    }
    case "reproduce-bug": {
      if (!cli.taskId || cli.taskId.trim().length === 0) {
        throw new Error("reproduce-bug requires --taskId");
      }
      if (!cli.prompt || cli.prompt.trim().length === 0) {
        throw new Error("reproduce-bug requires --prompt (bug description)");
      }

      const result = await controller.reproduceBug(cli.taskId, cli.prompt);
      console.log(
        JSON.stringify({
          ok: true,
          command,
          taskId: cli.taskId,
          reproduced: result.reproduced,
          testFile: result.testFile,
        }),
      );
      break;
    }
    case "gc-sweep": {
      const result = await controller.runGCSweep();
      console.log(JSON.stringify({ ok: true, command, ...result }));
      break;
    }
    default:
      throw new Error(`Unsupported command: ${command}. Use one of: serve, start, continue, verify, fix, pr, mutate, eval, garden, parallel, review, review-loop, quality, lint, arch-validate, doc-validate, reproduce-bug, gc-sweep`);
  }

  await shutdown();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
