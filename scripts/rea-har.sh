#!/usr/bin/env bash
# Inspect a HAR exported from your own logged-in browser session with REA
# (offline: recorded URLs are never fetched), then summarize the API surface.
#
# Usage: scripts/rea-har.sh <capture.har> [out-dir]
#
# Writes <out-dir>/har.json (REA Evidence) and <out-dir>/api-map.md, which lists
# each distinct API call with its status codes and the key structure of its JSON
# request/response bodies. Values are left out of api-map.md; har.json keeps them.
set -euo pipefail

har="$(realpath "${1:?usage: $0 <capture.har> [out-dir]}")"
out="$(realpath -m "${2:-captures/har-$(date -u +%Y%m%dT%H%M%SZ)}")"

if [ -n "${REA:-}" ]; then
  read -r -a rea <<<"$REA"
elif command -v rea >/dev/null 2>&1; then
  rea=(rea)
else
  rea=(npx -y rea-agents@6.7.0)
fi

mkdir -p "$out"
"${rea[@]}" inspect-web-network-capture "$har" har --format json >"$out/har.json"

python3 - "$out" <<'PY'
import json, re, sys
from collections import OrderedDict
from urllib.parse import urlsplit

out = sys.argv[1]
records = json.load(open(f"{out}/har.json"))["normalized_result"]["records"]

STATIC = re.compile(r"\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|eot|mp4|webm)$", re.I)
ID_SEGMENT = re.compile(r"^(\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|[A-Za-z0-9_-]{20,})$", re.I)

def template(path):
    return "/".join(":id" if ID_SEGMENT.match(seg) else seg for seg in path.split("/")) or "/"

def shape(value, depth=0):
    if depth > 6:
        return "…"
    if isinstance(value, dict):
        return {k: shape(v, depth + 1) for k, v in value.items()}
    if isinstance(value, list):
        return [shape(value[0], depth + 1)] if value else []
    return type(value).__name__ if value is not None else "null"

def body_shape(text):
    try:
        return json.dumps(shape(json.loads(text)), separators=(",", ":"))[:600]
    except (TypeError, ValueError):
        return None

calls = OrderedDict()
for record in records:
    entry = record["reported"]
    request, response = entry["request"], entry["response"]
    url = urlsplit(request["url"])
    mime = (response.get("content") or {}).get("mimeType") or ""
    if STATIC.search(url.path) or mime.startswith(("image/", "font/", "text/css")):
        continue
    key = (request["method"], url.netloc, template(url.path))
    call = calls.setdefault(key, {"statuses": set(), "params": set(), "mime": set(),
                                  "request": None, "response": None, "ordinals": []})
    call["statuses"].add(response["status"])
    call["params"].update(q["name"] for q in request.get("queryString", []))
    if mime:
        call["mime"].add(mime.split(";")[0])
    call["ordinals"].append(record["ordinal"])
    call["request"] = call["request"] or body_shape((request.get("postData") or {}).get("text"))
    call["response"] = call["response"] or body_shape((response.get("content") or {}).get("text"))

lines = [f"# API map ({len(calls)} distinct calls from {len(records)} records)", ""]
for (method, host, path), call in calls.items():
    lines.append(f"## `{method} {path}`")
    lines.append(f"- host: `{host}` · status: {sorted(call['statuses'])} · type: {', '.join(sorted(call['mime'])) or '?'}")
    if call["params"]:
        lines.append(f"- query params: {', '.join(f'`{p}`' for p in sorted(call['params']))}")
    if call["request"]:
        lines.append(f"- request body shape: `{call['request']}`")
    if call["response"]:
        lines.append(f"- response body shape: `{call['response']}`")
    lines.append(f"- HAR records: {call['ordinals'][:20]}")
    lines.append("")
open(f"{out}/api-map.md", "w").write("\n".join(lines))
print("\n".join(lines))
PY
echo "Evidence written to $out"
