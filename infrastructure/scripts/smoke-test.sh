#!/usr/bin/env bash
set -euo pipefail

: "${TF_DIR:=.}"

endpoint="$(terraform -chdir="$TF_DIR" output -raw controller_endpoint 2>/dev/null || true)"
ssh_cmd="$(terraform -chdir="$TF_DIR" output -raw ssh_command 2>/dev/null || true)"

if [[ -z "$endpoint" ]]; then
  echo "ERROR: controller_endpoint output unavailable. Run terraform apply first." >&2
  exit 1
fi

if [[ -z "$ssh_cmd" ]]; then
  echo "ERROR: ssh_command output unavailable. Run terraform apply first." >&2
  exit 1
fi

echo "Checking endpoint DNS/TLS: $endpoint"
curl -fsSIL "$endpoint" >/dev/null

echo "Checking remote services via SSH"
$ssh_cmd "sudo systemctl is-active gpc-codex-controller"
$ssh_cmd "sudo systemctl is-active cloudflared"

echo "Checking cloudflared recent logs"
$ssh_cmd "sudo journalctl -u cloudflared -n 20 --no-pager"

echo "Smoke test passed"
