#!/usr/bin/env bash
# Review delivery-partner onboarding applications (the manual admin flow).
#
# Usage:
#   ./scripts/review-partner.sh list                 # applications awaiting review
#   ./scripts/review-partner.sh all                  # every partner + status
#   ./scripts/review-partner.sh show <dp_id>         # one partner + their documents
#   ./scripts/review-partner.sh approve <dp_id>
#   ./scripts/review-partner.sh reject  <dp_id> "reason shown to the partner"
#
# Reads ADMIN_API_KEY (and optional BASE_URL) from the environment or .env.
set -euo pipefail

# Load .env if present (for ADMIN_API_KEY) without clobbering existing env vars.
if [ -f "$(dirname "$0")/../.env" ]; then
  set -a; . "$(dirname "$0")/../.env"; set +a
fi

BASE="${BASE_URL:-http://localhost:8080}"
KEY="${ADMIN_API_KEY:?Set ADMIN_API_KEY in .env}"
H=(-H "x-admin-key: $KEY" -H "Content-Type: application/json")

case "${1:-list}" in
  list)    curl -s "${H[@]}" "$BASE/delivery/admin/partners?status=under_review" ;;
  all)     curl -s "${H[@]}" "$BASE/delivery/admin/partners" ;;
  show)    curl -s "${H[@]}" "$BASE/delivery/admin/partners/${2:?dp_id required}" ;;
  approve) curl -s -X PUT "${H[@]}" -d '{"status":"approved"}' \
             "$BASE/delivery/admin/partners/${2:?dp_id required}/verify" ;;
  reject)  curl -s -X PUT "${H[@]}" \
             -d "{\"status\":\"rejected\",\"reason\":\"${3:-Please re-check your documents}\"}" \
             "$BASE/delivery/admin/partners/${2:?dp_id required}/verify" ;;
  *) echo "usage: $0 {list|all|show <id>|approve <id>|reject <id> \"reason\"}"; exit 1 ;;
esac
echo
