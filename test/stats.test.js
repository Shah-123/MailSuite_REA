import assert from "node:assert/strict";
import { test } from "node:test";
import { createUser } from "../server/auth.js";
import { openDatabase } from "../server/db.js";
import { computeStats } from "../server/stats.js";

function seed() {
  const db = openDatabase(":memory:");
  const { id: userId } = createUser(db, { email: "me@example.com" });
  const { id: otherId } = createUser(db, { email: "other@example.com" });
  const email = (id, user, sentAt, recipients) =>
    db
      .prepare("INSERT INTO emails (id, user_id, token, subject, recipients, source, sent_at, created_at) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)")
      .run(id, user, `tok-${id}`, `Subject ${id}`, JSON.stringify(recipients), sentAt, sentAt);
  const event = (emailId, type, at, { client = "Gmail", device = "unknown", linkId = null, ignored = null } = {}) =>
    db
      .prepare("INSERT INTO events (email_id, link_id, type, occurred_at, client, os, device, ignored_reason) VALUES (?, ?, ?, ?, ?, 'Unknown', ?, ?)")
      .run(emailId, linkId, type, at, client, device, ignored);

  email("a", userId, "2026-10-20T08:00:00.000Z", ["ana@client.com"]);
  email("b", userId, "2026-10-21T08:00:00.000Z", ["ana@client.com", "bo@shop.com"]);
  email("c", userId, "2026-10-21T09:00:00.000Z", ["cy@corp.com"]);
  email("old", userId, "2026-08-01T08:00:00.000Z", ["ana@client.com"]);
  email("x", otherId, "2026-10-21T08:00:00.000Z", ["ana@client.com"]);
  const { lastInsertRowid: linkId } = db.prepare("INSERT INTO links (email_id, position, url) VALUES ('b', 0, 'https://example.com/demo')").run();

  event("a", "open", "2026-10-20T08:30:00.000Z");
  event("a", "open", "2026-10-21T23:30:00.000Z", { client: "Apple Mail", device: "mobile" });
  event("b", "click", "2026-10-21T10:00:00.000Z", { client: "Safari", device: "desktop", linkId: Number(linkId) });
  event("c", "open", "2026-10-21T09:00:05.000Z", { ignored: "sender" });
  event("x", "open", "2026-10-21T09:00:00.000Z");
  return { db, userId };
}

test("totals count emails sent in range and their opens and clicks", () => {
  const { db, userId } = seed();
  const { totals } = computeStats(db, userId, { days: 7, now: new Date("2026-10-22T12:00:00Z") });
  assert.deepEqual(
    { ...totals, avgMinutesToOpen: Math.round(totals.avgMinutesToOpen) },
    {
      sent: 3,
      opened: 2,
      unopened: 1,
      clicked: 1,
      opens: 2,
      clicks: 1,
      openRate: 2 / 3,
      clickRate: 1 / 3,
      // a: 30 min to first open; b: 120 min to first click.
      avgMinutesToOpen: 75,
    },
  );
});

test("daily series and heatmap follow the viewer's timezone", () => {
  const { db, userId } = seed();
  const utc = computeStats(db, userId, { days: 3, now: new Date("2026-10-22T12:00:00Z") });
  assert.deepEqual(utc.daily, [
    { date: "2026-10-20", sent: 1, opens: 1, clicks: 0 },
    { date: "2026-10-21", sent: 2, opens: 1, clicks: 1 },
    { date: "2026-10-22", sent: 0, opens: 0, clicks: 0 },
  ]);
  assert.equal(utc.heatmap[3][23], 1); // Wednesday 23:30 UTC

  // UTC+2: the 23:30 UTC open lands on Thursday 01:30.
  const plusTwo = computeStats(db, userId, { days: 3, tzOffset: 120, now: new Date("2026-10-22T12:00:00Z") });
  assert.equal(plusTwo.heatmap[4][1], 1);
  assert.deepEqual(
    plusTwo.daily.map((d) => [d.date, d.opens]),
    [
      ["2026-10-20", 1],
      ["2026-10-21", 0],
      ["2026-10-22", 1],
    ],
  );
});

test("breakdowns, top links and recipients", () => {
  const { db, userId } = seed();
  const stats = computeStats(db, userId, { days: 7, now: new Date("2026-10-22T12:00:00Z") });
  assert.deepEqual(stats.clients, [
    { label: "Apple Mail", count: 1 },
    { label: "Gmail", count: 1 },
  ]);
  assert.deepEqual(
    stats.devices.map((d) => d.label).sort(),
    ["desktop", "mobile", "unknown"],
  );
  assert.deepEqual(stats.topLinks, [{ url: "https://example.com/demo", clicks: 1, emails: 1 }]);
  assert.deepEqual(stats.topRecipients, [
    { recipient: "ana@client.com", sent: 2, opened: 2 },
    { recipient: "bo@shop.com", sent: 1, opened: 1 },
    { recipient: "cy@corp.com", sent: 1, opened: 0 },
  ]);
});
