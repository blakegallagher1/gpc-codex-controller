variable "server_name" {
  type        = string
  description = "Hetzner server name."
}

variable "location" {
  type        = string
  description = "Hetzner location."
}

variable "server_type" {
  type        = string
  description = "Hetzner server type (e.g., cpx11)."
}

variable "image" {
  type        = string
  description = "Hetzner image (e.g., ubuntu-24.04)."
}

variable "ssh_public_key" {
  type        = string
  description = "Optional SSH public key content."
  default     = ""
}

variable "ssh_allowed_cidrs" {
  type        = list(string)
  description = "CIDRs allowed inbound on SSH."
  default     = ["0.0.0.0/0", "::/0"]
}

variable "volume_name" {
  type        = string
  description = "Persistent volume name."
}

variable "volume_size_gb" {
  type        = number
  description = "Persistent volume size in GB."
}

variable "user_data" {
  type        = string
  description = "cloud-init user_data payload."
}
