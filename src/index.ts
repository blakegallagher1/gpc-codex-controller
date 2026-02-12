import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { AppServerClient } from "./appServerClient.js";
import { Controller } from "./controller.js";

interface CliOptions {
  workspace: string;
  stateFile?: string;
  serverCommand: string;
  serverArgs: string;
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
    throw new Error("Missing command. Use one of: start, continue, verify, fix, pr");
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
    default:
      throw new Error(`Unsupported command: ${command}. Use one of: start, continue, verify, fix, pr`);
  }

  await shutdown();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
