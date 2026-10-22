import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";

const config = loadConfig();
const db = openDatabase(config.databasePath);
const app = createApp({ db, config });

app.listen(config.port, () => {
  console.log(`Mail tracker listening on :${config.port}`);
  console.log(`Tracking URLs use ${config.publicUrl}`);
  if (/localhost|127\.0\.0\.1/.test(config.publicUrl)) {
    console.log("PUBLIC_URL is local: recipients' mail clients can't reach it. Set PUBLIC_URL to a public HTTPS URL.");
  }
});
