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

variable "origin_bearer_token" {
  type        = string
  description = "Optional bearer token forwarded to origin in Authorization header."
  default     = ""
  sensitive   = true
}

variable "enable_access" {
  type        = bool
  description = "Enable Zero Trust Access application on the tunnel hostname."
  default     = false
}

variable "access_allowed_emails" {
  type        = list(string)
  description = "Email addresses allowed through Access (browser-based)."
  default     = []
}

variable "access_service_token_name" {
  type        = string
  description = "Name for the Access service token used by automated API clients."
  default     = "controller-api"
}

variable "manage_dns_record" {
  type        = bool
  description = "Whether Terraform should create/manage the CNAME DNS record."
  default     = true
}
