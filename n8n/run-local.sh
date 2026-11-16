#!/usr/bin/env bash
# Starts a local n8n for the workflows in this folder: the n8n installed in
# tools/n8n, on its own embedded Postgres (.n8n-local/pg, port 25440, never the
# gateway's database), on 127.0.0.1 only, no telemetry. Postgres stops with n8n.
#
#   n8n/run-local.sh                 start n8n on http://127.0.0.1:5678
#   n8n/run-local.sh import:workflow --input=n8n/lead-form-to-gateway.json
#
# Same as: npm run n8n [-- <n8n command>]
set -euo pipefail
cd "$(dirname "$0")/.."
exec node src/cli/n8n-local.ts "$@"
