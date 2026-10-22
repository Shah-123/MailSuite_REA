import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// Loads the Apps Script file and exposes its service-free functions.
const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("../mail-merge/Code.gs", import.meta.url), "utf8"), context);
const { buildGroups_, pickBatch_, batchSizeFor_ } = context;
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

test("batch size spreads the daily limit over weekday morning runs", () => {
  const at = (weekday, hour, minute = 0) => ({ weekday, minutes: hour * 60 + minute });
  assert.equal(batchSizeFor_(at(6, 10), 0, CONFIG), 0, "Saturday");
  assert.equal(batchSizeFor_(at(1, 8, 59), 0, CONFIG), 0, "before the window");
  assert.equal(batchSizeFor_(at(1, 12), 0, CONFIG), 0, "after the window");
  assert.equal(batchSizeFor_(at(1, 10), 40, CONFIG), 0, "limit reached");

  // A trigger firing every 30 minutes from 9:07 sends exactly the daily limit.
  let sent = 0;
  const sizes = [];
  for (let minutes = 9 * 60 + 7; minutes < 12 * 60; minutes += 30) {
    const size = batchSizeFor_({ weekday: 2, minutes }, sent, CONFIG);
    sizes.push(size);
    sent += size;
  }
  assert.equal(sent, CONFIG.DAILY_LIMIT);
  assert.ok(Math.max(...sizes) <= 7, `sizes ${sizes}`);

  // A late or missed run still catches up within the window.
  assert.equal(batchSizeFor_(at(3, 11, 45), 30, CONFIG), 10);
});
