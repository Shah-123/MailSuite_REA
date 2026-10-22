import { createHash, randomBytes } from "node:crypto";

export function hashApiKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

// Creates a user and returns the plaintext API key, which is shown once and
// only its hash is stored.
export function createUser(db, { email, name = null }) {
  const apiKey = `mt_${randomBytes(24).toString("base64url")}`;
  const { lastInsertRowid } = db
    .prepare("INSERT INTO users (email, name, api_key_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(email.trim().toLowerCase(), name, hashApiKey(apiKey), new Date().toISOString());
  return { id: Number(lastInsertRowid), email, apiKey };
}

export function requireUser(db) {
  const findUser = db.prepare("SELECT id, email, name FROM users WHERE api_key_hash = ?");
  return (req, res, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") ?? "");
    const user = match && findUser.get(hashApiKey(match[1]));
    if (!user) return res.status(401).json({ error: "Missing or invalid API key" });
    req.user = user;
    next();
  };
}
