import { createHash } from "node:crypto";
import { Router } from "express";
import { classifyUserAgent } from "./user-agent.js";

// 1x1 transparent GIF.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

// Public endpoints hit by recipients' mail clients: the open pixel and the
// click redirect. They never reveal whether a token exists.
export function trackingRouter({ db, config, live }) {
  const router = Router();
  const findEmail = db.prepare("SELECT id, user_id, subject, created_at FROM emails WHERE token = ?");
  const findLink = db.prepare("SELECT id, url FROM links WHERE email_id = ? AND position = ?");
  const findDuplicate = db.prepare(`
    SELECT 1 FROM events
    WHERE email_id = ? AND type = ? AND link_id IS ? AND ip_hash IS ? AND user_agent IS ?
      AND ignored_reason IS NULL AND occurred_at >= ?
    LIMIT 1`);
  const insertEvent = db.prepare(`
    INSERT INTO events (email_id, link_id, type, occurred_at, ip_hash, user_agent, client, os, device, ignored_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function record(req, email, type, link = null) {
    const now = new Date();
    const userAgent = req.get("user-agent") ?? "";
    const ipHash = req.ip ? createHash("sha256").update(config.ipSalt + req.ip).digest("hex").slice(0, 32) : null;
    const { client, os, device, automated } = classifyUserAgent(userAgent);

    let ignoredReason = null;
    if (automated) ignoredReason = "automated";
    else if (type === "open" && now - Date.parse(email.created_at) < config.senderGraceSeconds * 1000) ignoredReason = "sender";

    if (!ignoredReason) {
      const since = new Date(now - config.dedupeSeconds * 1000).toISOString();
      if (findDuplicate.get(email.id, type, link?.id ?? null, ipHash, userAgent, since)) return;
    }

    const occurredAt = now.toISOString();
    insertEvent.run(email.id, link?.id ?? null, type, occurredAt, ipHash, userAgent, client, os, device, ignoredReason);
    if (!ignoredReason) {
      live.publish(email.user_id, {
        type,
        emailId: email.id,
        subject: email.subject,
        linkUrl: link?.url ?? null,
        client,
        os,
        device,
        occurredAt,
      });
    }
  }

  router.get("/t/o/:token.gif", (req, res) => {
    const email = findEmail.get(req.params.token);
    if (email) record(req, email, "open");
    res.set({ ...NO_CACHE, "Content-Type": "image/gif", "Content-Length": PIXEL.length }).end(PIXEL);
  });

  router.get("/t/c/:token/:position", (req, res) => {
    const email = findEmail.get(req.params.token);
    const link = email && findLink.get(email.id, Number(req.params.position));
    if (!link) return res.status(404).set(NO_CACHE).type("text/plain").send("This link is no longer available.");
    record(req, email, "click", link);
    res.set(NO_CACHE).redirect(302, link.url);
  });

  return router;
}
