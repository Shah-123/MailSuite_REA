import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { apiRouter } from "./api.js";
import { createLiveHub } from "./live.js";
import { trackingRouter } from "./tracking.js";

const here = dirname(fileURLToPath(import.meta.url));
const chartJsDist = join(dirname(createRequire(import.meta.url).resolve("chart.js")), "..", "dist");

export function createApp({ db, config, live = createLiveHub() }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", parseTrustProxy(config.trustProxy));

  app.use(trackingRouter({ db, config, live }));

  // The API authenticates with a bearer key, never cookies, so any origin
  // (the Gmail extension included) may call it.
  app.use("/api", (req, res, next) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    });
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
  app.use("/api", apiRouter({ db, config, live }));

  app.get("/healthz", (req, res) => res.json({ ok: true }));
  app.use("/vendor/chart.js", express.static(chartJsDist));
  app.use(express.static(join(here, "public")));

  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON body" });
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

function parseTrustProxy(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false" || value === "") return false;
  return /^\d+$/.test(String(value)) ? Number(value) : value;
}
