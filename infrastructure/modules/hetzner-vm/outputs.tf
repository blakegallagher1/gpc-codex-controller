output "server_id" {
  value       = hcloud_server.this.id
  description = "Hetzner server ID."
}

output "ipv4_address" {
  value       = hcloud_server.this.ipv4_address
  description = "Public IPv4 address."
}

output "ipv6_address" {
  value       = hcloud_server.this.ipv6_address
  description = "Public IPv6 address."
}

output "volume_id" {
  value       = hcloud_volume.workspaces.id
  description = "Workspace volume ID."
}

output "volume_linux_device" {
  value       = "/dev/disk/by-id/scsi-0HC_Volume_${hcloud_volume.workspaces.name}"
  description = "Expected Linux block device path for the attached volume."
}
