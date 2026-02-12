output "controller_endpoint" {
  description = "Public HTTPS endpoint for the controller via Cloudflare Tunnel."
  value       = "https://${var.subdomain}.${var.domain}"
}

output "tunnel_id" {
  description = "Cloudflare tunnel ID."
  value       = module.cloudflare_tunnel.tunnel_id
}

output "vm_ipv4" {
  description = "Public IPv4 of provisioned VPS."
  value       = module.hetzner_vm.ipv4_address
}

output "ssh_command" {
  description = "SSH command for accessing the VM."
  value       = "ssh ${var.controller_user}@${module.hetzner_vm.ipv4_address}"
}

output "workspace_mount_point" {
  description = "Persistent workspace mount path on VM."
  value       = var.workspace_mount_point
}

output "cloudflared_tunnel_token" {
  description = "cloudflared tunnel token used on the VM."
  value       = module.cloudflare_tunnel.tunnel_token
  sensitive   = true
}

output "access_service_token_client_id" {
  description = "Access service token Client ID — pass as CF-Access-Client-Id header."
  value       = module.cloudflare_tunnel.access_service_token_client_id
}

output "access_service_token_client_secret" {
  description = "Access service token Client Secret — pass as CF-Access-Client-Secret header."
  value       = module.cloudflare_tunnel.access_service_token_client_secret
  sensitive   = true
}
