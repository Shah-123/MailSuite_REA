import { createUser } from "../server/auth.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { openDatabase } from "../server/db.js";

export const GMAIL_PROXY_UA = "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";
export const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// Starts the app on an ephemeral port with an in-memory database.
export async function startServer(t, overrides = {}) {
  const db = openDatabase(":memory:");
  const config = { ...loadConfig({}), senderGraceSeconds: 0, ...overrides };
  const server = createApp({ db, config }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = baseUrl;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const api = (key) => async (path, { method = "GET", body } = {}) => {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  };

  return {
    db,
    config,
    baseUrl,
    newUser(email = `user${Math.random().toString(36).slice(2)}@example.com`) {
      return api(createUser(db, { email }).apiKey);
    },
    fetchAs(userAgent, url, init = {}) {
      return fetch(url, { redirect: "manual", ...init, headers: { "User-Agent": userAgent, ...init.headers } });
    },
  };
}
