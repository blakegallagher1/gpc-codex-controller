terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
    random = {
      source = "hashicorp/random"
    }
  }
}

resource "random_id" "tunnel_secret" {
  byte_length = 35
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "this" {
  account_id    = var.account_id
  name          = var.name
  tunnel_secret = random_id.tunnel_secret.b64_std
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id

  config = {
    ingress = [
      {
        hostname = var.hostname
        service  = "http://${var.origin_host}:${var.origin_port}"
        origin_request = {
          connect_timeout        = 30
          keep_alive_timeout     = 90
          keep_alive_connections = 100
          http_host_header       = var.hostname
          no_tls_verify          = true
        }
      },
      {
        service = "http_status:404"
      }
    ]
  }
}

# ---------------------------------------------------------------------------
# Zero Trust Access — protects the tunnel hostname at the Cloudflare edge
# ---------------------------------------------------------------------------

resource "cloudflare_zero_trust_access_service_token" "this" {
  count      = var.enable_access ? 1 : 0
  account_id = var.account_id
  name       = var.access_service_token_name
  duration   = "8760h"

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "service_token" {
  count      = var.enable_access ? 1 : 0
  account_id = var.account_id
  name       = "${var.name}-service-token-policy"
  decision   = "non_identity"

  include = [
    {
      any_valid_service_token = {}
    }
  ]
}

resource "cloudflare_zero_trust_access_policy" "email_allow" {
  count      = var.enable_access && length(var.access_allowed_emails) > 0 ? 1 : 0
  account_id = var.account_id
  name       = "${var.name}-email-allow-policy"
  decision   = "allow"

  include = [for email in var.access_allowed_emails : {
    email = {
      email = email
    }
  }]
}

resource "cloudflare_zero_trust_access_application" "this" {
  count      = var.enable_access ? 1 : 0
  account_id = var.account_id
  name       = "${var.name}-access-app"
  domain     = var.hostname
  type       = "self_hosted"

  session_duration = "24h"

  policies = concat(
    [{ id = cloudflare_zero_trust_access_policy.service_token[0].id }],
    length(cloudflare_zero_trust_access_policy.email_allow) > 0
      ? [{ id = cloudflare_zero_trust_access_policy.email_allow[0].id }]
      : []
  )
}

# ---------------------------------------------------------------------------
# DNS
# ---------------------------------------------------------------------------

resource "cloudflare_dns_record" "this" {
  zone_id = var.zone_id
  name    = var.dns_record_name
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}
