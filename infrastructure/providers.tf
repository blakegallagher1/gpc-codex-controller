terraform {
  required_version = ">= 1.6.0, < 2.0.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.8.0, < 6.0.0"
    }
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = ">= 1.51.0, < 2.0.0"
    }
    local = {
      source  = "hashicorp/local"
      version = ">= 2.5.2, < 3.0.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.3, < 4.0.0"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
