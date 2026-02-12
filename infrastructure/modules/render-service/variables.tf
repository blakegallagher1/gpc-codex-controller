variable "api_key" {
  type        = string
  sensitive   = true
  description = "Render API key."
}

variable "owner_id" {
  type        = string
  description = "Render owner ID."
}

variable "service_name" {
  type        = string
  description = "Render service name."
}

variable "repo_url" {
  type        = string
  description = "Git repository URL."
}

variable "repo_branch" {
  type        = string
  description = "Git branch to deploy."
}

variable "plan" {
  type        = string
  description = "Render plan slug."
}

variable "github_token" {
  type        = string
  sensitive   = true
  description = "GitHub token exposed to Render service runtime."
  default     = ""
}
