import { readFile, rename, writeFile } from "node:fs/promises";
import type {
  NetworkAllowlistEntry,
  NetworkPolicyValidation,
  OrgNetworkPolicy,
  RequestNetworkPolicy,
} from "./types.js";

/**
 * Two-layer network policy manager.
 *
 * Article tips #6, #8:
 * - Combining skills with open network access creates a high-risk path.
 * - Org-level allowlist = max allowed destinations (admin-set, stable).
 * - Request-level policy = subset of org allowlist (per-task, narrow).
 *
 * "Keep the org allowlist small and stable. Keep request allowlists even smaller."
 */

const DEFAULT_ORG_POLICY: OrgNetworkPolicy = {
  allowlist: [],
  defaultDeny: true,
  updatedAt: new Date().toISOString(),
};

export class NetworkPolicyManager {
  private readonly policyPath: string;
  private orgPolicy: OrgNetworkPolicy | null = null;

  public constructor(policyPath: string) {
    this.policyPath = policyPath;
  }

  /**
   * Get the current org-level network policy.
   */
  public async getOrgPolicy(): Promise<OrgNetworkPolicy> {
    await this.loadPolicy();
    return this.orgPolicy!;
  }

  /**
   * Set the org-level network allowlist.
   * This is the "approved destinations you trust" set — keep it small and stable.
   */
  public async setOrgPolicy(allowlist: NetworkAllowlistEntry[]): Promise<OrgNetworkPolicy> {
    await this.loadPolicy();
    this.orgPolicy!.allowlist = allowlist;
    this.orgPolicy!.updatedAt = new Date().toISOString();
    await this.savePolicy();
    return this.orgPolicy!;
  }

  /**
   * Add a domain to the org allowlist.
   */
  public async addOrgDomain(entry: NetworkAllowlistEntry): Promise<OrgNetworkPolicy> {
    await this.loadPolicy();

    const existing = this.orgPolicy!.allowlist.find((e) => e.domain === entry.domain);
    if (existing) {
      existing.ports = entry.ports;
      existing.reason = entry.reason;
    } else {
      this.orgPolicy!.allowlist.push(entry);
    }

    this.orgPolicy!.updatedAt = new Date().toISOString();
    await this.savePolicy();
    return this.orgPolicy!;
  }

  /**
   * Remove a domain from the org allowlist.
   */
  public async removeOrgDomain(domain: string): Promise<OrgNetworkPolicy> {
    await this.loadPolicy();
    this.orgPolicy!.allowlist = this.orgPolicy!.allowlist.filter((e) => e.domain !== domain);
    this.orgPolicy!.updatedAt = new Date().toISOString();
    await this.savePolicy();
    return this.orgPolicy!;
  }

  /**
   * Validate a request-level policy against the org-level policy.
   * Returns effective allowlist (intersection of org and request).
   *
   * "If a request includes domains outside the org allowlist, it will error."
   */
  public async validateRequestPolicy(requestPolicy: RequestNetworkPolicy): Promise<NetworkPolicyValidation> {
    await this.loadPolicy();
    const orgDomains = new Set(this.orgPolicy!.allowlist.map((e) => e.domain));
    const violations: string[] = [];
    const effectiveAllowlist: NetworkAllowlistEntry[] = [];

    for (const entry of requestPolicy.allowlist) {
      if (!orgDomains.has(entry.domain)) {
        violations.push(`Domain '${entry.domain}' not in org allowlist. Task: ${requestPolicy.taskId}`);
      } else {
        // Validate port constraints
        const orgEntry = this.orgPolicy!.allowlist.find((e) => e.domain === entry.domain)!;
        if (orgEntry.ports && entry.ports) {
          const orgPorts = new Set(orgEntry.ports);
          const badPorts = entry.ports.filter((p) => !orgPorts.has(p));
          if (badPorts.length > 0) {
            violations.push(
              `Ports [${badPorts.join(", ")}] for '${entry.domain}' not in org allowlist`,
            );
          } else {
            effectiveAllowlist.push(entry);
          }
        } else {
          effectiveAllowlist.push(entry);
        }
      }
    }

    // If inheritOrg, add all org entries not already present
    if (requestPolicy.inheritOrg) {
      for (const orgEntry of this.orgPolicy!.allowlist) {
        const alreadyIncluded = effectiveAllowlist.some((e) => e.domain === orgEntry.domain);
        if (!alreadyIncluded) {
          effectiveAllowlist.push(orgEntry);
        }
      }
    }

    return {
      valid: violations.length === 0,
      violations,
      effectiveAllowlist,
    };
  }

  /**
   * Build sandbox network access configuration for a turn.
   * Returns whether network access should be enabled and the effective allowlist.
   */
  public async buildTurnNetworkConfig(
    requestPolicy?: RequestNetworkPolicy,
  ): Promise<{ networkAccess: boolean; allowlist: NetworkAllowlistEntry[] }> {
    await this.loadPolicy();

    if (!requestPolicy) {
      // Default deny — no network access
      return { networkAccess: false, allowlist: [] };
    }

    const validation = await this.validateRequestPolicy(requestPolicy);

    if (!validation.valid) {
      // Reject: request includes domains outside org allowlist
      return { networkAccess: false, allowlist: [] };
    }

    return {
      networkAccess: validation.effectiveAllowlist.length > 0,
      allowlist: validation.effectiveAllowlist,
    };
  }

  private async loadPolicy(): Promise<void> {
    if (this.orgPolicy) {
      return;
    }

    try {
      const raw = await readFile(this.policyPath, "utf8");
      this.orgPolicy = JSON.parse(raw) as OrgNetworkPolicy;
    } catch {
      this.orgPolicy = { ...DEFAULT_ORG_POLICY };
    }
  }

  private async savePolicy(): Promise<void> {
    const tmpPath = `${this.policyPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.orgPolicy, null, 2), "utf8");
    await rename(tmpPath, this.policyPath);
  }
}
