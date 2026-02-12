variable "project_name" {
  description = "Project name prefix for created resources."
  type        = string
  default     = "gpc-codex-controller"
}

variable "environment" {
  description = "Environment label used in naming and tags."
  type        = string
  default     = "prod"
}

variable "hcloud_token" {
  description = "Hetzner Cloud API token (or export HCLOUD_TOKEN)."
  type        = string
  sensitive   = true
  default     = null
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token (or export CLOUDFLARE_API_TOKEN)."
  type        = string
  sensitive   = true
  default     = null
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID for Zero Trust Tunnel resources."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare DNS Zone ID for endpoint DNS record."
  type        = string
}

variable "domain" {
  description = "Base domain managed in Cloudflare (example.com)."
  type        = string
}

variable "subdomain" {
  description = "Subdomain to expose the controller endpoint."
  type        = string
  default     = "codex-controller"
}

variable "location" {
  description = "Hetzner datacenter location."
  type        = string
  default     = "ash"
}

variable "server_type" {
  description = "Hetzner server type (2 vCPU / 4GB: cpx11)."
  type        = string
  default     = "cpx11"
}

variable "image" {
  description = "Hetzner server image."
  type        = string
  default     = "ubuntu-24.04"
}

variable "controller_user" {
  description = "Linux user used to run controller and hold persistent auth state."
  type        = string
  default     = "controller"
}

variable "ssh_public_key" {
  description = "Optional SSH public key content for VM access."
  type        = string
  default     = ""
}

variable "ssh_allowed_cidrs" {
  description = "CIDRs allowed to SSH to the VPS."
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

variable "volume_size_gb" {
  description = "Attached volume size in GB for persistent workspaces."
  type        = number
  default     = 200
}

variable "workspace_mount_point" {
  description = "Path where workspace volume is mounted."
  type        = string
  default     = "/workspaces"
}

variable "controller_repo_url" {
  description = "Repository URL for gpc-codex-controller."
  type        = string
  default     = "https://github.com/blakegallagher1/gpc-codex-controller"
}

variable "controller_repo_branch" {
  description = "Repository branch to deploy."
  type        = string
  default     = "main"
}

variable "controller_port" {
  description = "Local controller service port used by Cloudflare Tunnel origin."
  type        = number
  default     = 8787
}

variable "controller_start_command" {
  description = "Command executed by the systemd controller service."
  type        = string
  default     = "npm start"
}

variable "codex_home" {
  description = "Persistent CODEX_HOME directory path on server."
  type        = string
  default     = "/home/controller/.codex"
}

variable "github_token" {
  description = "GitHub token for PR automation."
  type        = string
  sensitive   = true
  default     = ""
}

variable "mcp_bearer_token" {
  description = "Optional bearer token required by origin service (recommended if Access disabled)."
  type        = string
  sensitive   = true
  default     = ""
}

variable "enable_render" {
  description = "Enable optional Render service provisioning."
  type        = bool
  default     = false
}

variable "render_api_key" {
  description = "Render API key (required only when enable_render=true)."
  type        = string
  sensitive   = true
  default     = null
}

variable "render_owner_id" {
  description = "Render owner ID (required only when enable_render=true)."
  type        = string
  default     = null
}

variable "render_service_name" {
  description = "Render service name when enabled."
  type        = string
  default     = "gpc-codex-controller"
}

variable "render_plan" {
  description = "Render plan slug when enabled."
  type        = string
  default     = "starter"
}
