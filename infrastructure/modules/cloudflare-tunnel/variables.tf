variable "name" {
  type        = string
  description = "Tunnel name."
}

variable "account_id" {
  type        = string
  description = "Cloudflare account ID."
}

variable "zone_id" {
  type        = string
  description = "Cloudflare zone ID."
}

variable "hostname" {
  type        = string
  description = "Public hostname for controller endpoint."
}

variable "dns_record_name" {
  type        = string
  description = "DNS record label under the target zone."
}

variable "origin_host" {
  type        = string
  description = "Origin host for tunnel ingress."
  default     = "127.0.0.1"
}

variable "origin_port" {
  type        = number
  description = "Origin service port for tunnel ingress."
}
