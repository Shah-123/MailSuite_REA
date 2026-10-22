#!/usr/bin/env bash
# Capture one web page with REA and statically analyze its JavaScript.
#
# Starts a disposable headless Chromium with a loopback CDP port, opens the URL,
# then runs REA's passive page inspection, bundle analysis (routes/endpoints),
# a screenshot, script export and the JavaScript application analyzer.
#
# Usage: scripts/rea-web-capture.sh <url> [out-dir]
#
# Environment:
#   CHROME           Chromium-family executable (auto-detected if unset)
#   CDP_PORT         Loopback debugging port (default 9222)
#   OBSERVE_MS       Observation window per REA call in ms (default 8000)
#   ALLOWED_ORIGINS  Space-separated extra origins to include, e.g. a script CDN
#   REA              REA command (default: `rea` on PATH, else pinned npx)
set -euo pipefail

url="${1:?usage: $0 <url> [out-dir]}"
out="$(realpath -m "${2:-captures/$(date -u +%Y%m%dT%H%M%SZ)}")"
port="${CDP_PORT:-9222}"
observe_ms="${OBSERVE_MS:-8000}"
endpoint="http://127.0.0.1:$port"

if [ -n "${REA:-}" ]; then
  read -r -a rea <<<"$REA"
elif command -v rea >/dev/null 2>&1; then
  rea=(rea)
else
  rea=(npx -y rea-agents@6.7.0)
fi

chrome="${CHROME:-}"
if [ -z "$chrome" ]; then
  for candidate in chromium chromium-browser google-chrome google-chrome-stable /opt/pw-browsers/chromium-*/chrome-linux/chrome; do
    if command -v "$candidate" >/dev/null 2>&1; then
      chrome="$(command -v "$candidate")"
      break
    fi
  done
fi
[ -n "$chrome" ] || { echo "No Chromium-family browser found; set CHROME." >&2; exit 1; }

[ ! -e "$out/scripts" ] || { echo "$out/scripts already exists; pick a new out-dir." >&2; exit 1; }
mkdir -p "$out"

profile="$(mktemp -d)"
"$chrome" --headless=new --no-sandbox --password-store=basic --window-size=1440,900 \
  --remote-debugging-port="$port" --user-data-dir="$profile" \
  "$url" >"$out/chrome.log" 2>&1 &
chrome_pid=$!
trap 'kill "$chrome_pid" 2>/dev/null || true; wait "$chrome_pid" 2>/dev/null || true; rm -rf "$profile"' EXIT

curl -sf --retry 30 --retry-delay 1 --retry-connrefused "$endpoint/json/version" >/dev/null

# Wait for the page target to commit an http(s) URL (redirects such as a login wall included).
target="$(python3 - "$endpoint" <<'PY'
import json, sys, time, urllib.request
for _ in range(60):
    pages = [t for t in json.load(urllib.request.urlopen(sys.argv[1] + "/json/list"))
             if t["type"] == "page" and t["url"].startswith("http")]
    if pages:
        print(pages[0]["id"])
        break
    time.sleep(0.5)
else:
    sys.exit("No http(s) page target appeared; see chrome.log.")
PY
)"

origin_args=()
for origin in ${ALLOWED_ORIGINS:-}; do
  origin_args+=(--allowed-origins "$origin")
done
if [ "${#origin_args[@]}" -gt 0 ]; then
  # An explicit filter replaces the default scope, so keep the page's own origin.
  page_origin="$(curl -sf "$endpoint/json/list" | python3 -c 'import json,sys,urllib.parse as u
t=[t for t in json.load(sys.stdin) if t["id"]==sys.argv[1]][0]; p=u.urlsplit(t["url"]); print(f"{p.scheme}://{p.netloc}")' "$target")"
  origin_args+=(--allowed-origins "$page_origin")
fi

echo "Capturing target $target into $out"
"${rea[@]}" inspect-web-page "$endpoint" "$target" "${origin_args[@]}" \
  --observation-ms "$observe_ms" --include-script-sources --include-json-body-shapes \
  --include-storage-keys --include-accessibility-text --format json >"$out/page.json"
"${rea[@]}" analyze-web-bundle "$endpoint" "$target" "${origin_args[@]}" \
  --observation-ms "$observe_ms" --fetch-source-maps --format json >"$out/bundle.json"
"${rea[@]}" capture-web-screenshot "$endpoint" "$target" "${origin_args[@]}" --format json >"$out/screenshot.json"
"${rea[@]}" export-web-scripts "$out/page.json" "$out/scripts" --format json >"$out/export.json"
"${rea[@]}" analyze-javascript-application "$out/scripts" --format json >"$out/app.json"

python3 - "$out" <<'PY'
import base64, json, sys
out = sys.argv[1]
shot = json.load(open(f"{out}/screenshot.json"))["normalized_result"]["artifact"]
open(f"{out}/screenshot.png", "wb").write(base64.b64decode(shot["data_base64"]))
obs = json.load(open(f"{out}/bundle.json"))["normalized_result"]["observations"]
print(f"Scripts parsed: {len(obs['chunks'])}")
print(f"Route candidates: {len(obs['routes'])}")
for r in obs["routes"][:40]:
    print("  ", r.get("value"))
print(f"Endpoint candidates: {len(obs['endpoints'])}")
for e in obs["endpoints"][:40]:
    print("  ", e.get("mechanism"), e.get("value"))
PY
echo "Evidence written to $out"
