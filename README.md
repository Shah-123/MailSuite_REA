# MailSuite_REA

Reverse-engineering workspace for the Mailsuite web dashboard
(`https://mailsuite.com/en/dashboard/home`). It uses [REA](https://github.com/morluto/rea),
an MCP server and CLI, to record what the dashboard does: its pages, routes, API calls
and data shapes. The goal is to build our own implementation of the same features.

## Status

| Step | State |
| --- | --- |
| Install REA (`rea-agents@6.7.0`) | Done and verified (`rea --version`, MCP server lists 207 tools) |
| REA web pipeline in headless Chromium | Verified end to end on a local test page |
| Live capture of `mailsuite.com` | **Blocked**: the cloud environment's network policy denies `mailsuite.com` (proxy 403) |
| Logged-in dashboard capture | Needs a HAR exported from your own logged-in browser (see below) |

## Setup

```bash
npm install --global rea-agents@6.7.0   # or let the scripts fall back to npx
rea doctor                              # native engines (Hopper/Ghidra/IDA) are not needed for web work
```

`.mcp.json` registers REA's MCP server, so Claude Code sessions opened on this repo can
call REA's tools (`inspect_web_page`, `analyze_web_bundle`, `inspect_web_network_capture`, …)
directly.

## Capture paths

### 1. Live page and JavaScript bundles

```bash
scripts/rea-web-capture.sh https://mailsuite.com/en/dashboard/home captures/dashboard
```

This starts a disposable headless Chromium with a loopback CDP port, and REA records:

- `page.json`: DOM, accessibility tree, scripts, network and storage key names
- `bundle.json`: route and API endpoint candidates parsed from the JS bundles
- `screenshot.png`
- `scripts/` and `app.json`: exported scripts and REA's static application graph

The browser is not logged in, so the dashboard URL lands on the sign-in wall. The SPA's
JavaScript bundles still expose route and endpoint candidates. Scripts served from
another origin (a CDN, say) need `ALLOWED_ORIGINS="https://cdn.example.com"`.

In the cloud environment this needs `mailsuite.com`, plus any CDN or API hosts the page
uses, added under the environment's network access settings. On your own machine it
works as is.

### 2. Logged-in dashboard via HAR (recommended for the real features)

1. Sign in at `https://mailsuite.com/en/dashboard/home` in Chrome.
2. Open DevTools → Network, tick **Preserve log**, then reload.
3. Use every dashboard feature you want replicated: the tracked-email list,
   read/unread filters, search, an email's detail and opens timeline, link clicks,
   reports, reminders, settings and billing.
4. Click **Export HAR (sanitized)**. The sanitized export leaves out cookies and
   `Authorization` headers.
5. Save it as `captures/dashboard.har`, then run:

```bash
scripts/rea-har.sh captures/dashboard.har captures/har
```

REA reads the HAR offline and never re-fetches its URLs. `captures/har/api-map.md` lists
each distinct API call with its status codes, query parameters, and the key structure
(no values) of its JSON request and response bodies.

## Privacy and scope

- `captures/`, `*.har` and `*.saz` are git-ignored. They hold your email metadata and
  may hold tokens. Only commit summaries you have reviewed.
- Use the captures to understand behavior and design a separate implementation.
  Don't copy Mailsuite's code, text or assets into this project.
