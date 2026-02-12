import { readFile, rename, writeFile } from "node:fs/promises";
import type { DomainSecret, DomainSecretsConfig, SecretInjectionResult } from "./types.js";

/**
 * Domain secrets manager — credential injection without model exposure.
 *
 * Article tip #9:
 * "Use domain_secrets for authenticated calls. At runtime, the model sees
 *  placeholders (e.g. $API_KEY), and a sidecar injects the real values
 *  only for approved destinations."
 *
 * The model never sees raw credentials. It references placeholders in
 * prompts/skills, and this manager resolves them at execution time
 * by reading real values from environment variables.
 */

export class DomainSecretsManager {
  private readonly configPath: string;
  private config: DomainSecretsConfig | null = null;

  public constructor(configPath: string) {
    this.configPath = configPath;
  }

  /**
   * Register a domain secret mapping.
   * The model will see `placeholder`, and at runtime we inject the real value from `envVar`.
   */
  public async registerSecret(secret: DomainSecret): Promise<DomainSecretsConfig> {
    await this.loadConfig();

    // Validate: env var must exist (warn if not, but still register)
    const existing = this.config!.secrets.findIndex((s) => s.domain === secret.domain && s.placeholder === secret.placeholder);
    if (existing >= 0) {
      this.config!.secrets[existing] = secret;
    } else {
      this.config!.secrets.push(secret);
    }

    this.config!.updatedAt = new Date().toISOString();
    await this.saveConfig();
    return this.config!;
  }

  /**
   * Remove a domain secret mapping.
   */
  public async removeSecret(domain: string, placeholder: string): Promise<DomainSecretsConfig> {
    await this.loadConfig();
    this.config!.secrets = this.config!.secrets.filter(
      (s) => !(s.domain === domain && s.placeholder === placeholder),
    );
    this.config!.updatedAt = new Date().toISOString();
    await this.saveConfig();
    return this.config!;
  }

  /**
   * Get all registered secrets (with placeholders only, never real values).
   */
  public async getSecrets(): Promise<DomainSecret[]> {
    await this.loadConfig();
    return this.config!.secrets;
  }

  /**
   * Get secrets for a specific domain.
   */
  public async getSecretsForDomain(domain: string): Promise<DomainSecret[]> {
    await this.loadConfig();
    return this.config!.secrets.filter((s) => s.domain === domain);
  }

  /**
   * Inject real credential values for a domain.
   * This is the "sidecar" function — called at execution time, never exposed to the model.
   *
   * Returns headers with real values substituted for placeholders.
   */
  public async injectForDomain(domain: string): Promise<Record<string, string>> {
    await this.loadConfig();
    const secrets = this.config!.secrets.filter((s) => s.domain === domain);
    const headers: Record<string, string> = {};

    for (const secret of secrets) {
      const realValue = process.env[secret.envVar];
      if (realValue && realValue.trim().length > 0) {
        headers[secret.headerName] = realValue;
      }
    }

    return headers;
  }

  /**
   * Check which secrets can be injected (env vars present) vs missing.
   */
  public async validateSecrets(): Promise<SecretInjectionResult[]> {
    await this.loadConfig();
    const results: SecretInjectionResult[] = [];

    for (const secret of this.config!.secrets) {
      const realValue = process.env[secret.envVar];
      results.push({
        domain: secret.domain,
        injected: !!(realValue && realValue.trim().length > 0),
        headerName: secret.headerName,
        placeholder: secret.placeholder,
      });
    }

    return results;
  }

  /**
   * Build a model-safe description of available domain secrets.
   * The model sees placeholders, never real values.
   */
  public async buildModelContext(): Promise<string> {
    await this.loadConfig();

    if (this.config!.secrets.length === 0) {
      return "";
    }

    const lines = [
      "--- DOMAIN SECRETS (available for authenticated API calls) ---",
      "The following domains have credentials configured. Use the placeholder in your requests;",
      "real values are injected automatically at runtime. NEVER hardcode credentials.",
      "",
    ];

    const byDomain = new Map<string, DomainSecret[]>();
    for (const secret of this.config!.secrets) {
      const existing = byDomain.get(secret.domain) ?? [];
      existing.push(secret);
      byDomain.set(secret.domain, existing);
    }

    for (const [domain, secrets] of byDomain) {
      lines.push(`  ${domain}:`);
      for (const s of secrets) {
        lines.push(`    ${s.headerName}: ${s.placeholder}`);
      }
    }

    lines.push("--- END DOMAIN SECRETS ---");
    return lines.join("\n");
  }

  private async loadConfig(): Promise<void> {
    if (this.config) {
      return;
    }

    try {
      const raw = await readFile(this.configPath, "utf8");
      this.config = JSON.parse(raw) as DomainSecretsConfig;
    } catch {
      this.config = { secrets: [], updatedAt: new Date().toISOString() };
    }
  }

  private async saveConfig(): Promise<void> {
    const tmpPath = `${this.configPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.config, null, 2), "utf8");
    await rename(tmpPath, this.configPath);
  }
}
