# gpc-codex-controller Infrastructure

This directory provisions production infrastructure for `gpc-codex-controller` on Hetzner Cloud with Cloudflare Tunnel and optional Render service.

## Directory Layout

- `providers.tf`: Terraform + provider constraints and auth wiring
- `variables.tf`: all required and optional variables
- `main.tf`: module orchestration (Hetzner VM + Cloudflare Tunnel + optional Render)
- `outputs.tf`: endpoint and access outputs
- `terraform.tfvars.example`: copy to `terraform.tfvars` and fill values
- `modules/hetzner-vm`: server, firewall, volume, attachment
- `modules/cloudflare-tunnel`: tunnel, config, DNS
- `modules/render-service`: optional Render web service
- `cloud-init/controller-cloud-init.tftpl`: bootstrap script and machine configuration
- `cloud-init/systemd/*.tftpl`: systemd service templates
- `scripts/smoke-test.sh`: post-deploy checks
- `Makefile`: wrappers for init/plan/apply/destroy/smoke-test

## Required Values

Provide these values via `terraform.tfvars` or `TF_VAR_*` environment variables:

- `hcloud_token` (or `HCLOUD_TOKEN`)
- `cloudflare_api_token` (or `CLOUDFLARE_API_TOKEN`)
- `cloudflare_account_id`
- `cloudflare_zone_id`
- `domain`
- `subdomain`
- `github_token`

### Minimal API Token Scopes

Hetzner token:
- Read/Write for servers, volumes, firewalls, SSH keys

Cloudflare API token:
- Account: Cloudflare Tunnel Edit
- Zone: DNS Edit (specific zone)

GitHub token:
- Repo read/write as needed by `gpc-codex-controller` automation

## Configure Input File

```bash
cd infrastructure
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars and fill required values
```

## Deploy

```bash
cd infrastructure
make init
make plan
make apply
```

After apply, capture outputs:

```bash
terraform output controller_endpoint
terraform output ssh_command
```

## Initial ChatGPT Login (Persistent Auth)

`CODEX_HOME` is persisted at `/home/<controller_user>/.codex`.

1. SSH to the VM:
```bash
ssh <controller_user>@<vm-ip>
```
2. Run login and complete browser flow:
```bash
sudo -u <controller_user> CODEX_HOME=/home/<controller_user>/.codex codex login --chatgpt
```
3. Confirm auth files exist:
```bash
sudo -u <controller_user> ls -la /home/<controller_user>/.codex
```

## Controller Service Management

```bash
sudo systemctl status gpc-codex-controller
sudo systemctl status cloudflared
sudo journalctl -u gpc-codex-controller -f
sudo journalctl -u cloudflared -f
```

Controller source path:
- `/home/<controller_user>/gpc-codex-controller`

Persistent workspace path:
- `/workspaces`

## Endpoint Security

Security defaults:
- No direct public ingress to controller service port
- Cloudflare Tunnel is the only public ingress path
- Optional origin bearer enforcement using `mcp_bearer_token`

Recommended:
- Set a long random `mcp_bearer_token`
- Restrict `ssh_allowed_cidrs` to known IP ranges

## Smoke Test

Run from `infrastructure/` after `apply`:

```bash
make smoke-test
```

The script checks:
- endpoint DNS/TLS reachability
- remote systemd status (`gpc-codex-controller`, `cloudflared`)
- recent cloudflared logs

## MCP Validation Flow

1. Provision infrastructure with Terraform.
2. SSH into VM and complete ChatGPT login using persistent `CODEX_HOME`.
3. Verify local controller process is listening on configured port.
4. Validate public endpoint:
```bash
curl -I https://<subdomain>.<domain>
```
5. From ChatGPT client, configure MCP endpoint to `https://<subdomain>.<domain>` and test a basic task.
6. Trigger a test task and confirm workspace output under `/workspaces/<taskId>`.

## Optional Render Provisioning

To enable Render:

1. Set in `terraform.tfvars`:
```hcl
enable_render  = true
render_api_key = "..."
render_owner_id = "..."
```
2. Apply again:
```bash
make apply
```

Render resource outputs are available under module `render_service` when enabled.

## Destroy

```bash
cd infrastructure
make destroy
```
