/**
 * CDP (Chrome DevTools Protocol) Bridge — real implementation using
 * Node.js native WebSocket (available in Node 22+).
 *
 * Connects to a headless Chrome instance via CDP WebSocket and enables:
 * - Capturing screenshots of running app instances
 * - Reading console errors
 * - Navigating to URLs
 * - Extracting DOM snapshots
 */

export interface CDPStatus {
  available: boolean;
  reason: string;
  wsUrl: string | null;
}

export interface CDPScreenshot {
  available: boolean;
  dataUrl: string | null;
  error: string | null;
}

export interface CDPConsoleErrors {
  available: boolean;
  errors: string[];
}

export interface CDPNavigateResult {
  url: string;
  success: boolean;
  error: string | null;
}

export interface CDPDomSnapshot {
  available: boolean;
  title: string | null;
  bodyText: string | null;
  error: string | null;
}

interface CDPMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export class CDPBridge {
  private wsUrl: string | null = null;
  private ws: WebSocket | null = null;
  private connected = false;
  private messageId = 0;
  private pendingRequests = new Map<number, {
    resolve: (result: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  private consoleErrors: string[] = [];
  private maxConsoleErrors = 200;

  public getStatus(): CDPStatus {
    return {
      available: this.connected,
      reason: this.connected
        ? "Connected to Chrome DevTools"
        : this.wsUrl
          ? "WebSocket URL set but not connected — call connect()"
          : "No Chrome instance configured — call connect(wsUrl)",
      wsUrl: this.wsUrl,
    };
  }

  public async connect(wsUrl: string): Promise<CDPStatus> {
    this.wsUrl = wsUrl;

    try {
      await this.establishConnection(wsUrl);
      // Enable required CDP domains
      await this.sendCommand("Runtime.enable");
      await this.sendCommand("Page.enable");
      this.connected = true;

      return {
        available: true,
        reason: "Connected to Chrome DevTools",
        wsUrl,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.connected = false;
      return {
        available: false,
        reason: `CDP connection failed: ${message}`,
        wsUrl,
      };
    }
  }

  public async disconnect(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
    }
    this.ws = null;
    this.wsUrl = null;
    this.connected = false;
    this.consoleErrors = [];
    this.pendingRequests.clear();
  }

  public async captureScreenshot(): Promise<CDPScreenshot> {
    if (!this.connected || !this.ws) {
      return {
        available: false,
        dataUrl: null,
        error: "CDP not connected. Call connect(wsUrl) first.",
      };
    }

    try {
      const result = await this.sendCommand("Page.captureScreenshot", {
        format: "png",
        quality: 80,
      });

      const data = result.data as string | undefined;
      if (!data) {
        return { available: false, dataUrl: null, error: "No screenshot data returned" };
      }

      return {
        available: true,
        dataUrl: `data:image/png;base64,${data}`,
        error: null,
      };
    } catch (error) {
      return {
        available: false,
        dataUrl: null,
        error: `Screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  public async getConsoleErrors(): Promise<CDPConsoleErrors> {
    if (!this.connected) {
      return { available: false, errors: [] };
    }

    return {
      available: true,
      errors: [...this.consoleErrors],
    };
  }

  public async navigate(url: string): Promise<CDPNavigateResult> {
    if (!this.connected || !this.ws) {
      return { url, success: false, error: "CDP not connected" };
    }

    try {
      const result = await this.sendCommand("Page.navigate", { url });
      const errorText = result.errorText as string | undefined;
      if (errorText) {
        return { url, success: false, error: errorText };
      }
      // Wait briefly for page load
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return { url, success: true, error: null };
    } catch (error) {
      return {
        url,
        success: false,
        error: `Navigation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  public async getDomSnapshot(): Promise<CDPDomSnapshot> {
    if (!this.connected || !this.ws) {
      return { available: false, title: null, bodyText: null, error: "CDP not connected" };
    }

    try {
      // Get document title
      const titleResult = await this.sendCommand("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      });
      const title = (titleResult.result as Record<string, unknown> | undefined)?.value as string | undefined;

      // Get body text content (truncated to prevent huge payloads)
      const bodyResult = await this.sendCommand("Runtime.evaluate", {
        expression: "document.body ? document.body.innerText.slice(0, 10000) : ''",
        returnByValue: true,
      });
      const bodyText = (bodyResult.result as Record<string, unknown> | undefined)?.value as string | undefined;

      return {
        available: true,
        title: title ?? null,
        bodyText: bodyText ?? null,
        error: null,
      };
    } catch (error) {
      return {
        available: false,
        title: null,
        bodyText: null,
        error: `DOM snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  public clearConsoleErrors(): void {
    this.consoleErrors = [];
  }

  private establishConnection(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("CDP WebSocket connection timed out (10s)"));
      }, 10_000);

      try {
        const ws = new WebSocket(wsUrl);

        ws.addEventListener("open", () => {
          clearTimeout(timeout);
          this.ws = ws;
          resolve();
        });

        ws.addEventListener("error", (event: Event) => {
          clearTimeout(timeout);
          const detail = (event as unknown as { message?: string }).message ?? "unknown error";
          reject(new Error(`CDP WebSocket error: ${detail}`));
        });

        ws.addEventListener("close", () => {
          this.connected = false;
          this.ws = null;
        });

        ws.addEventListener("message", (event: MessageEvent) => {
          this.handleMessage(String(event.data));
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  private handleMessage(data: string): void {
    let msg: CDPMessage;
    try {
      msg = JSON.parse(data) as CDPMessage;
    } catch {
      return;
    }

    // Handle responses to our commands
    if (typeof msg.id === "number") {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result ?? {});
        }
      }
      return;
    }

    // Handle console events
    if (msg.method === "Runtime.consoleAPICalled") {
      const params = msg.params ?? {};
      const type = params.type as string | undefined;
      if (type === "error" || type === "warning") {
        const args = (params.args ?? []) as Array<{ value?: string; description?: string }>;
        const text = args.map((a) => a.value ?? a.description ?? "").join(" ");
        if (text.length > 0) {
          this.consoleErrors.push(`[${type}] ${text}`);
          if (this.consoleErrors.length > this.maxConsoleErrors) {
            this.consoleErrors = this.consoleErrors.slice(-this.maxConsoleErrors);
          }
        }
      }
    }

    // Handle JavaScript exceptions
    if (msg.method === "Runtime.exceptionThrown") {
      const params = msg.params ?? {};
      const detail = params.exceptionDetails as Record<string, unknown> | undefined;
      const text = (detail?.text as string) ?? "Unknown exception";
      this.consoleErrors.push(`[exception] ${text}`);
      if (this.consoleErrors.length > this.maxConsoleErrors) {
        this.consoleErrors = this.consoleErrors.slice(-this.maxConsoleErrors);
      }
    }
  }

  private sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket not connected"));
        return;
      }

      const id = ++this.messageId;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`CDP command '${method}' timed out (30s)`));
      }, 30_000);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      const message = JSON.stringify({ id, method, params: params ?? {} });
      this.ws.send(message);
    });
  }
}
