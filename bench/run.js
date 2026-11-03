/* How wrong is "repeat every 24 hours", in every time zone?
 *
 *   node bench/run.js        -> bench/results.json
 *
 * For each of the ~417 zones the runtime knows, a daily 08:00 reminder over one
 * year, started on the 1st of each month in turn (a reminder can be created at
 * any time of year, and the answer depends on when). The correct schedule is
 * src/schedule.js; the shortcut is bench/naive.js. A reminder is "wrong" if the
 * clock on the wall doesn't read 08:00 when it fires.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allZones, wallClock, transitions } from "../src/tz.js";
import { occurrences } from "../src/schedule.js";
import { everyTwentyFourHours } from "./naive.js";

const YEAR = 2026;
const DAYS = 365;
const TIME = "08:00";
const zones = allZones();
const t0 = performance.now();

/* ------------------------------------------------ E1: the shortcut, measured */

const perZone = [];
let totalReminders = 0;
let totalWrong = 0;
const driftHistogram = new Map(); // minutes off -> reminders

for (const zone of zones) {
  let wrong = 0;
  let reminders = 0;
  let worst = 0;
  for (let month = 1; month <= 12; month += 1) {
    const startDate = `${YEAR}-${String(month).padStart(2, "0")}-01`;
    const naive = everyTwentyFourHours({ time: TIME, startDate }, zone, DAYS);
    // The correct schedule has one entry per date that exists; the shortcut has
    // one per 24h. Compare the clock each one reads when it fires.
    for (const ms of naive) {
      const w = wallClock(ms, zone);
      const driftMin = (w.hh * 60 + w.mm) - 8 * 60;
      const wrapped = driftMin > 720 ? driftMin - 1440 : driftMin < -720 ? driftMin + 1440 : driftMin;
      reminders += 1;
      if (wrapped !== 0) {
        wrong += 1;
        worst = Math.max(worst, Math.abs(wrapped));
        driftHistogram.set(wrapped, (driftHistogram.get(wrapped) ?? 0) + 1);
      }
    }
  }
  totalReminders += reminders;
  totalWrong += wrong;
  perZone.push({ zone, wrong, reminders, worstDriftMinutes: worst });
}

const affected = perZone.filter((z) => z.wrong > 0);
const e1 = {
  year: YEAR,
  time: TIME,
  startsPerZone: 12,
  daysPerStart: DAYS,
  zones: zones.length,
  zonesWhereShortcutIsEverWrong: affected.length,
  zonesWhereShortcutIsAlwaysRight: zones.length - affected.length,
  remindersTotal: totalReminders,
  remindersWrong: totalWrong,
  pctOfAllRemindersWrong: Math.round((totalWrong / totalReminders) * 1000) / 10,
  pctWrongInZonesWithClockChanges: Math.round((affected.reduce((s, z) => s + z.wrong, 0) / affected.reduce((s, z) => s + z.reminders, 0)) * 1000) / 10,
  driftMinutesHistogram: [...driftHistogram.entries()].sort((a, b) => a[0] - b[0]).map(([minutes, count]) => ({ minutes, count })),
  worstDriftMinutes: Math.max(...perZone.map((z) => z.worstDriftMinutes)),
};

/* The correct schedule, run over the same inputs, must never be wrong. */
let correctWrong = 0;
let correctChecked = 0;
let correctGapDays = 0;
for (const zone of zones) {
  const o = occurrences({ times: [TIME], startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31`, everyDays: 1, weekdays: null }, zone, { limit: 400 });
  for (const x of o) {
    const w = wallClock(x.ms, zone);
    correctChecked += 1;
    if (w.hh !== 8 || w.mm !== 0) {
      if (x.kind === "gap") correctGapDays += 1;
      else correctWrong += 1;
    }
  }
}
e1.correctSchedule = { remindersChecked: correctChecked, wrong: correctWrong, movedBecauseTheTimeDidNotExist: correctGapDays };

/* ----------------------------------- E2: when in the day do clocks change? */

const hourHits = new Map(); // "skipped 02" -> clock changes that skip (or repeat) the hour starting at 02:00
let zonesWithChanges = 0;
let changesTotal = 0;
for (const zone of zones) {
  const tr = transitions(zone, Date.UTC(YEAR, 0, 1), Date.UTC(YEAR + 1, 0, 1));
  if (tr.length) zonesWithChanges += 1;
  for (const t of tr) {
    changesTotal += 1;
    const before = wallClock(t.at - 1000, zone); // the wall reading a second before the change
    const after = wallClock(t.at, zone); // ... and at the change
    // Clocks jumping forward skip the hour that starts one second after `before`;
    // clocks falling back repeat the hour that starts at `after`.
    const startHour = t.to > t.from ? (before.hh + 1) % 24 : after.hh;
    const key = `${t.to > t.from ? "skipped" : "repeated"} ${String(startHour).padStart(2, "0")}:00`;
    hourHits.set(key, (hourHits.get(key) ?? 0) + 1);
  }
}
const hourOf = (k) => Number(k.slice(-5, -3));
const inRange = (lo, hi) => [...hourHits.entries()].filter(([k]) => hourOf(k) >= lo && hourOf(k) <= hi).reduce((sum, [, n]) => sum + n, 0);
const e2 = {
  year: YEAR,
  zonesWithAtLeastOneClockChange: zonesWithChanges,
  zonesWithNone: zones.length - zonesWithChanges,
  clockChangesTotal: changesTotal,
  hourAffected: [...hourHits.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([hour, count]) => ({ hour, count })),
  changesBetween01and03: inRange(1, 3),
  changesBetween00and03: inRange(0, 3),
  changesOutside00to03: changesTotal - inRange(0, 3),
};

const results = { node: process.version, tzDatabase: process.versions.tz, seconds: Math.round((performance.now() - t0) / 100) / 10, e1, e2 };
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "results.json"), JSON.stringify(results, null, 2) + "\n");

/* ------------------------------------------------------------------ report */

console.log(`${zones.length} zones, tz database ${process.versions.tz}, ${results.seconds}s\n`);
console.log(`Daily ${TIME}, repeated every 24 hours, a year from the 1st of each month:`);
console.log(`  zones where the shortcut is ever wrong : ${e1.zonesWhereShortcutIsEverWrong} of ${zones.length}`);
console.log(`  reminders firing at the wrong clock time: ${e1.remindersWrong.toLocaleString()} of ${e1.remindersTotal.toLocaleString()} (${e1.pctOfAllRemindersWrong}% overall, ${e1.pctWrongInZonesWithClockChanges}% in zones that change clocks)`);
console.log(`  worst drift                             : ${e1.worstDriftMinutes} minutes`);
console.log("  drift sizes (minutes: reminders):", e1.driftMinutesHistogram.map((h) => `${h.minutes > 0 ? "+" : ""}${h.minutes}: ${h.count.toLocaleString()}`).join(" | "));
console.log(`\nThis project's schedule, same zones, ${e1.correctSchedule.remindersChecked.toLocaleString()} reminders: ${e1.correctSchedule.wrong} wrong`);
console.log(`\nClock changes in ${YEAR}: ${e2.clockChangesTotal} across ${e2.zonesWithAtLeastOneClockChange} zones (${e2.zonesWithNone} never change)`);
console.log(`  the skipped or repeated hour starts between 01:00 and 03:00 in ${e2.changesBetween01and03}, between 00:00 and 03:00 in ${e2.changesBetween00and03}; outside that in ${e2.changesOutside00to03}`);
for (const w of e2.hourAffected) console.log(`  ${w.hour.padEnd(16)} ${w.count}`);
console.log("\nwrote bench/results.json");
