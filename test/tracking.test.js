import assert from "node:assert/strict";
import { test } from "node:test";
import { GMAIL_PROXY_UA, IPHONE_SAFARI_UA, startServer } from "./helpers.js";

async function registerEmail(api, body = {}) {
  const res = await api("/emails", { method: "POST", body: { subject: "Proposal", recipients: ["ana@client.com"], ...body } });
  assert.equal(res.status, 201);
  return res.body;
}

test("pixel is an uncacheable GIF, even for unknown tokens", async (t) => {
  const { baseUrl, fetchAs } = await startServer(t);
  const res = await fetchAs(GMAIL_PROXY_UA, `${baseUrl}/t/o/doesnotexist.gif`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/gif");
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 6).toString(), "GIF89a");
});

test("records opens, collapsing repeats from the same client", async (t) => {
  const { newUser, fetchAs } = await startServer(t, { dedupeSeconds: 60 });
  const api = newUser();
  const { id, pixelUrl } = await registerEmail(api);

  await fetchAs(GMAIL_PROXY_UA, pixelUrl);
  await fetchAs(GMAIL_PROXY_UA, pixelUrl);
  await fetchAs(IPHONE_SAFARI_UA, pixelUrl);

  const { body } = await api(`/emails/${id}`);
  assert.deepEqual(
    body.events.map((e) => [e.type, e.client, e.ignoredReason]),
    [
      ["open", "Gmail", null],
      ["open", "Safari", null],
    ],
  );
});

test("ignores the sender's own view right after sending and automated fetches", async (t) => {
  const { newUser, fetchAs } = await startServer(t, { senderGraceSeconds: 30 });
  const api = newUser();
  const { id, pixelUrl } = await registerEmail(api);

  await fetchAs(GMAIL_PROXY_UA, pixelUrl);
  await fetchAs("curl/8.5.0", pixelUrl);

  const detail = await api(`/emails/${id}`);
  assert.deepEqual(
    detail.body.events.map((e) => e.ignoredReason),
    ["sender", "automated"],
  );
  const list = await api("/emails");
  assert.equal(list.body.items[0].opens, 0);
  assert.equal(list.body.items[0].status, "sent");
});

test("click links redirect to the original URL and are counted", async (t) => {
  const { newUser, fetchAs } = await startServer(t);
  const api = newUser();
  const { id, links } = await registerEmail(api, { links: ["https://example.com/pricing?a=1", "mailto:ana@client.com", "javascript:alert(1)"] });

  assert.equal(links[1].trackedUrl, null);
  assert.equal(links[2].trackedUrl, null);

  const res = await fetchAs(IPHONE_SAFARI_UA, links[0].trackedUrl);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://example.com/pricing?a=1");

  const missing = await fetchAs(IPHONE_SAFARI_UA, links[0].trackedUrl.replace(/\/0$/, "/1"));
  assert.equal(missing.status, 404);

  const { body } = await api(`/emails/${id}`);
  assert.deepEqual(body.links, [{ position: 0, url: "https://example.com/pricing?a=1", clicks: 1 }]);
  assert.equal(body.events[0].device, "mobile");

  const list = await api("/emails");
  assert.equal(list.body.items[0].status, "clicked");
});
