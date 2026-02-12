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

output "access_service_token_client_id" {
  value       = var.enable_access ? cloudflare_zero_trust_access_service_token.this[0].client_id : null
  description = "Access service token Client ID for automated API clients."
}

output "access_service_token_client_secret" {
  value       = var.enable_access ? cloudflare_zero_trust_access_service_token.this[0].client_secret : null
  description = "Access service token Client Secret for automated API clients."
  sensitive   = true
}
