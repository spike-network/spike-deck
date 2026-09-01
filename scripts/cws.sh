#!/bin/bash
# Chrome Web Store API v2: upload a zip and/or submit the draft for review.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

NAME="${NAME:-spikedeck}"
MANIFEST="${MANIFEST:-manifest.json}"
DIST="${DIST:-dist}"
VERSION="$(node -p "require('./${MANIFEST}').version")"
ZIP="${ZIP:-${DIST}/${NAME}-${VERSION}.zip}"

need() {
  local missing=()
  for key in CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN CWS_PUBLISHER_ID CWS_EXTENSION_ID; do
    if [[ -z "${!key:-}" ]]; then
      missing+=("$key")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    echo "Missing credentials: ${missing[*]}" >&2
    echo "Copy .env.example to .env and follow the comments, or export the variables." >&2
    echo "Docs: https://developer.chrome.com/docs/webstore/using-api" >&2
    exit 1
  fi
}

item_path() {
  echo "publishers/${CWS_PUBLISHER_ID}/items/${CWS_EXTENSION_ID}"
}

access_token() {
  local response
  response="$(curl -sS "https://oauth2.googleapis.com/token" \
    -d "client_id=${CWS_CLIENT_ID}" \
    -d "client_secret=${CWS_CLIENT_SECRET}" \
    -d "refresh_token=${CWS_REFRESH_TOKEN}" \
    -d "grant_type=refresh_token")"
  node -e '
    const raw = process.argv[1];
    const data = JSON.parse(raw);
    if (!data.access_token) {
      console.error(raw);
      process.exit(1);
    }
    process.stdout.write(data.access_token);
  ' "$response"
}

api() {
  local method="$1"
  local url="$2"
  shift 2
  curl -sS --fail-with-body -X "$method" "$url" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "x-goog-api-client: spikedeck-makefile" \
    "$@"
}

cmd_status() {
  need
  TOKEN="$(access_token)"
  api GET "https://chromewebstore.googleapis.com/v2/$(item_path):fetchStatus"
  echo
}

cmd_upload() {
  need
  if [[ ! -f "$ZIP" ]]; then
    echo "Missing $ZIP — run: make package" >&2
    exit 1
  fi
  TOKEN="$(access_token)"
  echo "Uploading $ZIP (${VERSION}) to ${CWS_EXTENSION_ID}…"
  api POST "https://chromewebstore.googleapis.com/upload/v2/$(item_path):upload" \
    -H "Content-Type: application/zip" \
    --data-binary @"$ZIP"
  echo
}

cmd_submit() {
  need
  TOKEN="$(access_token)"
  echo "Submitting ${CWS_EXTENSION_ID} for Chrome Web Store review…"
  api POST "https://chromewebstore.googleapis.com/v2/$(item_path):publish" \
    -H "Content-Type: application/json" \
    -d '{"publishType":"DEFAULT_PUBLISH"}'
  echo
}

cmd_cancel() {
  need
  TOKEN="$(access_token)"
  echo "Cancelling pending Chrome Web Store submission for ${CWS_EXTENSION_ID}…"
  api POST "https://chromewebstore.googleapis.com/v2/$(item_path):cancelSubmission" \
    -H "Content-Type: application/json" \
    -d '{}'
  echo
}

cmd_release() {
  cmd_upload
  cmd_submit
}

usage() {
  cat <<EOF
Usage: scripts/cws.sh <upload|submit|release|status|cancel>

  upload   POST the zip at ${ZIP} to the existing store item
  submit   submit the current draft for review (publishes after approval)
  release  upload then submit
  status   fetchStatus of the store item
  cancel   cancel a pending store review submission

Requires CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN,
CWS_PUBLISHER_ID, CWS_EXTENSION_ID (env or .env).
The API cannot create a new item; create it once in the Developer Dashboard.
EOF
}

case "${1:-}" in
  upload) cmd_upload ;;
  submit) cmd_submit ;;
  release) cmd_release ;;
  status) cmd_status ;;
  cancel) cmd_cancel ;;
  *) usage; exit 1 ;;
esac
