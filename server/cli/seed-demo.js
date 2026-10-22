// Fills the database with a month of realistic demo data for trying the dashboard.
import { randomBytes } from "node:crypto";
import { createUser } from "../auth.js";
import { loadConfig } from "../config.js";
import { openDatabase, transaction } from "../db.js";

const db = openDatabase(loadConfig().databasePath);
const email = `demo-${randomBytes(3).toString("hex")}@example.com`;
const { id: userId, apiKey } = createUser(db, { email, name: "Demo" });

const subjects = [
  "Proposal for Q4 partnership", "Quick follow-up on our call", "Invoice #1042", "Updated pricing",
  "Contract draft for review", "Intro: design team", "Demo recording", "Meeting notes",
  "Re: onboarding timeline", "Your trial ends Friday", "Case study you asked for", "Next steps",
];
const people = ["ana@client.com", "bo@shop.io", "cy@corp.com", "dee@agency.co", "eli@startup.dev", "fay@bigco.com", "gus@studio.art"];
const links = ["https://example.com/pricing", "https://example.com/demo", "https://calendly.com/you/30min", "https://example.com/case-study"];
const readers = [
  ["Gmail", "Unknown", "unknown", 0.45],
  ["Apple Mail", "iOS", "mobile", 0.2],
  ["Outlook", "Windows", "desktop", 0.15],
  ["Apple Mail", "macOS", "desktop", 0.1],
  ["Chrome", "Android", "mobile", 0.1],
];

let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = (list) => list[Math.floor(random() * list.length)];
const pickReader = () => {
  let r = random();
  for (const reader of readers) if ((r -= reader[3]) <= 0) return reader;
  return readers[0];
};

const insertEmail = db.prepare("INSERT INTO emails (id, user_id, token, subject, recipients, source, sent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const insertLink = db.prepare("INSERT INTO links (email_id, position, url) VALUES (?, ?, ?)");
const insertEvent = db.prepare("INSERT INTO events (email_id, link_id, type, occurred_at, client, os, device, ignored_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");

const now = Date.now();
let count = 0;
transaction(db, () => {
  for (let day = 29; day >= 0; day--) {
    const perDay = Math.floor(random() * 4) + (day % 7 < 5 ? 2 : 0);
    for (let i = 0; i < perDay; i++) {
      const sent = new Date(now - day * 86_400_000 - random() * 8 * 3_600_000);
      if (sent > now) continue;
      const id = randomBytes(9).toString("base64url");
      const recipients = random() < 0.8 ? [pick(people)] : [pick(people), pick(people)];
      insertEmail.run(id, userId, randomBytes(18).toString("base64url"), pick(subjects), JSON.stringify([...new Set(recipients)]), "gmail-extension", sent.toISOString(), sent.toISOString());
      insertEvent.run(id, null, "open", new Date(sent.getTime() + 5_000).toISOString(), "Gmail", "Unknown", "unknown", "sender");
      count++;

      const linkIds = random() < 0.5 ? [Number(insertLink.run(id, 0, pick(links)).lastInsertRowid)] : [];
      if (random() < 0.32) continue; // never opened

      // Opens cluster in working hours, a few minutes to a day after sending.
      let at = sent.getTime() + (random() < 0.6 ? random() * 3_600_000 : random() * 86_400_000);
      const opens = 1 + Math.floor(random() * random() * 5);
      const reader = pickReader();
      for (let o = 0; o < opens && at < now; o++) {
        insertEvent.run(id, null, "open", new Date(at).toISOString(), reader[0], reader[1], reader[2], null);
        at += random() * 20 * 3_600_000;
      }
      if (linkIds.length && random() < 0.45) {
        const clickAt = Math.min(now - 60_000, sent.getTime() + random() * 30 * 3_600_000);
        const [client, os, device] = reader[2] === "unknown" ? ["Chrome", "Windows", "desktop"] : [reader[0] === "Apple Mail" ? "Safari" : reader[0], reader[1], reader[2]];
        insertEvent.run(id, linkIds[0], "click", new Date(clickAt).toISOString(), client, os, device, null);
      }
    }
  }
});

console.log(`Seeded ${count} demo emails for ${email}.`);
console.log(`API key:\n\n  ${apiKey}\n`);
