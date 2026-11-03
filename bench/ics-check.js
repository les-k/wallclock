/* Does a calendar engine read the file we write the way we meant it?
 *
 *   node bench/ics-check.js      -> bench/ics-results.json
 *
 * For every zone that changes its clocks in 2026, write a calendar file with
 * reminders chosen to land in the awkward places (a time that doesn't exist, a
 * time that happens twice, an ordinary time) in the week around the change,
 * parse it with ical.js - an independent JavaScript calendar implementation,
 * originally Mozilla's - expand the recurrence, and compare every reminder's real
 * moment with src/schedule.js.
 *
 * Imported by test/ics.test.js, which asserts on the result.
 */
import ICAL from "ical.js";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCalendar } from "../src/ics.js";
import { occurrences } from "../src/schedule.js";
import { allZones, transitions, wallClock } from "../src/tz.js";

const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const YEAR = 2026;
const DAY = 86400000;

export function checkAllZones({ zones = allZones(), now = Date.UTC(YEAR, 10, 3) } = {}) {
  const stats = {
    year: YEAR,
    zonesChecked: 0,
    zonesWithAChange: 0,
    reminders: { ordinary: { compared: 0, agree: 0 }, gap: { compared: 0, agree: 0 }, overlap: { compared: 0, agree: 0 } },
    zonesWhereCalendarEngineDisagrees: [],
    // How ical.js differs, in the two awkward cases, relative to RFC 5545 (which this code follows):
    skippedTimeReadEarlierByTheClockChange: 0,
    repeatedTimeReadLaterByTheClockChange: 0,
    disagreementsWithAnyOtherPattern: 0,
  };

  for (const zone of zones) {
    stats.zonesChecked += 1;
    const changes = transitions(zone, Date.UTC(YEAR, 0, 1), Date.UTC(YEAR + 1, 0, 1));
    if (!changes.length) continue;
    stats.zonesWithAChange += 1;
    let zoneDisagrees = false;
    // Every clock change in the year, not just the first: the first is always
    // 'forward' in the northern hemisphere, which would leave 'back' untested.
    for (const t of changes) {

    const before = wallClock(t.at - 1000, zone);
    const after = wallClock(t.at, zone);
    const times = new Set(["12:00"]);
    if (t.to > t.from) {
      // clocks go forward: the gap starts the second after `before`
      const g = new Date(Date.UTC(2000, 0, 1, before.hh, before.mm + 1));
      times.add(`${pad(g.getUTCHours())}:${pad(g.getUTCMinutes())}`);
      times.add(`${pad((g.getUTCHours() + (g.getUTCMinutes() + 15 >= 60 ? 1 : 0)) % 24)}:${pad((g.getUTCMinutes() + 15) % 60)}`);
    } else {
      // clocks go back: the repeated stretch starts at the post-change reading
      times.add(`${pad(after.hh)}:${pad(after.mm)}`);
      const o = new Date(Date.UTC(2000, 0, 1, after.hh, after.mm + 15));
      times.add(`${pad(o.getUTCHours())}:${pad(o.getUTCMinutes())}`);
    }
    const med = { name: "Pill", times: [...times], startDate: fmt(new Date(t.at - 3 * DAY)), endDate: fmt(new Date(t.at + 3 * DAY)), everyDays: 1, weekdays: null };

    const mine = occurrences(med, zone, { limit: 100 });
    const root = new ICAL.Component(ICAL.parse(buildCalendar([med], { mode: "zone", zone, now })));
    ICAL.TimezoneService.reset();
    for (const tz of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(new ICAL.Timezone(tz));
    const theirs = new Set();
    for (const ve of root.getAllSubcomponents("vevent")) {
      const it = new ICAL.Event(ve).iterator();
      for (let x; (x = it.next()); ) theirs.add(x.toUnixTime() * 1000);
    }

    const size = Math.abs(t.to - t.from); // how far the clocks moved
    let disagreed = false;
    for (const m of mine) {
      const bucket = m.kind === "ok" ? "ordinary" : m.kind;
      stats.reminders[bucket].compared += 1;
      if (theirs.has(m.ms)) stats.reminders[bucket].agree += 1;
      else {
        disagreed = true;
        if (m.kind === "gap" && theirs.has(m.ms - size)) stats.skippedTimeReadEarlierByTheClockChange += 1;
        else if (m.kind === "overlap" && theirs.has(m.ms + size)) stats.repeatedTimeReadLaterByTheClockChange += 1;
        else stats.disagreementsWithAnyOtherPattern += 1;
      }
    }
    if (disagreed) zoneDisagrees = true;
    }
    if (zoneDisagrees) stats.zonesWhereCalendarEngineDisagrees.push(zone);
  }
  return stats;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stats = checkAllZones();
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "ics-results.json"), JSON.stringify(stats, null, 2) + "\n");
  const r = stats.reminders;
  console.log(`${stats.zonesWithAChange} of ${stats.zonesChecked} zones change clocks in ${YEAR}; every change in each was tested`);
  for (const k of ["ordinary", "gap", "overlap"]) console.log(`  ${k.padEnd(9)} reminders: ${r[k].agree} of ${r[k].compared} agree with the calendar engine`);
  console.log(`  zones where it disagrees: ${stats.zonesWhereCalendarEngineDisagrees.length}`);
  console.log(`  skipped time read ONE CLOCK-CHANGE EARLIER than RFC 5545: ${stats.skippedTimeReadEarlierByTheClockChange}`);
  console.log(`  repeated time read as the SECOND occurrence             : ${stats.repeatedTimeReadLaterByTheClockChange}`);
  console.log(`  any other kind of disagreement                          : ${stats.disagreementsWithAnyOtherPattern}`);
}
