output "service_id" {
  value       = render_web_service.this.id
  description = "Render service ID."
}

output "service_url" {
  value       = render_web_service.this.url
  description = "Render service URL."
}
