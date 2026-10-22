import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyUserAgent } from "../server/user-agent.js";
import { GMAIL_PROXY_UA, IPHONE_SAFARI_UA } from "./helpers.js";

test("classifies webmail image proxies", () => {
  assert.deepEqual(classifyUserAgent(GMAIL_PROXY_UA), { client: "Gmail", os: "Unknown", device: "unknown", automated: false });
  assert.equal(classifyUserAgent("Mozilla/5.0 (compatible; YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html)").client, "Yahoo Mail");
});

test("labels Apple Mail Privacy Protection preloads", () => {
  assert.equal(classifyUserAgent("Mozilla/5.0").client, "Apple Mail (Privacy Protection)");
});

test("detects mail apps, browsers, OS and device", () => {
  assert.deepEqual(classifyUserAgent(IPHONE_SAFARI_UA), { client: "Safari", os: "iOS", device: "mobile", automated: false });
  assert.deepEqual(
    classifyUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"),
    { client: "Apple Mail", os: "macOS", device: "desktop", automated: false },
  );
  assert.deepEqual(
    classifyUserAgent("Mozilla/4.0 (compatible; ms-office; MSOffice 16) Microsoft Outlook 16.0.17126; Windows NT 10.0"),
    { client: "Outlook", os: "Windows", device: "desktop", automated: false },
  );
  assert.equal(
    classifyUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36").device,
    "mobile",
  );
});

test("flags scanners, scripts and empty agents as automated", () => {
  for (const ua of ["", "curl/8.5.0", "python-requests/2.32", "Mozilla/5.0 (compatible; Googlebot/2.1)", "Barracuda Sentinel (EE)"]) {
    assert.equal(classifyUserAgent(ua).automated, true, ua);
  }
});
