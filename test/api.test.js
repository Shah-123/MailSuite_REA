import assert from "node:assert/strict";
import { test } from "node:test";
import { GMAIL_PROXY_UA, startServer } from "./helpers.js";

test("rejects requests without a valid API key", async (t) => {
  const { baseUrl } = await startServer(t);
  assert.equal((await fetch(`${baseUrl}/api/emails`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/emails`, { headers: { Authorization: "Bearer mt_wrong" } })).status, 401);
});

test("answers CORS preflight for the extension", async (t) => {
  const { baseUrl } = await startServer(t);
  const res = await fetch(`${baseUrl}/api/emails`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers"), /Authorization/);
});

test("validates new emails", async (t) => {
  const api = (await startServer(t)).newUser();
  assert.equal((await api("/emails", { method: "POST", body: { recipients: "ana@client.com" } })).status, 400);
  assert.equal((await api("/emails", { method: "POST", body: { links: [42] } })).status, 400);
  assert.equal((await api("/emails", { method: "POST", body: { source: "spam-cannon" } })).status, 400);
  assert.equal((await api("/emails", { method: "POST", body: { sentAt: "not a date" } })).status, 400);
});

test("keeps each user's emails private", async (t) => {
  const server = await startServer(t);
  const alice = server.newUser();
  const bob = server.newUser();
  const { body } = await alice("/emails", { method: "POST", body: { subject: "Alice only" } });

  assert.equal((await bob(`/emails/${body.id}`)).status, 404);
  assert.equal((await bob(`/emails/${body.id}`, { method: "DELETE" })).status, 404);
  assert.equal((await bob("/emails")).body.total, 0);
  assert.equal((await alice("/emails")).body.total, 1);
});

test("filters and searches the email list", async (t) => {
  const { newUser, fetchAs } = await startServer(t);
  const api = newUser();
  const opened = await api("/emails", { method: "POST", body: { subject: "Q3 proposal", recipients: ["ana@client.com"] } });
  await api("/emails", { method: "POST", body: { subject: "100% discount", recipients: ["bo@shop.com"] } });
  await fetchAs(GMAIL_PROXY_UA, opened.body.pixelUrl);

  const subjects = async (query) => (await api(`/emails?${query}`)).body.items.map((e) => e.subject);
  assert.deepEqual(await subjects("status=opened"), ["Q3 proposal"]);
  assert.deepEqual(await subjects("status=unopened"), ["100% discount"]);
  assert.deepEqual(await subjects("status=clicked"), []);
  assert.deepEqual(await subjects("q=ana%40client"), ["Q3 proposal"]);
  assert.deepEqual(await subjects("q=100%25"), ["100% discount"]);
  assert.deepEqual(await subjects("q=%25"), ["100% discount"]);

  const page = await api("/emails?limit=1&offset=1");
  assert.equal(page.body.total, 2);
  assert.equal(page.body.items.length, 1);
});

test("deleting an email removes its events", async (t) => {
  const { db, newUser, fetchAs } = await startServer(t);
  const api = newUser();
  const { body } = await api("/emails", { method: "POST", body: { subject: "Bye" } });
  await fetchAs(GMAIL_PROXY_UA, body.pixelUrl);

  assert.equal((await api(`/emails/${body.id}`, { method: "DELETE" })).status, 204);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 0);
});

test("activity feed returns new events since a timestamp", async (t) => {
  const { newUser, fetchAs } = await startServer(t);
  const api = newUser();
  const { body } = await api("/emails", { method: "POST", body: { subject: "Hello", recipients: ["ana@client.com"] } });
  const before = new Date(Date.now() - 1).toISOString();
  await fetchAs(GMAIL_PROXY_UA, body.pixelUrl);

  const feed = await api(`/activity?since=${encodeURIComponent(before)}`);
  assert.equal(feed.body.items.length, 1);
  assert.equal(feed.body.items[0].subject, "Hello");
  assert.deepEqual(feed.body.items[0].recipients, ["ana@client.com"]);

  const later = await api(`/activity?since=${encodeURIComponent(feed.body.items[0].occurredAt)}`);
  assert.equal(later.body.items.length, 0);
});
