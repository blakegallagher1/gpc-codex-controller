terraform {
  required_providers {
    render = {
      source  = "render-oss/render"
      version = ">= 1.7.0, < 2.0.0"
    }
  }
}

resource "render_web_service" "this" {
  name   = var.service_name
  plan   = var.plan
  region = var.region

  start_command = "npm start"

  runtime_source = {
    native_runtime = {
      repo_url      = var.repo_url
      branch        = var.repo_branch
      build_command = "npm ci && npm run build"
      runtime       = "node"
    }
  }

  env_vars = {
    "CODEX_HOME"   = { value = "/opt/render/project/.codex" }
    "GITHUB_TOKEN" = { value = var.github_token }
  }
}
