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
  const { values } = parseArgs({
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
    },
  });

  const cli = values as unknown as CliOptions;
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

  const { threadId } = await controller.bootstrap();
  console.log(`Controller ready. threadId=${threadId}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
