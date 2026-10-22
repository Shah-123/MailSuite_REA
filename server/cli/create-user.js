import { createUser } from "../auth.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";

const [email, ...nameParts] = process.argv.slice(2);
if (!email || !email.includes("@")) {
  console.error("Usage: npm run create-user -- you@example.com [Your Name]");
  process.exit(1);
}

const db = openDatabase(loadConfig().databasePath);
try {
  const { apiKey } = createUser(db, { email, name: nameParts.join(" ") || null });
  console.log(`Created ${email}.`);
  console.log(`API key (shown once, paste it into the dashboard and the extension):\n\n  ${apiKey}\n`);
} catch (error) {
  if (String(error.message).includes("UNIQUE")) {
    console.error(`A user with email ${email} already exists.`);
    process.exit(1);
  }
  throw error;
}
