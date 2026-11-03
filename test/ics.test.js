import { test } from "node:test";
import assert from "node:assert/strict";
import ICAL from "ical.js";
import { buildCalendar, escapeText, fold, vtimezone } from "../src/ics.js";
import { occurrences } from "../src/schedule.js";
import { checkAllZones } from "../bench/ics-check.js";

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const med = (over = {}) => ({ name: "Vitamin D", times: ["08:00"], startDate: "2026-03-06", endDate: "2026-03-12", everyDays: 1, weekdays: null, ...over });
const parse = (text) => new ICAL.Component(ICAL.parse(text));
const events = (text) => parse(text).getAllSubcomponents("vevent");
const expand = (vevent, n = 400) => {
  const it = new ICAL.Event(vevent).iterator();
  const out = [];
  for (let t; out.length < n && (t = it.next()); ) out.push(t);
  return out;
};

test("the file is well formed: CRLF lines, none over 75 octets, balanced blocks, required fields present", () => {
  const text = buildCalendar([med({ name: "Ünïcode 薬 " + "x".repeat(60), notes: "n".repeat(250), times: ["08:00", "20:00"] })], { now: NOW });
  assert.ok(text.endsWith("\r\n"));
  assert.ok(!/[^\r]\n/.test(text), "no bare newlines");
  const lines = text.split("\r\n").slice(0, -1);
  for (const l of lines) assert.ok(new TextEncoder().encode(l).length <= 75, `line over 75 octets: ${l.slice(0, 40)}…`);
  const stack = [];
  for (const l of lines.filter((x) => !x.startsWith(" "))) {
    if (l.startsWith("BEGIN:")) stack.push(l.slice(6));
    if (l.startsWith("END:")) assert.equal(stack.pop(), l.slice(4));
  }
  assert.equal(stack.length, 0);
  const root = parse(text);
  assert.equal(root.getFirstPropertyValue("version"), "2.0");
  assert.equal(events(text).length, 2, "one event per time of day");
  for (const ve of events(text)) {
    for (const f of ["uid", "dtstamp", "dtstart", "summary", "rrule"]) assert.ok(ve.hasProperty(f), `missing ${f}`);
    assert.equal(ve.getFirstSubcomponent("valarm").getFirstPropertyValue("trigger").toString(), "PT0S", "the alarm fires at the start time");
  }
});

test("hostile text survives: commas, semicolons, backslashes, newlines, emoji and a fold in the middle of a multi-byte character", () => {
  const names = ["Vitamin D3, 1000 IU; with food", "Back\\slash and\nnewline", "漢字のくすり " + "薬".repeat(40), "🙂".repeat(30), "a".repeat(80)];
  for (const name of names) {
    const text = buildCalendar([med({ name, notes: `Take ${name}; then rest, please` })], { now: NOW });
    const ve = events(text)[0];
    assert.equal(ve.getFirstPropertyValue("summary"), `Take ${name.replace(/\r?\n/g, "\n")}`);
    assert.equal(ve.getFirstPropertyValue("description"), `Take ${name}; then rest, please`.slice(0, 300));
  }
  assert.equal(escapeText("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
  assert.equal(escapeText("a\u0000b"), "a b", "control characters are dropped");
  assert.equal(fold("short"), "short");
  const folded = fold("X:" + "🙂".repeat(40)).split("\r\n");
  assert.ok(folded.length > 1 && folded.slice(1).every((l) => l.startsWith(" ")));
  assert.equal(folded.map((l, i) => (i ? l.slice(1) : l)).join(""), "X:" + "🙂".repeat(40), "unfolding gives the original back");
});

test("FLOATING: no time zone anywhere in the file, and the calendar expands it to exactly the intended wall times", () => {
  const spec = med({ times: ["08:00"], startDate: "2026-03-06", endDate: "2026-03-20", everyDays: 2 });
  const text = buildCalendar([spec], { mode: "floating", now: NOW });
  assert.ok(!/TZID|VTIMEZONE|\dZ\r\n/.test(text.replace(/DTSTAMP:\S+Z/, "")), "no zone, no UTC times (except the stamp)");
  const got = expand(events(text)[0]);
  assert.ok(got.every((t) => t.zone === ICAL.Timezone.localTimezone), "reminders are floating");
  // Floating = "this clock reading wherever you are", so comparing with the engine in UTC compares clock readings.
  const want = occurrences(spec, "UTC", { limit: 50 });
  assert.deepEqual(got.map((t) => t.toUnixTime() * 1000), want.map((o) => o.ms));
  assert.equal(got.length, 8);
});

test("every-other-day and weekday rules mean the same thing to the calendar as to this code", () => {
  for (const spec of [
    med({ startDate: "2026-01-05", endDate: "2026-02-28", everyDays: 3 }),
    med({ startDate: "2026-01-05", endDate: "2026-02-28", weekdays: [1, 3, 5] }),
    med({ startDate: "2026-01-05", endDate: "2026-04-30", everyDays: 2, weekdays: [0, 6] }),
  ]) {
    const got = expand(events(buildCalendar([spec], { now: NOW }))[0]).map((t) => t.toUnixTime() * 1000);
    const want = occurrences(spec, "UTC", { limit: 400 }).map((o) => o.ms);
    assert.deepEqual(got, want, JSON.stringify(spec));
  }
});

test("every-N-days combined with weekdays keeps counting from the START date, not from the first matching weekday", () => {
  // Monday 5 Jan 2026, every 2 days, weekends only: 5,7,9,11(Sun),13,15,17(Sat)... not 10,12,14,16,18...
  const spec = med({ startDate: "2026-01-05", endDate: "2026-02-28", everyDays: 2, weekdays: [0, 6] });
  const got = expand(events(buildCalendar([spec], { now: NOW }))[0]).map((t) => t.toString().slice(0, 10));
  assert.deepEqual(got.slice(0, 4), ["2026-01-11", "2026-01-17", "2026-01-25", "2026-01-31"]);
  assert.deepEqual(got, occurrences(spec, "UTC", { limit: 400 }).map((o) => new Date(o.ms).toISOString().slice(0, 10)));
});

test("a start date that the weekday rule doesn't land on is moved to the first day that does", () => {
  const spec = med({ startDate: "2026-01-06", endDate: "2026-01-31", weekdays: [1] }); // 6 Jan 2026 is a Tuesday; first Monday is the 12th
  const got = expand(events(buildCalendar([spec], { now: NOW }))[0]);
  assert.equal(got[0].day, 12);
  assert.equal(got[0].dayOfWeek(), 2, "ical.js numbers Monday as 2");
});

test("no end date: the rule has no UNTIL and keeps going", () => {
  const text = buildCalendar([med({ endDate: null })], { now: NOW });
  assert.ok(!/UNTIL|COUNT/.test(text));
  assert.equal(expand(events(text)[0], 500).length, 500);
});

test("ZONE mode: the zone's clock changes are written into the file and the calendar resolves 08:00 to the right moment each day", () => {
  const spec = med({ startDate: "2026-03-06", endDate: "2026-03-10" });
  const text = buildCalendar([spec], { mode: "zone", zone: "America/New_York", now: NOW });
  const root = parse(text);
  assert.equal(root.getAllSubcomponents("vtimezone").length, 1);
  assert.match(text, /DTSTART;TZID=America\/New_York:20260306T080000/);
  assert.match(text, /UNTIL=\d{8}T\d{6}Z/, "a zoned start needs a UTC UNTIL (RFC 5545)");
  ICAL.TimezoneService.reset();
  ICAL.TimezoneService.register(new ICAL.Timezone(root.getFirstSubcomponent("vtimezone")));
  const got = expand(events(text)[0]).map((t) => t.toUnixTime() * 1000);
  assert.deepEqual(got, [13, 13, 12, 12, 12].map((h, i) => Date.UTC(2026, 2, 6 + i, h)));
});

test("vtimezone(): offsets and change times are written to the second, and a zone with no changes has just the base rule", () => {
  const v = vtimezone("America/New_York", Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)).join("\n");
  assert.match(v, /DAYLIGHT\nDTSTART:20260308T020000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400/);
  assert.match(v, /STANDARD\nDTSTART:20261101T020000\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500/);
  const india = vtimezone("Asia/Kolkata", Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)).join("\n");
  assert.match(india, /TZOFFSETTO:\+0530/);
  assert.equal((india.match(/BEGIN:(STANDARD|DAYLIGHT)/g) ?? []).length, 1);
});

test("EVERY ZONE: ordinary reminders agree with an independent calendar engine; gap and overlap reminders differ in exactly the documented way", () => {
  const stats = checkAllZones();
  const r = stats.reminders;
  assert.ok(stats.zonesWithAChange > 100, `only ${stats.zonesWithAChange} zones change clocks`);
  assert.ok(r.ordinary.compared > 1000);
  assert.equal(r.ordinary.agree, r.ordinary.compared, "every ordinary reminder must be read identically");
  assert.ok(r.gap.compared > 100 && r.overlap.compared > 100, "the edge cases must actually have been exercised");
  // ical.js reads a skipped time one clock-change early and a repeated time as its second occurrence,
  // the opposite of RFC 5545 on both. If it ever stops doing so this test fails and the README needs updating.
  assert.equal(stats.skippedTimeReadEarlierByTheClockChange, r.gap.compared);
  assert.equal(stats.repeatedTimeReadLaterByTheClockChange, r.overlap.compared);
  assert.equal(stats.disagreementsWithAnyOtherPattern, 0);
});

test("the same reminder always gets the same id, so importing it twice updates it instead of duplicating it", () => {
  const uids = (m, opts = {}) => events(buildCalendar([m], { now: NOW, ...opts })).map((v) => v.getFirstPropertyValue("uid"));
  const a = med({ times: ["08:00", "20:00"] });
  assert.deepEqual(uids(a), uids(a));
  assert.deepEqual(uids(a), uids(a, { now: NOW + 1e9 }), "regenerating on another day keeps the ids");
  assert.notEqual(uids(a)[0], uids(a)[1], "different times, different ids");
  assert.notEqual(uids(a)[0], uids(med({ times: ["08:30"] }))[0]);
  assert.notEqual(uids(a)[0], uids(a, { mode: "zone", zone: "UTC" })[0], "floating and pinned are different reminders");
  assert.equal(events(buildCalendar([med(), med()], { now: NOW })).length, 1, "an identical reminder listed twice is one reminder");
});

test("bad input is refused with a reason", () => {
  assert.throws(() => buildCalendar([], { now: NOW }), /at least one/);
  assert.throws(() => buildCalendar([med({ name: "  " })], { now: NOW }), /needs a name/);
  assert.throws(() => buildCalendar([med({ name: "x".repeat(81) })], { now: NOW }), /too long/);
  assert.throws(() => buildCalendar([med({ times: ["8am"] })], { now: NOW }), /Vitamin D: times look like/);
  assert.throws(() => buildCalendar([med({ endDate: "2026-01-01" })], { now: NOW }), /before the start/);
  assert.throws(() => buildCalendar([med({ everyDays: 7, weekdays: [2] })], { now: NOW }), /never lands on the weekdays/); // 6 Mar 2026 is a Friday; every 7 days is always Friday
  assert.throws(() => buildCalendar([med()], { mode: "zone", now: NOW }), /zone is needed/);
  assert.throws(() => buildCalendar([med()], { mode: "sideways", now: NOW }), /floating or zone/);
  assert.throws(() => buildCalendar(Array.from({ length: 51 }, (_, i) => med({ name: `m${i}` })), { now: NOW }), /at most 50/);
});
