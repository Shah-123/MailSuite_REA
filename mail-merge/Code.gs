/**
 * CSC outreach mail merge for Google Sheets.
 *
 * Sends the personalised emails on the "Email drafts" sheet from your own
 * Gmail, up to DAILY_LIMIT per weekday, spread over the professors' morning.
 * It emails one professor per research group at a time, marks Status and
 * Date emailed on the "Professors" sheet, and spots replies and bounces.
 *
 * Setup: see README.md next to this file.
 */

const CONFIG = {
  // Google Drive link to your CV PDF (in Drive: Share → Copy link).
  CV_DRIVE_LINK: "",
  ATTACH_CV: true,
  SENDER_NAME: "Shahkar Ahmad Shah",
  DAILY_LIMIT: 40,
  // Professors' local time; sending happens on their weekday mornings.
  TIMEZONE: "Asia/Shanghai",
  SEND_WEEKDAYS: [1, 2, 3, 4, 5], // 1 = Monday … 7 = Sunday
  WINDOW_START_HOUR: 9,
  WINDOW_END_HOUR: 12,
  // Random pause between two emails in the same run.
  PAUSE_SECONDS: [10, 25],
  FIT_ORDER: ["Strong", "Good", "Moderate"],
  GMAIL_LABEL: "CSC outreach",
};

const SHEETS = { professors: "Professors", drafts: "Email drafts", log: "Send log", queue: "Next batch" };
const NOT_CONTACTED = "Not contacted";
// While a group-mate has one of these statuses, the rest of the group waits.
const ACTIVE_STATUSES = ["Emailed", "Follow-up sent", "Replied", "Interview", "Acceptance letter"];
const DEFAULT_STATUSES = ["Not contacted", "Emailed", "Follow-up sent", "Replied", "Interview", "Acceptance letter", "Declined", "No reply"];
const EXTRA_STATUSES = ["On hold", "Bounced"];
const LOG_HEADERS = ["Sent at", "#", "Name", "To", "Subject", "Thread ID", "Result", "Reply at"];
const TRIGGER_MINUTES = 30;
const MAX_RUN_MS = 4.5 * 60 * 1000; // Apps Script stops a run at 6 minutes.
const EMAIL_PATTERN = /^[^@\s,;]+@[^@\s,;]+\.[A-Za-z]{2,}$/;
const AUTO_REPLY_PATTERN = /auto(matic)?[\s-]*reply|out of (the )?office|自动回复|vacation/i;

// ---------- menu ----------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Mail merge")
    .addItem("1. Set up", "setup")
    .addItem("2. Send a test to myself", "sendTestToMe")
    .addItem("3. Preview next batch", "previewNextBatch")
    .addSeparator()
    .addItem("Start daily sending", "startSending")
    .addItem("Stop sending", "stopSending")
    .addSeparator()
    .addItem("Check for replies now", "checkRepliesNow")
    .addToUi();
}

function setup() {
  const data = loadData_();
  ensureLogSheet_(data.ss);
  extendStatusDropdown_(data.prof);
  if (CONFIG.ATTACH_CV) cvBlob_();
  gmailLabel_();
  const { stats } = pickBatch_(data.prof.rows, data.drafts.rows, readLog_(data.ss), CONFIG.DAILY_LIMIT, CONFIG.FIT_ORDER);
  SpreadsheetApp.getUi().alert(
    "Setup done",
    `${stats.notContacted} professors not contacted yet have an email address.\n` +
      `${stats.readyNow} can be emailed now; ${stats.waitingOnGroup} wait for a group-mate first.\n\n` +
      'Next: "Send a test to myself".',
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

function sendTestToMe() {
  const data = loadData_();
  const { batch } = pickBatch_(data.prof.rows, data.drafts.rows, readLog_(data.ss), 1, CONFIG.FIT_ORDER);
  const ui = SpreadsheetApp.getUi();
  if (!batch.length) return ui.alert("There is no professor left to email.");
  const me = Session.getEffectiveUser().getEmail();
  sendOne_(batch[0], CONFIG.ATTACH_CV ? cvBlob_() : null, null, me);
  ui.alert(
    `The email for ${batch[0].prof.name} was sent to you (${me}) with "[TEST]" in the subject.\n\n` +
      "Check the text, the attachment and how it looks on your phone. Nothing was marked as sent.",
  );
}

function previewNextBatch() {
  const data = loadData_();
  const { batch, stats } = pickBatch_(data.prof.rows, data.drafts.rows, readLog_(data.ss), CONFIG.DAILY_LIMIT, CONFIG.FIT_ORDER);
  const sheet = data.ss.getSheetByName(SHEETS.queue) || data.ss.insertSheet(SHEETS.queue);
  sheet.clear();
  const rows = [["#", "Name", "University / Institute", "Fit", "To", "Subject"]].concat(
    batch.map(({ prof, draft }) => [prof.id, prof.name, prof.university, prof.fit, draft.to, draft.subject]),
  );
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.getRange(1, 1, 1, rows[0].length).setFontWeight("bold");
  sheet.setFrozenRows(1);
  sheet.activate();
  SpreadsheetApp.getUi().alert(
    `These ${batch.length} emails go out next.\n\n` +
      'Edit a draft on "Email drafts" before it is sent, or set its Status to "On hold" on "Professors" to skip it.\n\n' +
      `${stats.readyNow} professors can be emailed now; ${stats.waitingOnGroup} wait for a group-mate first.`,
  );
}

function startSending() {
  const data = loadData_();
  ensureLogSheet_(data.ss);
  if (CONFIG.ATTACH_CV) cvBlob_();
  deleteTriggers_();
  ScriptApp.newTrigger("runScheduledBatch").timeBased().everyMinutes(TRIGGER_MINUTES).create();
  const yours = data.ss.getSpreadsheetTimeZone();
  SpreadsheetApp.getUi().alert(
    "Sending is on",
    `Up to ${CONFIG.DAILY_LIMIT} emails each weekday, between ${CONFIG.WINDOW_START_HOUR}:00 and ${CONFIG.WINDOW_END_HOUR}:00 ` +
      `in ${CONFIG.TIMEZONE} (${shiftedHour_(CONFIG.WINDOW_START_HOUR, yours)}–${shiftedHour_(CONFIG.WINDOW_END_HOUR, yours)} in ${yours}).\n\n` +
      'Progress shows on "Send log". Use "Stop sending" to pause.',
    SpreadsheetApp.getUi().ButtonSet.OK,
  );
}

function stopSending() {
  deleteTriggers_();
  SpreadsheetApp.getUi().alert("Sending is paused. Nothing more goes out until you start it again.");
}

function checkRepliesNow() {
  const found = checkReplies_();
  SpreadsheetApp.getUi().alert(found ? `Updated ${found} professor(s) on the Professors sheet.` : "No new replies or bounces.");
}

// ---------- scheduled run ----------

// Runs every TRIGGER_MINUTES; sends only inside the weekday window.
function runScheduledBatch() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) return;
  try {
    checkReplies_();
    const now = new Date();
    const data = loadData_();
    const log = readLog_(data.ss);
    const today = dayKey_(now);
    const sentToday = log.filter((e) => e.result === "Sent" && e.sentAt instanceof Date && dayKey_(e.sentAt) === today).length;
    const size = Math.min(batchSizeFor_(localTime_(now), sentToday, CONFIG), MailApp.getRemainingDailyQuota());
    if (size <= 0) return;
    const { batch } = pickBatch_(data.prof.rows, data.drafts.rows, log, size, CONFIG.FIT_ORDER);
    sendBatch_(data, batch);
  } finally {
    lock.releaseLock();
  }
}

function sendBatch_(data, batch) {
  if (!batch.length) return 0;
  const started = Date.now();
  const cv = CONFIG.ATTACH_CV ? cvBlob_() : null;
  const label = gmailLabel_();
  const logSheet = ensureLogSheet_(data.ss);
  let sent = 0;
  for (let i = 0; i < batch.length; i++) {
    if (i > 0) Utilities.sleep(pauseMs_());
    if (Date.now() - started > MAX_RUN_MS) break;
    const { prof, draft } = batch[i];
    let threadId = "";
    let result = "Sent";
    try {
      threadId = sendOne_(batch[i], cv, label);
      markEmailed_(data, prof);
      sent++;
    } catch (error) {
      result = `Error: ${error.message}`;
    }
    logSheet.appendRow([new Date(), prof.id, prof.name, String(draft.to).trim(), draft.subject, threadId, result, ""]);
    SpreadsheetApp.flush();
    if (result !== "Sent" && /too many times|limit/i.test(result)) break;
  }
  return sent;
}

// Sends one email and returns its Gmail thread ID. `to` overrides the
// recipient for test sends, which are not labelled or logged.
function sendOne_({ draft }, cv, label, to) {
  const options = { name: CONFIG.SENDER_NAME };
  if (cv) options.attachments = [cv];
  const subject = (to ? "[TEST] " : "") + String(draft.subject).trim();
  const message = GmailApp.createDraft(to || String(draft.to).trim(), subject, String(draft.body), options).send();
  const thread = message.getThread();
  if (label) thread.addLabel(label);
  return thread.getId();
}

function markEmailed_({ ss, prof }, professor) {
  prof.sheet.getRange(professor.row, prof.cols.status + 1).setValue("Emailed");
  prof.sheet
    .getRange(professor.row, prof.cols.dateEmailed + 1)
    .setValue(Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), "yyyy-MM-dd"));
}

// ---------- replies and bounces ----------

// Looks at recent inbox threads for answers to emails this script sent.
function checkReplies_() {
  const ss = SpreadsheetApp.getActive();
  const log = readLog_(ss);
  const waiting = new Map(log.filter((e) => e.result === "Sent" && !e.replyAt && e.threadId).map((e) => [String(e.threadId), e]));
  if (!waiting.size) return 0;

  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  const prof = sheetTable_(ss, SHEETS.professors, professorColumns_());
  const logSheet = ss.getSheetByName(SHEETS.log);
  let updated = 0;

  for (const thread of GmailApp.search("in:inbox newer_than:3d", 0, 500)) {
    const entry = waiting.get(thread.getId());
    if (!entry) continue;
    const incoming = thread.getMessages().filter((m) => !m.getFrom().toLowerCase().includes(me));
    const bounce = incoming.find((m) => /mailer-daemon|postmaster/i.test(m.getFrom()));
    const reply = incoming.find((m) => m !== bounce && !AUTO_REPLY_PATTERN.test(m.getSubject()));
    if (!bounce && !reply) continue;

    const professor = prof.rows.find((p) => String(p.id) === String(entry.id));
    const newStatus = reply ? "Replied" : "Bounced";
    if (professor && ["Emailed", "Follow-up sent"].includes(professor.status)) {
      prof.sheet.getRange(professor.row, prof.cols.status + 1).setValue(newStatus);
    }
    logSheet.getRange(entry.row, LOG_HEADERS.indexOf("Reply at") + 1).setValue((reply || bounce).getDate());
    if (!reply) logSheet.getRange(entry.row, LOG_HEADERS.indexOf("Result") + 1).setValue("Bounced");
    updated++;
  }
  return updated;
}

// ---------- choosing who is next (no Apps Script services; unit-tested) ----------

// Maps each professor # in a research group to one shared group key, from
// notes like "Same research group as #10 Wayne Xin Zhao, #3 Zhicheng Dou: …".
function buildGroups_(profRows) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const p of profRows) {
    const match = /Same research group as ([^:]*)/.exec(String(p.notes || ""));
    if (!match) continue;
    for (const [, ref] of match[1].matchAll(/#(\d+)/g)) parent.set(find(String(p.id)), find(ref));
  }
  const groupOf = new Map();
  for (const id of parent.keys()) groupOf.set(id, find(id));
  return groupOf;
}

// Picks up to `limit` professors to email next: not contacted yet, with a valid
// address, never already sent to, best fit first, one per research group.
function pickBatch_(profRows, draftRows, log, limit, fitOrder) {
  const drafts = new Map(draftRows.map((d) => [String(d.id), d]));
  const groupOf = buildGroups_(profRows);
  const busyGroups = new Set(
    profRows.filter((p) => ACTIVE_STATUSES.includes(p.status) && groupOf.has(String(p.id))).map((p) => groupOf.get(String(p.id))),
  );
  const contacted = new Set(log.filter((e) => e.result === "Sent").map((e) => normaliseEmail_(e.to)));
  const rank = (fit) => (fitOrder.includes(fit) ? fitOrder.indexOf(fit) : fitOrder.length);

  const candidates = profRows
    .filter((p) => p.status === NOT_CONTACTED)
    .map((p) => ({ prof: p, draft: drafts.get(String(p.id)) }))
    .filter(({ draft }) => draft && EMAIL_PATTERN.test(normaliseEmail_(draft.to)) && draft.subject && draft.body)
    .filter(({ draft }) => !contacted.has(normaliseEmail_(draft.to)))
    .sort((a, b) => rank(a.prof.fit) - rank(b.prof.fit) || Number(a.prof.id) - Number(b.prof.id));

  const waitingOnGroup = candidates.filter(({ prof }) => busyGroups.has(groupOf.get(String(prof.id)))).length;
  const readyNow = new Set();
  let ungroupedReady = 0;
  const batch = [];
  for (const candidate of candidates) {
    const group = groupOf.get(String(candidate.prof.id));
    const email = normaliseEmail_(candidate.draft.to);
    if (group && busyGroups.has(group)) continue;
    if (group) readyNow.add(group);
    else ungroupedReady++;
    if (batch.length < limit && !contacted.has(email)) {
      batch.push(candidate);
      contacted.add(email);
      if (group) busyGroups.add(group);
    }
  }
  return {
    batch,
    stats: { notContacted: candidates.length, readyNow: readyNow.size + ungroupedReady, waitingOnGroup },
  };
}

// How many to send in this run so the rest of today's quota spreads evenly
// over the remaining runs in the window. `local` is the professors' time.
function batchSizeFor_(local, sentToday, config) {
  if (!config.SEND_WEEKDAYS.includes(local.weekday)) return 0;
  const start = config.WINDOW_START_HOUR * 60;
  const end = config.WINDOW_END_HOUR * 60;
  if (local.minutes < start || local.minutes >= end) return 0;
  const remaining = Math.max(0, config.DAILY_LIMIT - sentToday);
  const runsLeft = Math.max(1, Math.ceil((end - local.minutes) / TRIGGER_MINUTES));
  return Math.ceil(remaining / runsLeft);
}

function normaliseEmail_(value) {
  return String(value || "").trim().toLowerCase();
}

// ---------- sheets ----------

function professorColumns_() {
  return {
    id: "#",
    name: "Name",
    university: "University / Institute",
    fit: "Fit",
    notes: "Notes / caveats",
    status: "Status",
    dateEmailed: "Date emailed",
  };
}

function loadData_() {
  const ss = SpreadsheetApp.getActive();
  return {
    ss,
    prof: sheetTable_(ss, SHEETS.professors, professorColumns_()),
    drafts: sheetTable_(ss, SHEETS.drafts, { id: "#", to: "To", subject: "Subject", body: "Email body" }),
  };
}

// Reads a sheet into row objects, finding columns by header text.
function sheetTable_(ss, name, wanted) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error(`Sheet "${name}" not found. Did you save the Excel file as a Google Sheet?`);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map((h) => String(h).trim());
  const cols = {};
  for (const [key, header] of Object.entries(wanted)) {
    let index = headers.indexOf(header);
    if (index < 0) index = headers.findIndex((h) => h.startsWith(header));
    if (index < 0) throw new Error(`Column "${header}" not found on sheet "${name}".`);
    cols[key] = index;
  }
  const rows = [];
  values.slice(1).forEach((row, i) => {
    if (row[cols.id] === "" || row[cols.id] === null) return;
    const record = { row: i + 2 };
    for (const [key, index] of Object.entries(cols)) record[key] = row[index];
    rows.push(record);
  });
  return { sheet, cols, rows };
}

function ensureLogSheet_(ss) {
  let sheet = ss.getSheetByName(SHEETS.log);
  if (!sheet) {
    sheet = ss.insertSheet(SHEETS.log);
    sheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readLog_(ss) {
  const sheet = ss.getSheetByName(SHEETS.log);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet
    .getRange(2, 1, sheet.getLastRow() - 1, LOG_HEADERS.length)
    .getValues()
    .map((r, i) => ({ row: i + 2, sentAt: r[0], id: r[1], name: r[2], to: r[3], subject: r[4], threadId: r[5], result: r[6], replyAt: r[7] }));
}

// Adds "On hold" (skip this one) and "Bounced" to the Status dropdown.
function extendStatusDropdown_(prof) {
  const range = prof.sheet.getRange(2, prof.cols.status + 1, Math.max(1, prof.rows.length), 1);
  const rule = range.getDataValidation();
  const current =
    rule && rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST ? rule.getCriteriaValues()[0] : DEFAULT_STATUSES;
  const values = [...new Set([...current, ...EXTRA_STATUSES])];
  range.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(false).build());
}

// ---------- small helpers ----------

function cvBlob_() {
  if (!CONFIG.CV_DRIVE_LINK) {
    throw new Error("Paste your CV's Google Drive link into CV_DRIVE_LINK at the top of the script (or set ATTACH_CV to false).");
  }
  const id = (CONFIG.CV_DRIVE_LINK.match(/[-\w]{25,}/) || [])[0];
  if (!id) throw new Error("CV_DRIVE_LINK doesn't look like a Google Drive file link.");
  return DriveApp.getFileById(id).getBlob();
}

function gmailLabel_() {
  return GmailApp.getUserLabelByName(CONFIG.GMAIL_LABEL) || GmailApp.createLabel(CONFIG.GMAIL_LABEL);
}

function deleteTriggers_() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === "runScheduledBatch") ScriptApp.deleteTrigger(trigger);
  }
}

function localTime_(date) {
  return {
    weekday: Number(Utilities.formatDate(date, CONFIG.TIMEZONE, "u")),
    minutes: Number(Utilities.formatDate(date, CONFIG.TIMEZONE, "H")) * 60 + Number(Utilities.formatDate(date, CONFIG.TIMEZONE, "m")),
  };
}

function dayKey_(date) {
  return Utilities.formatDate(date, CONFIG.TIMEZONE, "yyyy-MM-dd");
}

function pauseMs_() {
  const [min, max] = CONFIG.PAUSE_SECONDS;
  return Math.round((min + Math.random() * (max - min)) * 1000);
}

// Converts an hour in CONFIG.TIMEZONE to "HH:MM" in another timezone.
function shiftedHour_(hour, timeZone) {
  const offset = (tz) => {
    const z = Utilities.formatDate(new Date(), tz, "Z");
    return (z[0] === "-" ? -1 : 1) * (Number(z.slice(1, 3)) * 60 + Number(z.slice(3, 5)));
  };
  const minutes = (((hour * 60 + offset(timeZone) - offset(CONFIG.TIMEZONE)) % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
