# Agents in gpc-codex-controller

This document describes the **agents** supported by this repository, their purpose, how they behave,
and how to extend or invoke them. An *agent* in this context is a Codex/App-Server thread that performs
a specific workflow on infrastructure or controller tasks.

---

## 📌 Overview

gpc-codex-controller uses a programmatic agent architecture to:

- provision infrastructure
- manage task workspaces
- run verification and corrective fix loops
- produce branches and pull requests
- interact with CI/CD and remote systems (e.g., cloud provider APIs, GitHub)

Agents typically run within a persistent Codex App Server thread with a defined set of instructions
and constraints.

---

## 🧠 Agent Types

### 1) **Infrastructure Provisioner Agent**

**Purpose:**
Automates provisioning of cloud infrastructure for the `gpc-codex-controller` service.

**Typical actions:**
- Generate Terraform configurations
- Apply infrastructure plans
- Create VPS instances (e.g., Hetzner Cloud)
- Configure networking and firewalls
- Persist auth state directories

**Invoked via:**
A controller API like `startTask()` with a prompt describing the target infrastructure environment.

**Input expectations:**
- Desired cloud provider
- VM sizing
- Target domain/subdomain for MCP endpoint
- API tokens (provider)

**Output expectations:**
- Terraform code and templates
- Deployment instructions
- Smoke-test results

---

### 2) **Cloudflare Tunnel Agent**

**Purpose:**
Automates the setup of Cloudflare Tunnel resources and DNS routing so that the
controller MCP endpoint is reachable securely from ChatGPT.

**Typical actions:**
- Write Cloudflare Terraform code
- Generate DNS entries
- Optionally configure Zero Trust Access policies

**Invoked via:**
A specialized infrastructure workflow prompt targeting Cloudflare.

---

### 3) **Controller Deployment Agent**

**Purpose:**
Deploys and configures the controller application on a provisioned machine
(e.g., Hetzner Cloud VM), including:

- Installing prerequisites (Node 22, pnpm)
- Installing `codex`
- Configuring systemd services
- Creating workspace directories

**Success criteria:**
- Controller service starts
- `codex app-server` is reachable
- ChatGPT auth tokens are persisted

---

### 4) **Mutation Loop Agent**

**Purpose:**
Performs end-to-end mutation workflows on the `gpc-cres` codebase, including:

- Cloning the target repo into a workspace
- Running `pnpm verify`
- Fixing failed verifications
- Committing staged changes
- Opening pull requests

**Constraints:**
- Only writing inside workspace paths
- Must follow defined project conventions and guardrails
- Must preserve repo structure

**Invoked via:**
Controller API like `fixUntilGreen()` or `startTask()` with a detailed mutation prompt.

---

### 5) **PR Automation Agent**

**Purpose:**
Given a workspace and branch context, this agent:

- Pushes the branch to origin
- Creates a pull request against `main`
- Provides PR URL as output

**Invoked via:**
Controller wrapper `createPullRequest()` or explicit task invocation.

---

## 🎯 Agent Conventions

### Naming

- Agents should be named clearly with a prefix matching their domain:
- `infra/*`
- `cloudflare/*`
- `controller/*`
- `mutation/*`
- `pr/*`

### Prompt Structure

All agent prompts must include:
- Task context
- Constraints/guardrails
- Expected labels for outputs
- Failure handling instructions

Example mutation intro (highly recommended):

```text
You are operating in mutation mode on a pnpm workspaces monorepo.
Follow strict guardrails:

1. Apply minimal changes.
2. Do not modify root configs unless necessary.
3. Always run `pnpm verify` after edits.
4. Preserve workspace boundaries.
Now perform: <feature request>
```

### Error Handling

Agents should:
- Detect and report failures in verification
- Not make destructive changes outside expected files
- Fail fast on missing dependencies or credentials

---

## 🔐 Security & Auth

Some agents require credentials:

| Agent | Required Credentials |
|------|----------------------|
| Infrastructure Provisioner | Cloud API keys |
| Cloudflare Tunnel | Cloudflare API token + Zone ID |
| PR Automation | GitHub token |
| Mutation Loop | GitHub token for PRs |
| Controller Deployment | SSH keys for server |

Credentials should **never be hard-coded** and should always be supplied via:
- environment variables
- secret management systems

Examples:

```bash
export HCLOUD_TOKEN="..."
export CLOUDFLARE_API_TOKEN="..."
export GITHUB_TOKEN="..."
export CLOUDFLARE_ZONE_ID="..."
```

---

## 🧪 Testing Agents

You can test each agent independently using controller CLI or programmatic APIs:

Example:

```bash
controller runVerify --taskId test123
controller fixUntilGreen --taskId test123
```

---

## 📦 Extending Agents

To add an agent:

1. Define intent and scope
2. Draft the high-level prompt
3. Add a service wrapper method in the controller
4. Add tests for expected behavior
5. Document in this file
