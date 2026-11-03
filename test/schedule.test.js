import { test } from "node:test";
import assert from "node:assert/strict";
import { occurrences, validateSpec, parseDate } from "../src/schedule.js";
import { wallClock, allZones } from "../src/tz.js";
import { createRng } from "../src/rng.js";

const H = 3600000;
const utc = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm);
const spec = (over = {}) => ({ times: ["08:00"], startDate: "2026-03-06", endDate: null, everyDays: 1, weekdays: null, ...over });
const hhmm = (ms, zone) => {
  const w = wallClock(ms, zone);
  return `${String(w.hh).padStart(2, "0")}:${String(w.mm).padStart(2, "0")}`;
};

test("daily 08:00 across spring forward: always 08:00 on the clock, one 23-hour day", () => {
  const o = occurrences(spec({ endDate: "2026-03-10" }), "America/New_York");
  assert.deepEqual(o.map((x) => x.ms), [utc(2026, 3, 6, 13), utc(2026, 3, 7, 13), utc(2026, 3, 8, 12), utc(2026, 3, 9, 12), utc(2026, 3, 10, 12)]);
  assert.ok(o.every((x) => hhmm(x.ms, "America/New_York") === "08:00"));
  assert.equal((o[2].ms - o[1].ms) / H, 23);
});

test("daily 08:00 across fall back: always 08:00 on the clock, one 25-hour day", () => {
  const o = occurrences(spec({ startDate: "2026-10-30", endDate: "2026-11-03" }), "America/New_York");
  assert.ok(o.every((x) => hhmm(x.ms, "America/New_York") === "08:00"));
  assert.equal((o[3].ms - o[2].ms) / H, 24); // 1 Nov 08:00 -> 2 Nov 08:00
  assert.equal((o[2].ms - o[1].ms) / H, 25); // 31 Oct 08:00 -> 1 Nov 08:00 crosses the extra hour
});

test("a twice-daily regimen keeps both clock times through a change", () => {
  const o = occurrences(spec({ times: ["20:00", "08:00"], startDate: "2026-03-07", endDate: "2026-03-09" }), "America/New_York");
  assert.deepEqual(o.map((x) => hhmm(x.ms, "America/New_York")), ["08:00", "20:00", "08:00", "20:00", "08:00", "20:00"]);
  const gaps = o.slice(1).map((x, i) => (x.ms - o[i].ms) / H);
  assert.deepEqual(gaps, [12, 11, 12, 12, 12], "the overnight interval crossing the change is 11 hours, because the clock skipped one");
});

test("a time inside the spring-forward gap fires at the shifted time, once", () => {
  const o = occurrences(spec({ times: ["02:30"], startDate: "2026-03-07", endDate: "2026-03-09" }), "America/New_York");
  assert.deepEqual(o.map((x) => [x.ms, x.kind]), [[utc(2026, 3, 7, 7, 30), "ok"], [utc(2026, 3, 8, 7, 30), "gap"], [utc(2026, 3, 9, 6, 30), "ok"]]);
  assert.equal(hhmm(o[1].ms, "America/New_York"), "03:30");
});

test("02:30 and 03:30 on the gap day collapse into ONE reminder, not two at the same instant", () => {
  const o = occurrences(spec({ times: ["02:30", "03:30"], startDate: "2026-03-08", endDate: "2026-03-08" }), "America/New_York");
  assert.equal(o.length, 1);
  assert.equal(o[0].ms, utc(2026, 3, 8, 7, 30));
});

test("a time inside the fall-back overlap fires once, at the first 01:30", () => {
  const o = occurrences(spec({ times: ["01:30"], startDate: "2026-11-01", endDate: "2026-11-01" }), "America/New_York");
  assert.deepEqual(o.map((x) => [x.ms, x.kind]), [[utc(2026, 11, 1, 5, 30), "overlap"]]);
});

test("Samoa: the date that never happened gets no reminder, and nothing is doubled", () => {
  const o = occurrences(spec({ startDate: "2011-12-28", endDate: "2012-01-01" }), "Pacific/Apia");
  const days = o.map((x) => { const w = wallClock(x.ms, "Pacific/Apia"); return `${w.y}-${w.m}-${w.d}`; });
  assert.deepEqual(days, ["2011-12-28", "2011-12-29", "2011-12-31", "2012-1-1"]);
  assert.ok(o.every((x, i) => i === 0 || x.ms > o[i - 1].ms));
});

test("every other day, weekdays only, and an inclusive end date", () => {
  const eod = occurrences(spec({ startDate: "2026-01-01", endDate: "2026-01-09", everyDays: 2 }), "UTC");
  assert.deepEqual(eod.map((x) => new Date(x.ms).getUTCDate()), [1, 3, 5, 7, 9]);
  const mwf = occurrences(spec({ startDate: "2026-01-05", endDate: "2026-01-11", weekdays: [1, 3, 5] }), "UTC"); // 5 Jan 2026 is a Monday
  assert.deepEqual(mwf.map((x) => new Date(x.ms).getUTCDay()), [1, 3, 5]);
  assert.equal(occurrences(spec({ startDate: "2026-01-05", endDate: "2026-01-05" }), "UTC").length, 1, "end date is included");
});

test("fromMs skips the past, limit caps the count, and no end date keeps going", () => {
  const all = occurrences(spec({ startDate: "2026-01-01" }), "UTC", { limit: 10 });
  assert.equal(all.length, 10);
  const later = occurrences(spec({ startDate: "2026-01-01" }), "UTC", { fromMs: utc(2026, 1, 5, 9), limit: 3 });
  assert.deepEqual(later.map((x) => new Date(x.ms).getUTCDate()), [6, 7, 8]);
});

test("validation: every bad input is refused with a reason, and good ones pass", () => {
  assert.equal(validateSpec(spec()), null);
  const bad = [
    [{ times: [] }, /at least one time/],
    [{ times: ["8:00"] }, /look like 08:00/],
    [{ times: ["24:00"] }, /look like 08:00/],
    [{ times: ["08:60"] }, /look like 08:00/],
    [{ times: ["08:00", "08:00"] }, /twice/],
    [{ times: Array.from({ length: 13 }, (_, i) => `${String(i).padStart(2, "0")}:00`) }, /at most 12/],
    [{ startDate: "2026-02-30" }, /real date/],
    [{ startDate: "tomorrow" }, /real date/],
    [{ endDate: "2026-03-01" }, /before the start/],
    [{ endDate: "nope" }, /real date/],
    [{ everyDays: 0 }, /whole number/],
    [{ everyDays: 1.5 }, /whole number/],
    [{ weekdays: [] }, /at least one weekday/],
    [{ weekdays: [7] }, /0 \(Sunday\)/],
  ];
  for (const [over, pattern] of bad) assert.match(validateSpec(spec(over)), pattern, JSON.stringify(over));
  assert.throws(() => occurrences(spec({ times: [] }), "UTC"), /at least one time/);
  assert.equal(parseDate("2024-02-29") !== null, true);
  assert.equal(parseDate("2026-02-29"), null);
});

test("SWEEP: every zone, a full year, random daily times - strictly increasing, one per date, correct on the clock", () => {
  const rng = createRng(20261102);
  let gapDays = 0;
  for (const zone of allZones()) {
    const hh = String(rng.int(24)).padStart(2, "0");
    const mm = String(rng.int(60)).padStart(2, "0");
    const o = occurrences(spec({ times: [`${hh}:${mm}`], startDate: "2026-01-01", endDate: "2026-12-31" }), zone, { limit: 400 });
    assert.ok(o.length >= 364 && o.length <= 365, `${zone}: ${o.length} reminders`);
    const dates = new Set();
    o.forEach((x, i) => {
      if (i) assert.ok(x.ms > o[i - 1].ms, `${zone}: not increasing at ${i}`);
      const w = wallClock(x.ms, zone);
      const key = `${w.m}-${w.d}`;
      assert.ok(!dates.has(key), `${zone}: two reminders on ${key}`);
      dates.add(key);
      if (x.kind === "ok" || x.kind === "overlap") assert.equal(hhmm(x.ms, zone), `${hh}:${mm}`, `${zone} ${key}`);
      else gapDays += 1;
    });
  }
  assert.ok(gapDays > 0, "random times should have hit at least one spring-forward gap");
});

import { edgeWarnings } from "../src/schedule.js";

test("warnings: a time in the skipped hour is flagged with what it will become; ordinary times are not", () => {
  const from = Date.UTC(2026, 2, 1);
  const w = edgeWarnings(spec({ times: ["02:30", "08:00"], startDate: "2026-03-01", endDate: "2026-03-31" }), "America/New_York", { fromMs: from, days: 60 });
  assert.deepEqual(w.map(({ date, wanted, ranAs, kind }) => ({ date, wanted, ranAs, kind })), [{ date: "2026-03-08", wanted: "02:30", ranAs: "03:30", kind: "skipped" }]);
});

test("warnings: 01:30 is ordinary when clocks jump 02:00->03:00 but repeated when they fall back; 02:30 is the reverse", () => {
  const year = { startDate: "2026-01-01" };
  const o = { fromMs: Date.UTC(2026, 0, 1), days: 365 };
  assert.deepEqual(
    edgeWarnings(spec({ ...year, times: ["01:30"] }), "America/New_York", o).map(({ date, kind, ranAs }) => ({ date, kind, ranAs })),
    [{ date: "2026-11-01", kind: "repeated", ranAs: "01:30" }]
  );
  assert.deepEqual(
    edgeWarnings(spec({ ...year, times: ["02:30"] }), "America/New_York", o).map(({ date, kind, ranAs }) => ({ date, kind, ranAs })),
    [{ date: "2026-03-08", kind: "skipped", ranAs: "03:30" }]
  );
});

test("warnings: the affected stretch is named exactly, for each zone's own clock change", () => {
  const win = (times, zone, startDate, endDate) => edgeWarnings(spec({ times, startDate, endDate }), zone, { fromMs: Date.UTC(2026, 0, 1), days: 700 }).map((w) => [w.date, w.kind, w.window]);
  assert.deepEqual(win(["02:30"], "America/New_York", "2026-03-07", "2026-03-09"), [["2026-03-08", "skipped", "02:00-03:00"]]);
  assert.deepEqual(win(["01:30"], "America/New_York", "2026-10-31", "2026-11-02"), [["2026-11-01", "repeated", "01:00-02:00"]]);
  assert.deepEqual(win(["01:30"], "Europe/London", "2026-03-28", "2026-03-30"), [["2026-03-29", "skipped", "01:00-02:00"]]);
  assert.deepEqual(win(["02:15"], "Australia/Lord_Howe", "2026-10-03", "2026-10-05"), [["2026-10-04", "skipped", "02:00-02:30"]], "a 30-minute change names a 30-minute window");
  assert.deepEqual(win(["02:30"], "Europe/Paris", "2026-10-24", "2026-10-26"), [["2026-10-25", "repeated", "02:00-03:00"]], "the repeated hour is 02:00 in Europe, not 01:00");
});

test("warnings: none for a zone that never changes its clocks, or for times away from the change", () => {
  assert.deepEqual(edgeWarnings(spec({ times: ["02:30", "01:30"], startDate: "2026-01-01" }), "Asia/Kolkata", { fromMs: Date.UTC(2026, 0, 1), days: 365 }), []);
  assert.deepEqual(edgeWarnings(spec({ times: ["08:00", "20:00"], startDate: "2026-01-01" }), "America/New_York", { fromMs: Date.UTC(2026, 0, 1), days: 365 }), []);
});
