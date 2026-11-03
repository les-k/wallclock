/* Two checks against Python's zoneinfo (bench/oracle.py).
 *
 *   node bench/oracle.js     -> bench/oracle-results.json
 *   PYTHON=/path/to/python node bench/oracle.js     if `python` isn't the right one
 *
 * CHECK 1  Does src/tz.js agree with a separate implementation?
 *          Every day on or next to a clock change in every zone, 2000-2024,
 *          at times chosen to land in gaps and overlaps, plus random times.
 *          Restricted to dates the two time-zone databases agree on by
 *          construction: the runtime's is 2024b, Python's is whatever
 *          `tzdata` is installed - rules for 2000-2024 are settled history.
 *
 * CHECK 2  How stale is a time-zone database? Governments change clock rules,
 *          often at short notice. Compare the clock changes the two databases
 *          predict for 2025-2030 and count the zones where they differ. A
 *          calendar file generated from the older rules would fire an hour out
 *          in exactly those zones.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { allZones, transitions, localToInstant, wallClock } from "../src/tz.js";
import { createRng } from "../src/rng.js";

const here = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.env.PYTHON || "python";
const py = (mode, payload) =>
  JSON.parse(execFileSync(PYTHON, [join(here, "oracle.py"), mode], { input: JSON.stringify(payload), maxBuffer: 1 << 28, encoding: "utf8" }));

const versions = py("version", {});
const zones = allZones();
const DAY = 86400000;

/* ------------------------------------------------------------- CHECK 1 */

const rng = createRng(20261103);
const cases = [];
const TIMES = [[0, 30], [1, 30], [2, 30], [3, 30], [12, 0], [23, 30]];
for (const zone of zones) {
  for (const t of transitions(zone, Date.UTC(2000, 0, 1), Date.UTC(2025, 0, 1))) {
    const w = wallClock(t.at, zone);
    for (const dayShift of [-1, 0, 1]) {
      const d = new Date(Date.UTC(w.y, w.m - 1, w.d) + dayShift * DAY);
      for (const [hh, mm] of TIMES) cases.push({ zone, y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh, mm });
    }
  }
  for (let k = 0; k < 20; k += 1) cases.push({ zone, y: 2000 + rng.int(25), m: 1 + rng.int(12), d: 1 + rng.int(28), hh: rng.int(24), mm: rng.int(60) });
}

const theirs = py("convert", cases);
let compared = 0;
let skipped = 0;
const kinds = { ok: 0, gap: 0, overlap: 0 };
const disagreements = [];
cases.forEach((c, i) => {
  if (theirs[i] == null) return void (skipped += 1);
  const mine = localToInstant(c, c.zone);
  compared += 1;
  kinds[mine.kind] += 1;
  if (mine.ms !== theirs[i]) {
    // Is MY answer at least consistent with the runtime's own clock? If the
    // runtime says the wanted time is what its clock reads at my instant, the
    // disagreement is the two databases differing, not my conversion.
    const back = wallClock(mine.ms, c.zone);
    const consistent = back.y === c.y && back.m === c.m && back.d === c.d && back.hh === c.hh && back.mm === c.mm;
    disagreements.push({ ...c, mine: new Date(mine.ms).toISOString(), theirs: new Date(theirs[i]).toISOString(), kind: mine.kind, myAnswerReadsBackOnRuntimeClock: consistent });
  }
});

/* ------------------------------------------------------------- CHECK 2 */

const FROM = Date.UTC(2025, 0, 1);
const TO = Date.UTC(2031, 0, 1);
const pyTransitions = py("transitions", { zones, from: FROM, to: TO });
const differing = [];
let bothKnown = 0;
for (const zone of zones) {
  const theirsT = pyTransitions[zone];
  if (theirsT == null) continue;
  bothKnown += 1;
  const mineT = transitions(zone, FROM, TO);
  const key = (arr) => arr.map((t) => `${t.at}:${t.from}>${t.to}`).join("|");
  if (key(mineT) !== key(theirsT)) {
    differing.push({ zone, runtimeChanges2025to2030: mineT.length, tzdataChanges2025to2030: theirsT.length });
  }
}

const evidenceZones = [...new Set(disagreements.map((d) => d.zone))];
const evidence = Object.keys(pyTransitions).length && evidenceZones.length
  ? py("transitions", { zones: evidenceZones, from: Date.UTC(2024, 0, 1), to: Date.UTC(2025, 0, 1) })
  : {};
const iso = (t) => ({ at: new Date(t.at).toISOString(), fromHours: t.from / 3600000, toHours: t.to / 3600000 });

const out = {
  runtime: { node: process.version, tzDatabase: process.versions.tz },
  python: versions,
  check1_agreement: {
    years: "2000-2024",
    zones: zones.length,
    casesCompared: compared,
    skippedZoneNotInPython: skipped,
    byKind: kinds,
    disagreements: disagreements.length,
    disagreementsWhereMyAnswerReadsBackCorrectlyOnTheRuntimeClock: disagreements.filter((d) => d.myAnswerReadsBackOnRuntimeClock).length,
    zonesInvolved: [...new Set(disagreements.map((d) => d.zone))],
    firstFew: disagreements.slice(0, 10),
    clockChangesIn2024ByDatabase: Object.fromEntries(evidenceZones.map((z) => [z, { runtime: transitions(z, Date.UTC(2024, 0, 1), Date.UTC(2025, 0, 1)).map(iso), tzdata: (evidence[z] ?? []).map(iso) }])),
  },
  check2_staleData: {
    window: "2025-2030",
    zonesCompared: bothKnown,
    zonesWhereTheTwoDatabasesPredictDifferentClockChanges: differing.length,
    zones: differing,
  },
};
writeFileSync(join(here, "oracle-results.json"), JSON.stringify(out, null, 2) + "\n");

console.log(`runtime tz database ${process.versions.tz}; python ${versions.python} with tzdata ${versions.tzdata}`);
console.log(`\nCHECK 1: ${compared.toLocaleString()} cases (${kinds.ok.toLocaleString()} ordinary, ${kinds.gap} in a gap, ${kinds.overlap} in an overlap)`);
console.log(`  disagreements with Python: ${disagreements.length}`);
for (const d of disagreements.slice(0, 5)) console.log("   ", JSON.stringify(d));
console.log(`\nCHECK 2: ${differing.length} of ${bothKnown} zones have different clock changes for 2025-2030 between the two databases`);
for (const z of differing.slice(0, 25)) console.log(`   ${z.zone.padEnd(28)} runtime ${z.runtimeChanges2025to2030} changes, tzdata ${z.tzdataChanges2025to2030}`);
