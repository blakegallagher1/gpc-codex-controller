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

variable "region" {
  type        = string
  description = "Render region for the service."
  default     = "oregon"
}

variable "github_token" {
  type        = string
  sensitive   = true
  description = "GitHub token exposed to Render service runtime."
  default     = ""
}
