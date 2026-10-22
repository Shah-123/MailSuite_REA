import { randomBytes } from "node:crypto";
import express, { Router } from "express";
import { requireUser } from "./auth.js";
import { transaction } from "./db.js";
import { computeStats } from "./stats.js";

const MAX_LINKS = 200;
const MAX_RECIPIENTS = 500;

export function apiRouter({ db, config, live }) {
  const router = Router();
  router.use(express.json({ limit: "256kb" }));
  router.use(requireUser(db));

  const insertEmail = db.prepare(`
    INSERT INTO emails (id, user_id, token, subject, recipients, source, sent_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertLink = db.prepare("INSERT INTO links (email_id, position, url) VALUES (?, ?, ?)");
  const findEmail = db.prepare("SELECT * FROM emails WHERE id = ? AND user_id = ?");
  const deleteEmail = db.prepare("DELETE FROM emails WHERE id = ? AND user_id = ?");
  const emailLinks = db.prepare(`
    SELECT l.position, l.url, COUNT(ev.id) AS clicks
    FROM links l LEFT JOIN events ev ON ev.link_id = l.id AND ev.ignored_reason IS NULL
    WHERE l.email_id = ? GROUP BY l.id ORDER BY l.position`);
  const emailEvents = db.prepare(`
    SELECT ev.type, ev.occurred_at, ev.client, ev.os, ev.device, ev.ignored_reason, l.url AS link_url
    FROM events ev LEFT JOIN links l ON l.id = ev.link_id
    WHERE ev.email_id = ? ORDER BY ev.occurred_at`);
  const listEmails = db.prepare(`
    SELECT * , COUNT(*) OVER () AS total FROM (
      SELECT e.id, e.subject, e.recipients, e.source, e.sent_at,
             COUNT(CASE WHEN ev.type = 'open' THEN 1 END) AS opens,
             COUNT(CASE WHEN ev.type = 'click' THEN 1 END) AS clicks,
             MIN(CASE WHEN ev.type = 'open' THEN ev.occurred_at END) AS first_opened_at,
             MAX(ev.occurred_at) AS last_activity_at
      FROM emails e LEFT JOIN events ev ON ev.email_id = e.id AND ev.ignored_reason IS NULL
      WHERE e.user_id = :user
        AND (:query = '' OR e.subject LIKE :pattern ESCAPE '\\' OR e.recipients LIKE :pattern ESCAPE '\\')
      GROUP BY e.id
    )
    WHERE CASE :status
      WHEN 'opened' THEN opens + clicks > 0
      WHEN 'unopened' THEN opens + clicks = 0
      WHEN 'clicked' THEN clicks > 0
      ELSE 1 END
    ORDER BY sent_at DESC
    LIMIT :limit OFFSET :offset`);
  const activity = db.prepare(`
    SELECT ev.type, ev.occurred_at, ev.client, ev.os, ev.device, e.id AS email_id, e.subject, e.recipients, l.url AS link_url
    FROM events ev JOIN emails e ON e.id = ev.email_id LEFT JOIN links l ON l.id = ev.link_id
    WHERE e.user_id = ? AND ev.ignored_reason IS NULL AND ev.occurred_at > ?
    ORDER BY ev.occurred_at DESC LIMIT ?`);

  router.get("/me", (req, res) => {
    res.json({ email: req.user.email, name: req.user.name, publicUrl: config.publicUrl, senderGraceSeconds: config.senderGraceSeconds });
  });

  // Registers an email just before it is sent and returns the pixel and
  // tracked link URLs to put in its body.
  router.post("/emails", (req, res) => {
    const { subject = "", recipients = [], links = [], source = "manual", sentAt } = req.body ?? {};
    if (typeof subject !== "string" || subject.length > 998) return badRequest(res, "subject must be a string up to 998 characters");
    if (!Array.isArray(recipients) || recipients.length > MAX_RECIPIENTS || !recipients.every((r) => typeof r === "string" && r.length <= 320)) {
      return badRequest(res, `recipients must be an array of up to ${MAX_RECIPIENTS} strings`);
    }
    if (!Array.isArray(links) || links.length > MAX_LINKS || !links.every((l) => typeof l === "string")) {
      return badRequest(res, `links must be an array of up to ${MAX_LINKS} strings`);
    }
    if (!["gmail-extension", "manual"].includes(source)) return badRequest(res, "source must be gmail-extension or manual");
    const sent = sentAt === undefined ? new Date() : new Date(sentAt);
    if (Number.isNaN(sent.getTime())) return badRequest(res, "sentAt must be an ISO date");

    const id = randomBytes(9).toString("base64url");
    const token = randomBytes(18).toString("base64url");
    const now = new Date().toISOString();
    const cleanRecipients = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))];

    const trackedLinks = transaction(db, () => {
      insertEmail.run(id, req.user.id, token, subject.trim(), JSON.stringify(cleanRecipients), source, sent.toISOString(), now);
      return links.map((url, position) => {
        if (!isTrackableUrl(url)) return { position, url, trackedUrl: null };
        insertLink.run(id, position, url);
        return { position, url, trackedUrl: `${config.publicUrl}/t/c/${token}/${position}` };
      });
    });

    const pixelUrl = `${config.publicUrl}/t/o/${token}.gif`;
    res.status(201).json({
      id,
      pixelUrl,
      pixelHtml: `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0">`,
      links: trackedLinks,
    });
  });

  router.get("/emails", (req, res) => {
    const query = String(req.query.q ?? "").trim();
    const rows = listEmails.all({
      user: req.user.id,
      query,
      pattern: `%${query.replace(/[\\%_]/g, "\\$&")}%`,
      status: String(req.query.status ?? "all"),
      limit: clampInt(req.query.limit, 1, 200, 50),
      offset: clampInt(req.query.offset, 0, Number.MAX_SAFE_INTEGER, 0),
    });
    res.json({
      total: rows[0]?.total ?? 0,
      items: rows.map((row) => ({
        id: row.id,
        subject: row.subject,
        recipients: JSON.parse(row.recipients),
        source: row.source,
        sentAt: row.sent_at,
        opens: row.opens,
        clicks: row.clicks,
        firstOpenedAt: row.first_opened_at,
        lastActivityAt: row.last_activity_at,
        status: row.clicks > 0 ? "clicked" : row.opens > 0 ? "opened" : "sent",
      })),
    });
  });

  router.get("/emails/:id", (req, res) => {
    const email = findEmail.get(req.params.id, req.user.id);
    if (!email) return res.status(404).json({ error: "Email not found" });
    res.json({
      id: email.id,
      subject: email.subject,
      recipients: JSON.parse(email.recipients),
      source: email.source,
      sentAt: email.sent_at,
      pixelUrl: `${config.publicUrl}/t/o/${email.token}.gif`,
      links: emailLinks.all(email.id).map(({ position, url, clicks }) => ({ position, url, clicks })),
      events: emailEvents.all(email.id).map((ev) => ({
        type: ev.type,
        occurredAt: ev.occurred_at,
        client: ev.client,
        os: ev.os,
        device: ev.device,
        linkUrl: ev.link_url,
        ignoredReason: ev.ignored_reason,
      })),
    });
  });

  router.delete("/emails/:id", (req, res) => {
    const { changes } = deleteEmail.run(req.params.id, req.user.id);
    if (!changes) return res.status(404).json({ error: "Email not found" });
    res.status(204).end();
  });

  router.get("/stats", (req, res) => {
    res.json(
      computeStats(db, req.user.id, {
        days: clampInt(req.query.days, 1, 365, 30),
        tzOffset: clampInt(req.query.tzOffset, -840, 840, 0),
      }),
    );
  });

  // Recent opens and clicks, newest first. `since` lets the extension poll for
  // new events to notify about.
  router.get("/activity", (req, res) => {
    const since = req.query.since ? new Date(String(req.query.since)) : new Date(0);
    if (Number.isNaN(since.getTime())) return badRequest(res, "since must be an ISO date");
    const rows = activity.all(req.user.id, since.toISOString(), clampInt(req.query.limit, 1, 200, 50));
    res.json({
      items: rows.map((row) => ({
        type: row.type,
        occurredAt: row.occurred_at,
        client: row.client,
        os: row.os,
        device: row.device,
        emailId: row.email_id,
        subject: row.subject,
        recipients: JSON.parse(row.recipients),
        linkUrl: row.link_url,
      })),
    });
  });

  router.get("/live", (req, res) => live.subscribe(req.user.id, res));

  return router;
}

function isTrackableUrl(value) {
  if (value.length > 4096) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

function badRequest(res, error) {
  return res.status(400).json({ error });
}
