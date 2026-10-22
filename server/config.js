import { randomBytes } from "node:crypto";

// All settings come from the environment so the same build runs locally,
// in Docker and on a PaaS.
export function loadConfig(env = process.env) {
  const port = Number(env.PORT ?? 3000);
  return {
    port,
    // Recipients' mail clients fetch the pixel from here, so in production
    // it must be a public HTTPS origin (not localhost).
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    databasePath: env.DATABASE_PATH ?? "data/tracker.db",
    // Opens this soon after an email is registered are the sender's own
    // Gmail rendering the sent message, not the recipient.
    senderGraceSeconds: Number(env.SENDER_GRACE_SECONDS ?? 30),
    // Repeat loads from the same client inside this window count once.
    dedupeSeconds: Number(env.DEDUPE_SECONDS ?? 60),
    // Salt for hashing IP addresses; raw IPs are never stored.
    ipSalt: env.IP_SALT ?? randomBytes(16).toString("hex"),
    trustProxy: env.TRUST_PROXY ?? false,
  };
}
