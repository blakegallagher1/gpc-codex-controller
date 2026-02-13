terraform {
  required_providers {
    hcloud = {
      source = "hetznercloud/hcloud"
    }
  }
}

resource "hcloud_ssh_key" "this" {
  count      = trimspace(var.ssh_public_key) != "" ? 1 : 0
  name       = "${var.server_name}-ssh"
  public_key = trimspace(var.ssh_public_key)
}

resource "hcloud_firewall" "this" {
  name = "${var.server_name}-fw"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = var.ssh_allowed_cidrs
  }

  rule {
    direction       = "out"
    protocol        = "tcp"
    port            = "1-65535"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "udp"
    port            = "1-65535"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "icmp"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "this" {
  name        = var.server_name
  server_type = var.server_type
  image       = var.image
  location    = var.location
  user_data   = var.user_data

  ssh_keys = trimspace(var.ssh_public_key) != "" ? [hcloud_ssh_key.this[0].name] : []

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  lifecycle {
    ignore_changes = [
      firewall_ids
    ]
  }
}

resource "hcloud_firewall_attachment" "this" {
  firewall_id = hcloud_firewall.this.id
  server_ids  = [hcloud_server.this.id]
}

resource "hcloud_volume" "workspaces" {
  name     = var.volume_name
  size     = var.volume_size_gb
  location = var.location
  format   = "ext4"
}

resource "hcloud_volume_attachment" "workspaces" {
  volume_id = hcloud_volume.workspaces.id
  server_id = hcloud_server.this.id
  automount = false
}
