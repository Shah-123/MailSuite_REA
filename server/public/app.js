const KEY_STORAGE = "mailTracker.apiKey";
const PAGE_SIZE = 25;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEVICE_LABELS = { desktop: "Desktop", mobile: "Mobile", tablet: "Tablet", unknown: "Hidden by mail proxy" };

const state = {
  apiKey: null,
  me: null,
  page: "overview",
  days: 30,
  emails: { status: "all", q: "", offset: 0 },
  chart: null,
  openEmailId: null,
  showIgnored: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const view = $("#view");
const drawer = $("#drawer");
const modal = $("#modal");

// ---------- helpers ----------

class Raw {
  constructor(value) {
    this.value = value;
  }
}
const raw = (value) => new Raw(value);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const part = (value) => (value instanceof Raw ? value.value : Array.isArray(value) ? value.map(part).join("") : esc(value));

// Template tag that escapes every interpolation unless wrapped in raw().
function html(strings, ...values) {
  return raw(strings.reduce((out, s, i) => out + s + (i < values.length ? part(values[i]) : ""), ""));
}
const render = (element, template) => (element.innerHTML = template.value);

function storage(action, value) {
  try {
    if (action === "get") return localStorage.getItem(KEY_STORAGE);
    if (action === "set") localStorage.setItem(KEY_STORAGE, value);
    if (action === "clear") localStorage.removeItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${state.apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    signOut();
    throw new Error("Signed out");
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`);
  return res.status === 204 ? null : res.json();
}

const fmtNum = (n) => Number(n ?? 0).toLocaleString();
const fmtPct = (r) => `${Math.round((r ?? 0) * 100)}%`;
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function ago(iso) {
  const seconds = (new Date(iso) - Date.now()) / 1000;
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function fmtDuration(minutes) {
  if (minutes == null) return "—";
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1440).toFixed(1)} d`;
}

const ticks = (status) =>
  html`<span class="ticks ${status}" title="${{ sent: "Sent, not opened yet", opened: "Opened", clicked: "Opened and clicked" }[status]}">${status === "sent" ? "✓" : "✓✓"}</span>`;

const recipientsText = (list) => (list.length ? list.join(", ") : "—");
const whoText = (list) => (list.length === 1 ? list[0] : list.length ? `One of ${list.length} recipients` : "Someone");

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 6000);
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1500);
  } catch {
    prompt("Copy this:", text);
  }
}

// ---------- auth ----------

async function boot() {
  state.apiKey = storage("get");
  if (state.apiKey) {
    try {
      state.me = await api("/me");
      return showApp();
    } catch {
      /* fall through to login */
    }
  }
  showLogin();
}

function showLogin() {
  $("#shell").hidden = true;
  $("#login").hidden = false;
  $("#api-key").focus();
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.apiKey = $("#api-key").value.trim();
  const error = $("#login-error");
  try {
    state.me = await api("/me");
    storage("set", state.apiKey);
    error.hidden = true;
    showApp();
  } catch {
    error.textContent = "That API key wasn't accepted.";
    error.hidden = false;
  }
});

function signOut() {
  storage("clear");
  state.apiKey = null;
  state.liveAbort?.abort();
  showLogin();
}
$("#sign-out").addEventListener("click", signOut);

function showApp() {
  $("#login").hidden = true;
  $("#shell").hidden = false;
  $("#user-email").textContent = state.me.email;
  connectLive();
  route();
}

// ---------- routing ----------

window.addEventListener("hashchange", route);

function route() {
  if (!state.apiKey) return;
  const [, page = "overview", id] = location.hash.split("/");
  state.page = page === "emails" ? "emails" : "overview";
  for (const link of document.querySelectorAll("[data-nav]")) link.classList.toggle("active", link.dataset.nav === state.page);
  (state.page === "emails" ? renderEmails : renderOverview)();
  if (id) openEmail(decodeURIComponent(id));
}

// ---------- overview ----------

async function renderOverview() {
  const tzOffset = -new Date().getTimezoneOffset();
  const [stats, activity] = await Promise.all([api(`/stats?days=${state.days}&tzOffset=${tzOffset}`), api("/activity?limit=8")]);
  if (state.page !== "overview") return;
  const t = stats.totals;
  const avgOpens = t.opened ? (t.opens / t.opened).toFixed(1) : "0";

  render(
    view,
    html`
      <header class="page-head">
        <div>
          <h1>Overview</h1>
          <p class="muted" style="margin:0">Emails sent in the last ${state.days} days</p>
        </div>
        <div class="actions">
          <select id="range" aria-label="Date range">
            ${[7, 30, 90].map((d) => html`<option value="${d}" ${raw(d === state.days ? "selected" : "")}>Last ${d} days</option>`)}
          </select>
          <button class="btn primary" data-action="new-email">New tracked email</button>
        </div>
      </header>

      <section class="kpis">
        ${kpi("Emails sent", fmtNum(t.sent), `${fmtNum(t.unopened)} not opened yet`)}
        ${kpi("Open rate", fmtPct(t.openRate), `${fmtNum(t.opened)} of ${fmtNum(t.sent)} opened`)}
        ${kpi("Click rate", fmtPct(t.clickRate), `${fmtNum(t.clicked)} emails · ${fmtNum(t.clicks)} clicks`)}
        ${kpi("Total opens", fmtNum(t.opens), `${avgOpens} per opened email`)}
        ${kpi("Time to open", fmtDuration(t.avgMinutesToOpen), "average, first open")}
      </section>

      <section class="card">
        <div class="card-head"><h2>Activity</h2><span class="muted">per day</span></div>
        <div class="chart-box"><canvas id="activity-chart" aria-label="Emails sent, opens and clicks per day"></canvas></div>
      </section>

      <section class="grid-2">
        <div class="card">
          <h2>When your emails get opened</h2>
          ${heatmap(stats.heatmap)}
        </div>
        <div class="card">
          <div class="card-head"><h2>Recent activity</h2><a href="#/emails">All emails</a></div>
          ${feed(activity.items)}
        </div>
      </section>

      <section class="grid-2">
        <div class="card">
          <h2>Email clients</h2>
          ${bars(stats.clients)}
        </div>
        <div class="card">
          <h2>Devices</h2>
          ${bars(stats.devices.map((d) => ({ ...d, label: DEVICE_LABELS[d.label] ?? d.label })))}
          <p class="note" style="margin-top:12px">Gmail and Yahoo load images through their own servers, which hides the reader's device. Link clicks reveal it.</p>
        </div>
      </section>

      <section class="grid-2">
        <div class="card">
          <h2>Top links</h2>
          ${stats.topLinks.length
            ? html`<div class="table-wrap"><table>
                <thead><tr><th>Link</th><th class="num">Clicks</th><th class="num">Emails</th></tr></thead>
                <tbody>${stats.topLinks.map(
                  (l) => html`<tr><td class="ellipsis"><a href="${l.url}" target="_blank" rel="noopener noreferrer">${l.url}</a></td><td class="num">${fmtNum(l.clicks)}</td><td class="num">${fmtNum(l.emails)}</td></tr>`,
                )}</tbody></table></div>`
            : html`<p class="empty">No link clicks yet.</p>`}
        </div>
        <div class="card">
          <h2>Top recipients</h2>
          ${stats.topRecipients.length
            ? html`<div class="table-wrap"><table>
                <thead><tr><th>Recipient</th><th class="num">Sent</th><th class="num">Opened</th></tr></thead>
                <tbody>${stats.topRecipients.map(
                  (r) => html`<tr><td class="ellipsis">${r.recipient}</td><td class="num">${fmtNum(r.sent)}</td><td class="num">${fmtNum(r.opened)}</td></tr>`,
                )}</tbody></table></div>
                <p class="note" style="margin-top:12px">For emails with several recipients, "opened" means at least one of them opened it.</p>`
            : html`<p class="empty">No emails sent in this period.</p>`}
        </div>
      </section>
    `,
  );

  $("#range").addEventListener("change", (event) => {
    state.days = Number(event.target.value);
    renderOverview();
  });
  drawChart(stats.daily);
}

const kpi = (label, value, sub) =>
  html`<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;

function heatmap(grid) {
  const order = [1, 2, 3, 4, 5, 6, 0];
  const max = Math.max(0, ...grid.flat());
  if (!max) return html`<p class="empty">Opens will show up here by day and hour.</p>`;
  let best = { day: 0, hour: 0, n: -1 };
  grid.forEach((hours, day) => hours.forEach((n, hour) => n > best.n && (best = { day, hour, n })));
  const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });

  return html`
    <div class="heatmap" role="img" aria-label="Opens by weekday and hour">
      ${order.map(
        (day) => html`<span class="day">${WEEKDAYS[day]}</span>${grid[day].map((n, hour) => {
          const strength = n ? Math.round(20 + (80 * n) / max) : 0;
          const style = n ? `background: color-mix(in srgb, var(--accent) ${strength}%, var(--surface-2))` : "";
          return html`<span class="cell" style="${style}" title="${WEEKDAYS[day]} ${hourLabel(hour)} · ${n} open${n === 1 ? "" : "s"}"></span>`;
        })}`,
      )}
      <span></span>${[0, 6, 12, 18].map((h) => html`<span class="hour">${hourLabel(h)}</span>`)}
    </div>
    <p class="insight">Most opens: <strong>${WEEKDAYS[best.day]}</strong> around <strong>${hourLabel(best.hour)}</strong>. Sending shortly before then gives your email the best chance of being seen.</p>
  `;
}

function bars(rows) {
  if (!rows.length) return html`<p class="empty">No data yet.</p>`;
  const max = Math.max(...rows.map((r) => r.count));
  return html`<div class="bars">${rows.map(
    (r) => html`<div class="bar-row"><span class="name">${r.label}</span><span class="count">${fmtNum(r.count)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${raw(String(Math.max(2, (100 * r.count) / max)))}%"></div></div></div>`,
  )}</div>`;
}

function feed(items) {
  if (!items.length) return html`<p class="empty">Opens and clicks appear here as they happen.</p>`;
  return html`<ul class="feed">${items.map(
    (ev) => html`<li>
      <span class="icon ${ev.type}">${ev.type === "open" ? "✓✓" : "↗"}</span>
      <div>
        <div class="what"><strong>${whoText(ev.recipients)}</strong> ${ev.type === "open" ? "opened" : "clicked a link in"}
          <a href="#/${state.page}/${encodeURIComponent(ev.emailId)}">${ev.subject || "(no subject)"}</a></div>
        <div class="meta">${[ev.client, DEVICE_LABELS[ev.device] ?? ev.device].filter(Boolean).join(" · ")}${ev.linkUrl ? html` · ${ev.linkUrl}` : ""}</div>
      </div>
      <span class="when" title="${fmtDate(ev.occurredAt)}">${ago(ev.occurredAt)}</span>
    </li>`,
  )}</ul>`;
}

function drawChart(daily) {
  const canvas = $("#activity-chart");
  if (!canvas || !window.Chart) return;
  state.chart?.destroy();
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const line = (label, key, c) => ({
    type: "line",
    label,
    data: daily.map((d) => d[key]),
    borderColor: c,
    backgroundColor: c,
    tension: 0.3,
    pointRadius: daily.length > 31 ? 0 : 2,
    borderWidth: 2,
    order: 1,
  });

  state.chart = new window.Chart(canvas, {
    data: {
      labels: daily.map((d) => new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })),
      datasets: [
        { type: "bar", label: "Sent", data: daily.map((d) => d.sent), backgroundColor: color("--accent-soft"), borderRadius: 4, order: 2 },
        line("Opens", "opens", color("--opened")),
        line("Clicks", "clicks", color("--clicked")),
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { grid: { display: false }, ticks: { color: color("--muted"), maxTicksLimit: 10 } },
        y: { beginAtZero: true, ticks: { color: color("--muted"), precision: 0 }, grid: { color: color("--border") } },
      },
      plugins: { legend: { align: "end", labels: { color: color("--text"), usePointStyle: true, boxWidth: 8 } } },
    },
  });
}

// ---------- tracked emails ----------

function renderEmails() {
  const tabs = [
    ["all", "All"],
    ["opened", "Opened"],
    ["unopened", "Not opened"],
    ["clicked", "Clicked"],
  ];
  render(
    view,
    html`
      <header class="page-head">
        <h1>Tracked emails</h1>
        <div class="actions"><button class="btn primary" data-action="new-email">New tracked email</button></div>
      </header>
      <section class="card">
        <div class="filters">
          <div class="tabs" role="tablist">
            ${tabs.map(([value, label]) => html`<button role="tab" data-status="${value}" class="${raw(value === state.emails.status ? "active" : "")}">${label}</button>`)}
          </div>
          <input id="search" type="search" placeholder="Search subject or recipient" value="${state.emails.q}" />
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th></th><th>Email</th><th>Sent</th><th class="num">Opens</th><th class="num">Clicks</th><th>Last activity</th></tr></thead>
            <tbody id="email-rows"></tbody>
          </table>
        </div>
        <div class="pager" id="pager"></div>
      </section>
    `,
  );

  for (const tab of view.querySelectorAll("[data-status]")) {
    tab.addEventListener("click", () => {
      state.emails = { ...state.emails, status: tab.dataset.status, offset: 0 };
      view.querySelectorAll("[data-status]").forEach((t) => t.classList.toggle("active", t === tab));
      loadEmails();
    });
  }
  let debounce;
  $("#search").addEventListener("input", (event) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.emails = { ...state.emails, q: event.target.value.trim(), offset: 0 };
      loadEmails();
    }, 250);
  });
  loadEmails();
}

async function loadEmails() {
  const { status, q, offset } = state.emails;
  const params = new URLSearchParams({ status, q, offset, limit: PAGE_SIZE });
  const { items, total } = await api(`/emails?${params}`);
  const rows = $("#email-rows");
  if (!rows) return;

  render(
    rows,
    items.length
      ? html`${items.map(
          (e) => html`<tr class="clickable" data-email="${e.id}">
            <td>${ticks(e.status)}</td>
            <td><div class="subject ellipsis">${e.subject || "(no subject)"}</div><div class="muted ellipsis">${recipientsText(e.recipients)}</div></td>
            <td title="${fmtDate(e.sentAt)}" style="white-space:nowrap">${ago(e.sentAt)}</td>
            <td class="num">${fmtNum(e.opens)}</td>
            <td class="num">${fmtNum(e.clicks)}</td>
            <td style="white-space:nowrap">${e.lastActivityAt ? ago(e.lastActivityAt) : html`<span class="muted">—</span>`}</td>
          </tr>`,
        )}`
      : html`<tr><td colspan="6" class="empty">${q || status !== "all" ? "No emails match." : "No tracked emails yet. Send one from Gmail with the extension, or create one here."}</td></tr>`,
  );
  for (const row of rows.querySelectorAll("[data-email]")) {
    row.addEventListener("click", () => (location.hash = `#/emails/${encodeURIComponent(row.dataset.email)}`));
  }

  render(
    $("#pager"),
    total
      ? html`<span>${fmtNum(offset + 1)}–${fmtNum(offset + items.length)} of ${fmtNum(total)}</span>
          <span class="actions" style="display:flex;gap:8px">
            <button class="btn small" data-page="-1" ${raw(offset === 0 ? "disabled" : "")}>Previous</button>
            <button class="btn small" data-page="1" ${raw(offset + items.length >= total ? "disabled" : "")}>Next</button>
          </span>`
      : html``,
  );
  for (const button of $("#pager").querySelectorAll("[data-page]")) {
    button.addEventListener("click", () => {
      state.emails.offset = Math.max(0, offset + Number(button.dataset.page) * PAGE_SIZE);
      loadEmails();
    });
  }
}

// ---------- email detail ----------

async function openEmail(id) {
  let email;
  try {
    email = await api(`/emails/${encodeURIComponent(id)}`);
  } catch (error) {
    toast(error.message);
    return closeDrawer();
  }
  state.openEmailId = id;
  const counted = email.events.filter((e) => !e.ignoredReason);
  const opens = counted.filter((e) => e.type === "open");
  const clicks = counted.filter((e) => e.type === "click");
  const status = clicks.length ? "clicked" : opens.length ? "opened" : "sent";
  const ignoredCount = email.events.length - counted.length;
  const ignoredLabel = { sender: "Ignored: your own view right after sending", automated: "Ignored: security scanner or bot" };
  const timeline = [
    ...email.events.filter((e) => state.showIgnored || !e.ignoredReason).reverse(),
    { type: "sent", occurredAt: email.sentAt },
  ];

  render(
    drawer,
    html`<div class="dialog-body">
      <div class="dialog-head">
        <div>
          <div>${ticks(status)}</div>
          <h2>${email.subject || "(no subject)"}</h2>
        </div>
        <button class="close" data-action="close-drawer" aria-label="Close">×</button>
      </div>
      <div class="chips">${email.recipients.length ? email.recipients.map((r) => html`<span class="chip">${r}</span>`) : html`<span class="muted">No recipients recorded</span>`}</div>
      <div class="facts">
        <div class="fact"><div class="value">${fmtNum(opens.length)}</div><div class="label">Opens</div></div>
        <div class="fact"><div class="value">${fmtNum(clicks.length)}</div><div class="label">Clicks</div></div>
        <div class="fact"><div class="value">${counted.length ? ago(counted[0].occurredAt) : "—"}</div><div class="label">First opened</div></div>
      </div>
      ${email.recipients.length > 1 ? html`<p class="note">One tracking pixel covers all ${email.recipients.length} recipients, so an open means at least one of them read it, not which one.</p>` : ""}

      ${email.links.length
        ? html`<div><h2>Links</h2><div class="bars">${email.links.map(
            (l) => html`<div class="bar-row"><a class="name" href="${l.url}" target="_blank" rel="noopener noreferrer">${l.url}</a><span class="count">${fmtNum(l.clicks)} click${l.clicks === 1 ? "" : "s"}</span></div>`,
          )}</div></div>`
        : ""}

      <div>
        <div class="card-head">
          <h2>Timeline</h2>
          ${ignoredCount ? html`<label class="muted"><input type="checkbox" id="show-ignored" style="width:auto" ${raw(state.showIgnored ? "checked" : "")}> Show ${ignoredCount} ignored</label>` : ""}
        </div>
        <ul class="timeline">${timeline.map(
          (ev) => html`<li class="${ev.type} ${raw(ev.ignoredReason ? "ignored" : "")}">
            <div><strong>${{ open: "Opened", click: "Clicked a link", sent: "Sent" }[ev.type]}</strong> · <span title="${fmtDate(ev.occurredAt)}">${ago(ev.occurredAt)}</span></div>
            <div class="meta">${ev.type === "sent"
              ? `${fmtDate(ev.occurredAt)} · ${email.source === "gmail-extension" ? "via Gmail extension" : "created manually"}`
              : [ev.client, DEVICE_LABELS[ev.device] ?? ev.device, ev.os !== "Unknown" ? ev.os : null, ev.linkUrl].filter(Boolean).join(" · ")}</div>
            ${ev.ignoredReason ? html`<div class="meta">${ignoredLabel[ev.ignoredReason] ?? ev.ignoredReason}</div>` : ""}
          </li>`,
        )}</ul>
      </div>

      <div class="field">
        <label>Tracking pixel</label>
        <div class="copy-row"><code>${email.pixelUrl}</code><button class="btn small" data-copy="${email.pixelUrl}">Copy</button></div>
      </div>
      <div><button class="btn danger" data-action="delete-email">Delete email and its tracking data</button></div>
    </div>`,
  );

  $("#show-ignored", drawer)?.addEventListener("change", (event) => {
    state.showIgnored = event.target.checked;
    openEmail(id);
  });
  $("[data-action=delete-email]", drawer).addEventListener("click", async () => {
    if (!confirm("Delete this email and all its opens and clicks?")) return;
    await api(`/emails/${encodeURIComponent(id)}`, { method: "DELETE" });
    closeDrawer();
    route();
  });
  if (!drawer.open) drawer.showModal();
}

function closeDrawer() {
  state.openEmailId = null;
  if (drawer.open) drawer.close();
  const [, page] = location.hash.split("/");
  if (location.hash.split("/").length > 2) history.replaceState(null, "", `#/${page}`);
}

drawer.addEventListener("close", closeDrawer);
drawer.addEventListener("click", (event) => {
  if (event.target === drawer || event.target.closest("[data-action=close-drawer]")) closeDrawer();
});

// ---------- new tracked email ----------

function openNewEmail() {
  render(
    modal,
    html`<form class="dialog-body" id="new-email-form">
      <div class="dialog-head"><h2>New tracked email</h2><button type="button" class="close" data-action="close-modal" aria-label="Close">×</button></div>
      <p class="note">For Outlook, Apple Mail or any other client. In Gmail, the extension does this for you on every send.</p>
      <div class="field"><label for="ne-subject">Subject</label><input id="ne-subject" maxlength="998" required /></div>
      <div class="field"><label for="ne-recipients">Recipients</label><input id="ne-recipients" placeholder="ana@client.com, bo@shop.com" /></div>
      <div class="field"><label for="ne-links">Links to track <span class="muted">(optional, one per line)</span></label><textarea id="ne-links" placeholder="https://example.com/proposal"></textarea></div>
      <p id="ne-error" class="error" hidden></p>
      <div><button class="btn primary" type="submit">Create tracking pixel</button></div>
    </form>`,
  );
  $("#new-email-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const created = await api("/emails", {
        method: "POST",
        body: {
          subject: $("#ne-subject").value,
          recipients: $("#ne-recipients").value.split(/[,;\s]+/).filter(Boolean),
          links: $("#ne-links").value.split("\n").map((l) => l.trim()).filter(Boolean),
          source: "manual",
        },
      });
      showCreated(created);
      route();
    } catch (error) {
      $("#ne-error").textContent = error.message;
      $("#ne-error").hidden = false;
    }
  });
  modal.showModal();
}

function showCreated(created) {
  render(
    modal,
    html`<div class="dialog-body">
      <div class="dialog-head"><h2>Tracking is ready</h2><button class="close" data-action="close-modal" aria-label="Close">×</button></div>
      <div class="field">
        <label>Pixel HTML: paste it into the email's HTML body</label>
        <div class="copy-row"><code>${created.pixelHtml}</code><button class="btn small" data-copy="${created.pixelHtml}">Copy</button></div>
      </div>
      <div class="field">
        <label>Or insert an image from this URL</label>
        <div class="copy-row"><code>${created.pixelUrl}</code><button class="btn small" data-copy="${created.pixelUrl}">Copy</button></div>
      </div>
      ${created.links.length
        ? html`<div class="field"><label>Use these links in place of the originals</label>${created.links.map((l) =>
            l.trackedUrl
              ? html`<div class="copy-row"><code title="${l.url}">${l.trackedUrl}</code><button class="btn small" data-copy="${l.trackedUrl}">Copy</button></div>`
              : html`<p class="error">Not trackable (http/https only): ${l.url}</p>`,
          )}</div>`
        : ""}
      <p class="note">Don't open the email yourself in the first ${state.me.senderGraceSeconds} seconds after sending, or turn off image loading while you check it. Otherwise your own view can count as an open.</p>
      <div><button class="btn" data-action="close-modal">Done</button></div>
    </div>`,
  );
}

modal.addEventListener("click", (event) => {
  if (event.target === modal || event.target.closest("[data-action=close-modal]")) modal.close();
});

document.addEventListener("click", (event) => {
  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) copy(copyButton.dataset.copy, copyButton);
  if (event.target.closest("[data-action=new-email]")) openNewEmail();
});

// ---------- live updates ----------

let refreshTimer;
function onTrackingEvent(ev) {
  toast(`${ev.type === "open" ? "Opened" : "Link clicked"}: “${ev.subject || "(no subject)"}” · ${ev.client}`);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (state.page === "overview") renderOverview();
    else loadEmails();
    if (state.openEmailId === ev.emailId) openEmail(ev.emailId);
  }, 800);
}

async function connectLive() {
  state.liveAbort?.abort();
  const controller = new AbortController();
  state.liveAbort = controller;
  const dot = $("#live-dot");

  while (!controller.signal.aborted) {
    try {
      const res = await fetch("/api/live", { headers: { Authorization: `Bearer ${state.apiKey}` }, signal: controller.signal });
      if (!res.ok) throw new Error(`live ${res.status}`);
      dot.classList.add("on");
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const message = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = message.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("\n");
          if (data) onTrackingEvent(JSON.parse(data));
        }
      }
    } catch {
      if (controller.signal.aborted) return;
    }
    dot.classList.remove("on");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

boot();
