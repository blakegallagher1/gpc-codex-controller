locals {
  name_prefix       = "${var.project_name}-${var.environment}"
  endpoint_hostname = "${var.subdomain}.${var.domain}"
  volume_name       = "${local.name_prefix}-workspaces"

  controller_env = merge(
    {
      CODEX_HOME               = var.codex_home
      MCP_BIND                 = "127.0.0.1"
      MCP_PORT                 = tostring(var.controller_port)
      CONTROLLER_PORT          = tostring(var.controller_port)
      CONTROLLER_START_COMMAND = var.controller_start_command
      MCP_BEARER_TOKEN         = var.mcp_bearer_token
    },
    var.github_token != "" ? { GITHUB_TOKEN = var.github_token } : {}
  )

  controller_env_lines = join(
    "\n",
    [for key in sort(keys(local.controller_env)) : "${key}=${replace(local.controller_env[key], "\n", "")}" if local.controller_env[key] != ""]
  )

  controller_service_unit = templatefile("${path.module}/cloud-init/systemd/gpc-codex-controller.service.tftpl", {
    controller_user          = var.controller_user
    controller_port          = var.controller_port
    controller_start_command = var.controller_start_command
  })

  cloudflared_service_unit = templatefile("${path.module}/cloud-init/systemd/cloudflared.service.tftpl", {
    controller_user = var.controller_user
  })
}

module "cloudflare_tunnel" {
  source = "./modules/cloudflare-tunnel"

  name            = "${local.name_prefix}-tunnel"
  account_id      = var.cloudflare_account_id
  zone_id         = var.cloudflare_zone_id
  hostname        = local.endpoint_hostname
  dns_record_name = var.subdomain
  origin_host     = "127.0.0.1"
  origin_port     = var.controller_port
}

module "hetzner_vm" {
  source = "./modules/hetzner-vm"

  server_name       = "${local.name_prefix}-vm"
  location          = var.location
  server_type       = var.server_type
  image             = var.image
  ssh_public_key    = var.ssh_public_key
  ssh_allowed_cidrs = var.ssh_allowed_cidrs

  volume_name    = local.volume_name
  volume_size_gb = var.volume_size_gb

  user_data = templatefile("${path.module}/cloud-init/controller-cloud-init.tftpl", {
    controller_user          = var.controller_user
    codex_home               = var.codex_home
    controller_repo_url      = var.controller_repo_url
    controller_repo_branch   = var.controller_repo_branch
    workspace_mount_point    = var.workspace_mount_point
    volume_name              = local.volume_name
    controller_env_lines     = local.controller_env_lines
    controller_service_unit  = local.controller_service_unit
    cloudflared_service_unit = local.cloudflared_service_unit
    cloudflared_tunnel_token = module.cloudflare_tunnel.tunnel_token
    endpoint_hostname        = local.endpoint_hostname
  })
}

module "render_service" {
  count = var.enable_render ? 1 : 0

  source = "./modules/render-service"

  service_name = var.render_service_name
  repo_url     = var.controller_repo_url
  repo_branch  = var.controller_repo_branch
  plan         = var.render_plan
  region       = var.render_region
  github_token = var.github_token
}
