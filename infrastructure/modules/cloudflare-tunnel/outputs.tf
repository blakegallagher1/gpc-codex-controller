output "tunnel_id" {
  value       = cloudflare_zero_trust_tunnel_cloudflared.this.id
  description = "Cloudflare tunnel identifier."
}

output "tunnel_token" {
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.this.token
  description = "cloudflared run token for the tunnel."
  sensitive   = true
}

output "hostname" {
  value       = var.hostname
  description = "Public tunnel hostname."
}
