output "service_id" {
  value       = try(render_web_service.this.id, null)
  description = "Render service ID."
}

output "service_url" {
  value       = try(render_web_service.this.url, null)
  description = "Render service URL."
}
