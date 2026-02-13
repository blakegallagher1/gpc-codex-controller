#!/usr/bin/env bash

set -euo pipefail

log() {
  echo "[import-existing] $*"
}

log_request() {
  local endpoint="$1"
  log "requesting ${endpoint}" >&2
}

require_env_var() {
  local name="$1"
  local value="${!name-}"
  if [[ -z "${value}" ]]; then
    echo "::error::Required environment variable ${name} is not set."
    exit 1
  fi
}

request_json() {
  local url="$1"
  local token="$2"

  local request_url="${url}"
  log_request "${request_url}"
  curl -fsS --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer ${token}" \
    "${url}"
}

tfvar_raw() {
  local key="$1"
  local file="${2:-terraform.tfvars}"
  if [[ ! -f "${file}" ]]; then
    return 1
  fi

  local line
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "${file}" | head -n 1 || true)"
  if [[ -z "${line}" ]]; then
    return 1
  fi

  local value
  value="$(echo "${line#*=}" | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//')"
  echo "${value}"
}

tfvar_string() {
  local key="$1"
  local default="$2"
  local raw

  raw="$(tfvar_raw "${key}" "terraform.tfvars" || true)"
  if [[ -z "${raw}" ]]; then
    echo "${default}"
    return 0
  fi

  if [[ "${raw}" == \"*\" && "${raw}" == *\" ]]; then
    raw="${raw%\"}"
    raw="${raw#\"}"
  fi

  if [[ "${raw}" == "null" ]]; then
    echo "${default}"
    return 0
  fi

  echo "${raw}"
}

tfvar_bool() {
  local key="$1"
  local default="$2"
  local raw

  raw="$(tfvar_raw "${key}" "terraform.tfvars" || true)"
  if [[ -z "${raw}" || "${raw}" == "null" ]]; then
    echo "${default}"
    return 0
  fi
  echo "${raw}"
}

tfvar_list_length() {
  local key="$1"
  local default="${2:-0}"
  local raw

  raw="$(tfvar_raw "${key}" "terraform.tfvars" || true)"
  if [[ -z "${raw}" || "${raw}" == "null" ]]; then
    echo "${default}"
    return 0
  fi

  local length
  length="$(jq -r 'if type=="array" then length else 0 end' <<< "${raw}" 2>/dev/null || echo "0")"
  echo "${length}"
}

state_has() {
  timeout 30 terraform state list "$1" >/dev/null 2>&1
}

import_if_needed() {
  local address="$1"
  local id="$2"

  if state_has "$address"; then
    log "state already tracks ${address}"
    return 0
  fi

  if [[ -z "${id}" ]]; then
    log "no import id available for ${address}; skipping"
    return 0
  fi

  log "importing ${address} as ${id}"
  timeout 120 terraform import "${address}" "${id}"
}

if [[ "${GITHUB_EVENT_NAME}" != "workflow_dispatch" || "${TERRAFORM_APPLY}" != "true" ]]; then
  log "Skipping resource import for non-manual apply workflow."
  exit 0
fi

CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-${TF_VAR_cloudflare_account_id:-}}"
CLOUDFLARE_ZONE_ID="${CLOUDFLARE_ZONE_ID:-${TF_VAR_cloudflare_zone_id:-}}"
require_env_var CLOUDFLARE_ACCOUNT_ID
require_env_var CLOUDFLARE_ZONE_ID
require_env_var CLOUDFLARE_API_TOKEN
require_env_var HCLOUD_TOKEN

PROJECT_NAME="$(tfvar_string "project_name" "gpc-codex-controller")"
ENVIRONMENT="$(tfvar_string "environment" "prod")"
SUBDOMAIN="$(tfvar_string "subdomain" "codex-controller")"
DOMAIN="${TF_VAR_domain:-$(tfvar_string "domain" "")}"
SSH_PUBLIC_KEY="$(tfvar_string "ssh_public_key" "")"
ACCESS_SERVICE_TOKEN_NAME="$(tfvar_string "access_service_token_name" "gpc-codex-controller-api")"
ENABLE_ACCESS="$(tfvar_bool "enable_access" "true")"
ACCESS_ALLOWED_EMAILS="$(tfvar_list_length "access_allowed_emails" "0")"

TUNNEL_NAME="${PROJECT_NAME}-${ENVIRONMENT}-tunnel"
SERVER_NAME="${PROJECT_NAME}-${ENVIRONMENT}-vm"
FIREWALL_NAME="${SERVER_NAME}-fw"
VOLUME_NAME="${PROJECT_NAME}-${ENVIRONMENT}-workspaces"
SSH_KEY_NAME="${SERVER_NAME}-ssh"
DNS_RECORD_NAME="${SUBDOMAIN}"
DNS_RECORD_FQDN="${SUBDOMAIN}.${DOMAIN}"
ACCESS_APP_NAME="${TUNNEL_NAME}-access-app"
MCP_APP_NAME="${TUNNEL_NAME}-mcp-access"
MCP_BYPASS_POLICY_NAME="${TUNNEL_NAME}-mcp-bypass"
SERVICE_TOKEN_POLICY_NAME="${TUNNEL_NAME}-service-token-policy"
EMAIL_POLICY_NAME="${TUNNEL_NAME}-email-allow-policy"

CF_ACCOUNT_PATH="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"
CF_TUNNEL_LIST=$(request_json "${CF_ACCOUNT_PATH}/cfd_tunnel" "${CLOUDFLARE_API_TOKEN}")
CF_TUNNEL_ID=$(jq -r --arg NAME "${TUNNEL_NAME}" '(.result // []) | map(select(.name == $NAME)) | first | .id // empty' <<<"${CF_TUNNEL_LIST}")
CF_TUNNEL_CONFIG_ID="${CF_TUNNEL_ID}"

CF_APPS_LIST=$(request_json "${CF_ACCOUNT_PATH}/access/apps" "${CLOUDFLARE_API_TOKEN}")
CF_ACCESS_APP_ID=$(jq -r --arg NAME "${ACCESS_APP_NAME}" '(.result // []) | map(select(.name == $NAME)) | first | .id // empty' <<<"${CF_APPS_LIST}")
CF_MCP_APP_ID=$(jq -r --arg NAME "${MCP_APP_NAME}" '(.result // []) | map(select(.name == $NAME)) | first | .id // empty' <<<"${CF_APPS_LIST}")

CF_SERVICE_TOKEN_LIST=$(request_json "${CF_ACCOUNT_PATH}/access/service_tokens" "${CLOUDFLARE_API_TOKEN}")
CF_SERVICE_TOKEN_ID=$(jq -r --arg NAME "${ACCESS_SERVICE_TOKEN_NAME}" '(.result // []) | map(select(.name == $NAME)) | sort_by(.created_at) | reverse | first | .id // empty' <<<"${CF_SERVICE_TOKEN_LIST}")

CF_EMAIL_POLICY_ID=""
CF_SERVICE_TOKEN_POLICY_ID=""
if [[ "${ENABLE_ACCESS}" == "true" && -n "${CF_ACCESS_APP_ID}" ]]; then
  APP_POLICIES_LIST=$(request_json "${CF_ACCOUNT_PATH}/access/apps/${CF_ACCESS_APP_ID}/policies" "${CLOUDFLARE_API_TOKEN}")
  CF_SERVICE_TOKEN_POLICY_ID=$(jq -r --arg NAME "${SERVICE_TOKEN_POLICY_NAME}" '(.result // []) | map(select(.name == $NAME)) | first | .id // empty' <<<"${APP_POLICIES_LIST}")
  if [[ "${ACCESS_ALLOWED_EMAILS}" -gt 0 ]]; then
    CF_EMAIL_POLICY_ID=$(jq -r --arg NAME "${EMAIL_POLICY_NAME}" '(.result // []) | map(select(.name == $NAME)) | first | .id // empty' <<<"${APP_POLICIES_LIST}")
  fi
fi

if [[ "${ENABLE_ACCESS}" == "true" && -n "${CF_MCP_APP_ID}" ]]; then
  MCP_POLICIES_LIST=$(request_json "${CF_ACCOUNT_PATH}/access/apps/${CF_MCP_APP_ID}/policies" "${CLOUDFLARE_API_TOKEN}")
  CF_MCP_BYPASS_POLICY_ID=$(jq -r --arg NAME "${MCP_BYPASS_POLICY_NAME}" '(.result // []) | map(select(.name == $NAME)) | first | .id // empty' <<<"${MCP_POLICIES_LIST}")
else
  CF_MCP_BYPASS_POLICY_ID=""
fi

if ! CF_DNS_RECORD_LIST="$(request_json "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${DNS_RECORD_FQDN}" "${CLOUDFLARE_API_TOKEN}")"; then
  log "warning: failed to query DNS records; skipping DNS import"
  CF_DNS_RECORD_LIST='{"result":[]}'
  CLOUDFLARE_DNS_MANAGED="false"
else
  CLOUDFLARE_DNS_MANAGED="true"
fi
CF_DNS_RECORD_ID=$(jq -r --arg NAME "${DNS_RECORD_NAME}" '(.result // []) | map(select(.name == $NAME or .name == ($NAME + "."))) | first | .id // empty' <<<"${CF_DNS_RECORD_LIST}")
if [[ -n "${CF_DNS_RECORD_ID}" ]]; then
  CF_DNS_IMPORT_ID="${CLOUDFLARE_ZONE_ID}/${CF_DNS_RECORD_ID}"
else
  CF_DNS_IMPORT_ID=""
fi
if [[ "${CLOUDFLARE_DNS_MANAGED}" == "true" ]]; then
  rm -f ./.terraform.auto.tfvars
else
  cat <<'EOF' > ./.terraform.auto.tfvars
cloudflare_manage_dns_record = false
EOF
fi

H_TOKEN="${HCLOUD_TOKEN}"
HCLOUD_API_HEADERS="Authorization: Bearer ${H_TOKEN}"
HCLOUD_API_BASE="https://api.hetzner.cloud/v1"

HCLOUD_SERVERS="$(timeout 30 curl -fsS --connect-timeout 10 --max-time 30 -H "${HCLOUD_API_HEADERS}" "${HCLOUD_API_BASE}/servers")"
HCLOUD_SERVER_ID=$(jq -r --arg NAME "${SERVER_NAME}" '(.servers // []) | map(select(.name == $NAME)) | first | .id // empty' <<<"${HCLOUD_SERVERS}")

HCLOUD_FIREWALLS="$(timeout 30 curl -fsS --connect-timeout 10 --max-time 30 -H "${HCLOUD_API_HEADERS}" "${HCLOUD_API_BASE}/firewalls")"
HCLOUD_FIREWALL_ID=$(jq -r --arg NAME "${FIREWALL_NAME}" '(.firewalls // []) | map(select(.name == $NAME)) | first | .id // empty' <<<"${HCLOUD_FIREWALLS}")

HCLOUD_VOLUMES="$(timeout 30 curl -fsS --connect-timeout 10 --max-time 30 -H "${HCLOUD_API_HEADERS}" "${HCLOUD_API_BASE}/volumes")"
HCLOUD_VOLUME_ID=$(jq -r --arg NAME "${VOLUME_NAME}" '(.volumes // []) | map(select(.name == $NAME)) | first | .id // empty' <<<"${HCLOUD_VOLUMES}")

if [[ -n "${SSH_PUBLIC_KEY}" ]]; then
  HCLOUD_KEYS="$(timeout 30 curl -fsS --connect-timeout 10 --max-time 30 -H "${HCLOUD_API_HEADERS}" "${HCLOUD_API_BASE}/ssh_keys")"
  HCLOUD_SSH_KEY_ID=$(jq -r --arg NAME "${SSH_KEY_NAME}" '(.ssh_keys // []) | map(select(.name == $NAME)) | first | .id // empty' <<<"${HCLOUD_KEYS}")
else
  HCLOUD_SSH_KEY_ID=""
fi

import_if_needed "module.cloudflare_tunnel.cloudflare_zero_trust_tunnel_cloudflared.this" "${CLOUDFLARE_ACCOUNT_ID}/${CF_TUNNEL_ID}"
import_if_needed "module.cloudflare_tunnel.cloudflare_zero_trust_tunnel_cloudflared_config.this" "${CLOUDFLARE_ACCOUNT_ID}/${CF_TUNNEL_CONFIG_ID}"
import_if_needed "module.hetzner_vm.hcloud_server.this" "${HCLOUD_SERVER_ID}"
import_if_needed "module.hetzner_vm.hcloud_firewall.this" "${HCLOUD_FIREWALL_ID}"
import_if_needed "module.hetzner_vm.hcloud_volume.workspaces" "${HCLOUD_VOLUME_ID}"
import_if_needed "module.cloudflare_tunnel.cloudflare_dns_record.this" "${CF_DNS_IMPORT_ID}"

if [[ "${ENABLE_ACCESS}" == "true" ]]; then
  import_if_needed "module.cloudflare_tunnel.cloudflare_zero_trust_access_service_token.this[0]" "accounts/${CLOUDFLARE_ACCOUNT_ID}/${CF_SERVICE_TOKEN_ID}"
  import_if_needed "module.cloudflare_tunnel.cloudflare_zero_trust_access_policy.service_token[0]" "${CLOUDFLARE_ACCOUNT_ID}/${CF_SERVICE_TOKEN_POLICY_ID}"
  import_if_needed "module.cloudflare_tunnel.cloudflare_zero_trust_access_application.this[0]" "accounts/${CLOUDFLARE_ACCOUNT_ID}/${CF_ACCESS_APP_ID}"
  import_if_needed "module.cloudflare_tunnel.cloudflare_zero_trust_access_policy.mcp_bypass[0]" "${CLOUDFLARE_ACCOUNT_ID}/${CF_MCP_BYPASS_POLICY_ID}"
  import_if_needed "module.cloudflare_tunnel.cloudflare_zero_trust_access_application.mcp[0]" "accounts/${CLOUDFLARE_ACCOUNT_ID}/${CF_MCP_APP_ID}"
  if [[ "${ACCESS_ALLOWED_EMAILS}" -gt 0 ]]; then
    import_if_needed "module.cloudflare_tunnel.cloudflare_zero_trust_access_policy.email_allow[0]" "${CLOUDFLARE_ACCOUNT_ID}/${CF_EMAIL_POLICY_ID}"
  fi
fi

if [[ -n "${SSH_PUBLIC_KEY}" ]]; then
  import_if_needed "module.hetzner_vm.hcloud_ssh_key.this[0]" "${HCLOUD_SSH_KEY_ID}"
fi

log "Resource import preflight completed."
