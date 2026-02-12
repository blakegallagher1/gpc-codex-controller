terraform {
  required_providers {
    render = {
      source  = "render-oss/render"
      version = ">= 1.7.0, < 2.0.0"
    }
  }
}

provider "render" {
  api_key  = var.api_key
  owner_id = var.owner_id
}

resource "render_web_service" "this" {
  count = var.enabled ? 1 : 0

  name = var.service_name
  plan = var.plan

  runtime_source = {
    repo_url  = var.repo_url
    branch    = var.repo_branch
    build_cmd = "npm ci && npm run build"
    start_cmd = "npm start"
  }

  env_vars = {
    CODEX_HOME   = "/opt/render/project/.codex"
    GITHUB_TOKEN = var.github_token
  }
}
