// Dashboard analytics. Day and hour buckets use the viewer's timezone offset
// (minutes east of UTC) so "opens at 9am" means 9am for the viewer.

const DAY_MS = 86_400_000;

export function computeStats(db, userId, { days = 30, tzOffset = 0, now = new Date() } = {}) {
  const modifier = `${tzOffset >= 0 ? "+" : ""}${tzOffset} minutes`;
  const localNow = new Date(now.getTime() + tzOffset * 60_000);
  const localStart = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - (days - 1) * DAY_MS;
  const from = new Date(localStart - tzOffset * 60_000).toISOString();

  const rangeEmails = `SELECT id, sent_at FROM emails WHERE user_id = :user AND sent_at >= :from`;
  const userEvents = `
    SELECT ev.* FROM events ev JOIN emails e ON e.id = ev.email_id
    WHERE e.user_id = :user AND ev.ignored_reason IS NULL AND ev.occurred_at >= :from`;
  const params = { user: userId, from, mod: modifier };

  const totals = db
    .prepare(
      `WITH e AS (${rangeEmails}),
            ev AS (SELECT email_id, type, occurred_at FROM events
                   WHERE ignored_reason IS NULL AND email_id IN (SELECT id FROM e)),
            first_open AS (SELECT e.sent_at, MIN(ev.occurred_at) AS at FROM e JOIN ev ON ev.email_id = e.id GROUP BY e.id)
       SELECT (SELECT COUNT(*) FROM e) AS sent,
              (SELECT COUNT(DISTINCT email_id) FROM ev) AS opened,
              (SELECT COUNT(DISTINCT email_id) FROM ev WHERE type = 'click') AS clicked,
              (SELECT COUNT(*) FROM ev WHERE type = 'open') AS opens,
              (SELECT COUNT(*) FROM ev WHERE type = 'click') AS clicks,
              (SELECT AVG((julianday(at) - julianday(sent_at)) * 1440) FROM first_open) AS avg_minutes_to_open`,
    )
    .get({ user: userId, from });

  const daily = new Map();
  for (let i = 0; i < days; i++) {
    const date = new Date(localStart + i * DAY_MS).toISOString().slice(0, 10);
    daily.set(date, { date, sent: 0, opens: 0, clicks: 0 });
  }
  for (const row of db
    .prepare(`SELECT date(sent_at, :mod) AS day, COUNT(*) AS n FROM (${rangeEmails}) GROUP BY day`)
    .all(params)) {
    if (daily.has(row.day)) daily.get(row.day).sent = row.n;
  }
  for (const row of db
    .prepare(`SELECT date(occurred_at, :mod) AS day, type, COUNT(*) AS n FROM (${userEvents}) GROUP BY day, type`)
    .all(params)) {
    if (daily.has(row.day)) daily.get(row.day)[row.type === "open" ? "opens" : "clicks"] = row.n;
  }

  // heatmap[weekday][hour], weekday 0 = Sunday.
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const row of db
    .prepare(
      `SELECT CAST(strftime('%w', occurred_at, :mod) AS INTEGER) AS weekday,
              CAST(strftime('%H', occurred_at, :mod) AS INTEGER) AS hour, COUNT(*) AS n
       FROM (${userEvents}) WHERE type = 'open' GROUP BY weekday, hour`,
    )
    .all(params)) {
    heatmap[row.weekday][row.hour] = row.n;
  }

  // Webmail proxies hide the reader's device on opens; clicks reveal it.
  const breakdown = (column, types) =>
    db
      .prepare(
        `SELECT ${column} AS label, COUNT(*) AS count FROM (${userEvents})
         WHERE type IN (${types.map((t) => `'${t}'`).join(", ")}) GROUP BY ${column} ORDER BY count DESC, label`,
      )
      .all({ user: userId, from })
      .map(({ label, count }) => ({ label, count }));

  const topLinks = db
    .prepare(
      `SELECT l.url, COUNT(*) AS clicks, COUNT(DISTINCT l.email_id) AS emails
       FROM (${userEvents}) ev JOIN links l ON l.id = ev.link_id
       WHERE ev.type = 'click' GROUP BY l.url ORDER BY clicks DESC LIMIT 10`,
    )
    .all({ user: userId, from })
    .map(({ url, clicks, emails }) => ({ url, clicks, emails }));

  const topRecipients = db
    .prepare(
      `SELECT r.value AS recipient, COUNT(DISTINCT e.id) AS sent,
              COUNT(DISTINCT CASE WHEN ev.id IS NOT NULL THEN e.id END) AS opened
       FROM emails e
       JOIN json_each(e.recipients) r
       LEFT JOIN events ev ON ev.email_id = e.id AND ev.ignored_reason IS NULL
       WHERE e.user_id = :user AND e.sent_at >= :from
       GROUP BY r.value ORDER BY sent DESC, opened DESC LIMIT 10`,
    )
    .all({ user: userId, from })
    .map(({ recipient, sent, opened }) => ({ recipient, sent, opened }));

  const rate = (n) => (totals.sent ? n / totals.sent : 0);
  return {
    range: { from, days, tzOffset },
    totals: {
      sent: totals.sent,
      opened: totals.opened,
      unopened: totals.sent - totals.opened,
      clicked: totals.clicked,
      opens: totals.opens,
      clicks: totals.clicks,
      openRate: rate(totals.opened),
      clickRate: rate(totals.clicked),
      avgMinutesToOpen: totals.avg_minutes_to_open,
    },
    daily: [...daily.values()],
    heatmap,
    clients: breakdown("client", ["open"]),
    devices: breakdown("device", ["open", "click"]),
    topLinks,
    topRecipients,
  };
}
