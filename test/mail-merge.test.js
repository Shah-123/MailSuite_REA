import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// Loads the Apps Script file and exposes its service-free functions.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../mail-merge/Code.gs", import.meta.url), "utf8"), context);
const { buildGroups_, pickBatch_, batchSizeFor_, parseTime_ } = context;
const CONFIG = vm.runInContext("CONFIG", context);

const prof = (id, fit, extra = {}) => ({ id, name: `Prof ${id}`, fit, status: "Not contacted", notes: "", ...extra });
const draft = (id, to = `p${id}@uni.edu.cn`) => ({ id, to, subject: `Subject ${id}`, body: `Dear Professor ${id}` });
const ids = (result) => Array.from(result.batch, ({ prof }) => prof.id);

test("research groups merge across partial, truncated notes", () => {
  const groups = buildGroups_([
    prof(1, "Strong", { notes: "Same research group as #10 Wayne Xin Zhao, #3 Zhicheng Dou: email one of them at a time." }),
    prof(3, "Strong", { notes: "Same research group as #1 Ji-Rong Wen: email one of them at a time." }),
    prof(10, "Good", { notes: "Same research group as #1 Ji-Rong Wen and 4 more: email one of them at a time." }),
    prof(42, "Good", { notes: "Same research group as #43 Someone: email one of them at a time." }),
    prof(7, "Good", { notes: "Moved to #12 University in 2025." }),
  ]);
  assert.equal(groups.get("1"), groups.get("3"));
  assert.equal(groups.get("1"), groups.get("10"));
  assert.equal(groups.get("42"), groups.get("43"));
  assert.notEqual(groups.get("1"), groups.get("42"));
  assert.equal(groups.has("7"), false);
});

test("next batch: best fit first, one per group, skips missing emails and earlier sends", () => {
  const profs = [
    prof(1, "Good"),
    prof(2, "Strong", { notes: "Same research group as #4 X: email one of them at a time." }),
    prof(3, "Moderate"),
    prof(4, "Strong", { notes: "Same research group as #2 Y: email one of them at a time." }),
    prof(5, "Strong"),
    prof(6, "Strong"),
    prof(7, "Good"),
  ];
  const drafts = [draft(1), draft(2), draft(3), draft(4), draft(5, "No public email – use homepage"), draft(6), draft(7)];
  const log = [{ to: "P7@uni.edu.cn ", result: "Sent" }, { to: "p1@uni.edu.cn", result: "Error: quota" }];

  const result = pickBatch_(profs, drafts, log, 10, CONFIG.FIT_ORDER);
  assert.deepEqual(ids(result), [2, 6, 1, 3]);
  assert.deepEqual({ ...result.stats }, { notContacted: 5, readyNow: 4, waitingOnGroup: 0 });

  assert.deepEqual(ids(pickBatch_(profs, drafts, log, 2, CONFIG.FIT_ORDER)), [2, 6]);
});

test("a group waits while a member is in conversation, and opens up after a decline", () => {
  const note = (other) => ({ notes: `Same research group as #${other} Z: email one of them at a time.` });
  const drafts = [draft(1), draft(2), draft(3)];

  const emailed = [prof(1, "Strong", { ...note(2), status: "Emailed" }), prof(2, "Strong", note(1)), prof(3, "Good")];
  const waiting = pickBatch_(emailed, drafts, [], 10, CONFIG.FIT_ORDER);
  assert.deepEqual(ids(waiting), [3]);
  assert.equal(waiting.stats.waitingOnGroup, 1);

  const declined = [prof(1, "Strong", { ...note(2), status: "Declined" }), prof(2, "Strong", note(1)), prof(3, "Good")];
  assert.deepEqual(ids(pickBatch_(declined, drafts, [], 10, CONFIG.FIT_ORDER)), [2, 3]);

  const onHold = [prof(1, "Strong", { status: "On hold" }), prof(3, "Good")];
  assert.deepEqual(ids(pickBatch_(onHold, drafts, [], 10, CONFIG.FIT_ORDER)), [3]);
});

test("send times accept 24-hour and am/pm formats", () => {
  assert.equal(parseTime_("05:15"), 315);
  assert.equal(parseTime_("5:15"), 315);
  assert.equal(parseTime_("5:15 am"), 315);
  assert.equal(parseTime_("5:15 PM"), 1035);
  assert.equal(parseTime_("12:30 am"), 30);
  assert.equal(parseTime_("12:30 p.m."), 750);
  assert.equal(parseTime_("17:15"), 1035);
  for (const bad of ["5.15", "25:00", "5:75", "13:00 pm", "0:30 am", "", "five"]) {
    assert.throws(() => parseTime_(bad), /is not a time/, bad);
  }
});

test("batch size spreads the daily limit between SEND_FROM and SEND_UNTIL on weekdays", () => {
  const at = (weekday, hour, minute = 0) => ({ weekday, minutes: hour * 60 + minute });
  assert.equal(CONFIG.SEND_FROM, "05:15");
  assert.equal(batchSizeFor_(at(6, 6), 0, CONFIG), 0, "Saturday");
  assert.equal(batchSizeFor_(at(1, 5, 14), 0, CONFIG), 0, "one minute early");
  assert.ok(batchSizeFor_(at(1, 5, 15), 0, CONFIG) > 0, "right at 05:15");
  assert.equal(batchSizeFor_(at(1, 8, 15), 0, CONFIG), 0, "after the window");
  assert.equal(batchSizeFor_(at(1, 6), 40, CONFIG), 0, "limit reached");

  // A trigger firing every 5 minutes from 05:16 sends exactly the daily limit, a couple at a time.
  let sent = 0;
  const sizes = [];
  for (let minutes = 5 * 60 + 16; minutes < 8 * 60 + 15; minutes += 5) {
    const size = batchSizeFor_({ weekday: 2, minutes }, sent, CONFIG);
    sizes.push(size);
    sent += size;
  }
  assert.equal(sent, CONFIG.DAILY_LIMIT);
  assert.ok(Math.max(...sizes) <= 2, `sizes ${sizes}`);

  // A custom window works the same way, and a late run catches up.
  const custom = { ...CONFIG, SEND_FROM: "9:00 pm", SEND_UNTIL: "21:30" };
  assert.equal(batchSizeFor_(at(4, 20, 59), 0, custom), 0);
  assert.equal(batchSizeFor_(at(4, 21, 25), 30, custom), 10);
  assert.throws(() => batchSizeFor_(at(4, 6), 0, { ...CONFIG, SEND_UNTIL: "05:00" }), /must be later/);
});
