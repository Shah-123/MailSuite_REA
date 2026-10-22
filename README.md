# MailSuite_REA

A self-hosted email open and click tracker with an analytics dashboard, plus the REA
workspace used to study the Mailsuite dashboard.

## Mail tracker

Node.js 22.13+ with Express and Node's built-in SQLite; nothing to compile.

```bash
npm install
npm run create-user -- you@example.com "Your Name"   # prints your API key once
PUBLIC_URL=https://track.example.com npm start         # dashboard on http://localhost:3000
npm test
npm run seed-demo                                      # optional: a month of demo data
```

How it works:

- `POST /api/emails` registers an email (subject, recipients, links) and returns a 1x1
  pixel URL and one tracked URL per link. "New tracked email" in the dashboard does the
  same for any mail client: paste the pixel HTML into the body and use the tracked links.
- When the recipient's mail client loads the pixel, the server records an open: time,
  email client, OS and device. A tracked link records a click, then redirects to the
  original URL (http/https only).
- Opens in the first `SENDER_GRACE_SECONDS` (default 30) after registration are treated
  as your own view of the sent email. Bots and security scanners are recorded but not
  counted, and repeat loads from the same client within `DEDUPE_SECONDS` count once.
  IP addresses are only stored salted and hashed.
- The dashboard shows sent, open-rate and click-rate KPIs, daily activity, an opens
  heatmap by weekday and hour, email-client and device breakdowns, top links and
  recipients, and a live activity feed. The email list can be filtered (opened, not
  opened, clicked) and searched, and each email has an open and click timeline.

Limits to know:

- `PUBLIC_URL` must be reachable from the internet (HTTPS) for recipients' clients to
  load the pixel. Behind a reverse proxy, set `TRUST_PROXY` (for example `1`).
- One pixel covers all recipients of an email, so an open on a multi-recipient email
  means at least one of them opened it.
- Gmail and Yahoo fetch images through their own proxies, which hides the reader's
  device. Apple Mail Privacy Protection can preload images, so some Apple Mail opens
  happen without the email being read. Recipients who block images are not counted
  until they click a link.
- Tracking pixels can count as personal-data processing (GDPR, ePrivacy). Check what
  applies to you, and tell recipients if you need to.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base URL put in pixels and tracked links |
| `DATABASE_PATH` | `data/tracker.db` | SQLite file |
| `SENDER_GRACE_SECONDS` | `30` | Ignore opens this soon after registering |
| `DEDUPE_SECONDS` | `60` | Collapse repeat loads from one client |
| `IP_SALT` | random per start | Salt for hashed IPs; set it to keep dedupe across restarts |
| `TRUST_PROXY` | `false` | Express `trust proxy` setting |

## REA workspace

Reverse-engineering workspace for the Mailsuite web dashboard
(`https://mailsuite.com/en/dashboard/home`). It uses [REA](https://github.com/morluto/rea),
an MCP server and CLI, to record what the dashboard does: its pages, routes, API calls
and data shapes. The goal is to build our own implementation of the same features.

### Status

| Step | State |
| --- | --- |
| Install REA (`rea-agents@6.7.0`) | Done and verified (`rea --version`, MCP server lists 207 tools) |
| REA web pipeline in headless Chromium | Verified end to end on a local test page |
| Live capture of `mailsuite.com` | **Blocked**: the cloud environment's network policy denies `mailsuite.com` (proxy 403) |
| Logged-in dashboard capture | Needs a HAR exported from your own logged-in browser (see below) |

### Setup

```bash
npm install --global rea-agents@6.7.0   # or let the scripts fall back to npx
rea doctor                              # native engines (Hopper/Ghidra/IDA) are not needed for web work
```

`.mcp.json` registers REA's MCP server, so Claude Code sessions opened on this repo can
call REA's tools (`inspect_web_page`, `analyze_web_bundle`, `inspect_web_network_capture`, …)
directly.

### Capture paths

#### 1. Live page and JavaScript bundles

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

#### 2. Logged-in dashboard via HAR (recommended for the real features)

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

### Privacy and scope

- `captures/`, `*.har` and `*.saz` are git-ignored. They hold your email metadata and
  may hold tokens. Only commit summaries you have reviewed.
- Use the captures to understand behavior and design a separate implementation.
  Don't copy Mailsuite's code, text or assets into this project.
