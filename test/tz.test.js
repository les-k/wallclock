import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wallClock, offsetAt, localToInstant, transitions, isValidZone, allZones, formatOffset,
} from "../src/tz.js";
import { createRng } from "../src/rng.js";

const H = 3600000;
const utc = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh, mm);
const at = (y, m, d, hh, mm, tz) => localToInstant({ y, m, d, hh, mm }, tz);

/* Known answers, worked out by hand from the published rules (2026: US clocks
 * change on 8 March and 1 November; UK on 29 March and 25 October). */

test("offsets: summer, winter, and a zone with no daylight saving", () => {
  assert.equal(offsetAt(utc(2026, 7, 1, 12), "America/New_York"), -4 * H);
  assert.equal(offsetAt(utc(2026, 1, 1, 12), "America/New_York"), -5 * H);
  assert.equal(offsetAt(utc(2026, 7, 1, 12), "Asia/Kolkata"), 5.5 * H);
  assert.equal(offsetAt(utc(2026, 1, 1, 12), "Asia/Kolkata"), 5.5 * H);
  assert.equal(offsetAt(utc(2026, 7, 1, 12), "Europe/London"), 1 * H);
  assert.equal(offsetAt(utc(2026, 1, 1, 12), "UTC"), 0);
});

test("an ordinary day: 08:00 is the same wall time but a different real moment either side of a change", () => {
  assert.deepEqual(at(2026, 3, 7, 8, 0, "America/New_York"), { ms: utc(2026, 3, 7, 13), kind: "ok" }); // EST
  assert.deepEqual(at(2026, 3, 8, 8, 0, "America/New_York"), { ms: utc(2026, 3, 8, 12), kind: "ok" }); // EDT
  assert.deepEqual(at(2026, 11, 1, 8, 0, "America/New_York"), { ms: utc(2026, 11, 1, 13), kind: "ok" }); // EST again
  // Which is the whole point: the gap between consecutive 08:00s is not 24 hours.
  const gap = at(2026, 3, 8, 8, 0, "America/New_York").ms - at(2026, 3, 7, 8, 0, "America/New_York").ms;
  assert.equal(gap / H, 23);
});

test("spring forward: 02:30 does not exist, and is read with the offset from before the change", () => {
  const r = at(2026, 3, 8, 2, 30, "America/New_York");
  assert.equal(r.kind, "gap");
  assert.equal(r.ms, utc(2026, 3, 8, 7, 30)); // 02:30 at -05:00 = 07:30Z = 03:30 EDT
  assert.deepEqual(wallClock(r.ms, "America/New_York"), { y: 2026, m: 3, d: 8, hh: 3, mm: 30, ss: 0 });
  // The edges of the gap are real times.
  assert.equal(at(2026, 3, 8, 1, 59, "America/New_York").kind, "ok");
  assert.equal(at(2026, 3, 8, 3, 0, "America/New_York").kind, "ok");
  assert.equal(at(2026, 3, 8, 2, 0, "America/New_York").kind, "gap");
});

test("fall back: 01:30 happens twice, and the first one is chosen", () => {
  const r = at(2026, 11, 1, 1, 30, "America/New_York");
  assert.equal(r.kind, "overlap");
  assert.equal(r.ms, utc(2026, 11, 1, 5, 30)); // EDT, -04:00; the second 01:30 would be 06:30Z
  assert.deepEqual(wallClock(utc(2026, 11, 1, 6, 30), "America/New_York"), { y: 2026, m: 11, d: 1, hh: 1, mm: 30, ss: 0 }, "the later moment also reads 01:30");
  assert.equal(at(2026, 11, 1, 0, 59, "America/New_York").kind, "ok");
  assert.equal(at(2026, 11, 1, 2, 0, "America/New_York").kind, "ok");
});

test("London: 01:30 on 29 March 2026 does not exist; 01:30 on 25 October 2026 happens twice", () => {
  const gap = at(2026, 3, 29, 1, 30, "Europe/London");
  assert.deepEqual(gap, { ms: utc(2026, 3, 29, 1, 30), kind: "gap" }); // 01:30 GMT = 02:30 BST
  assert.deepEqual(wallClock(gap.ms, "Europe/London"), { y: 2026, m: 3, d: 29, hh: 2, mm: 30, ss: 0 });
  assert.deepEqual(at(2026, 10, 25, 1, 30, "Europe/London"), { ms: utc(2026, 10, 25, 0, 30), kind: "overlap" }); // BST first
});

test("Lord Howe Island shifts by 30 minutes, not an hour", () => {
  // 4 Oct 2026: 02:00 (+10:30) -> 02:30 (+11:00). 02:15 does not exist.
  const r = at(2026, 10, 4, 2, 15, "Australia/Lord_Howe");
  assert.equal(r.kind, "gap");
  assert.deepEqual(wallClock(r.ms, "Australia/Lord_Howe"), { y: 2026, m: 10, d: 4, hh: 2, mm: 45, ss: 0 });
  assert.equal(at(2026, 10, 4, 2, 30, "Australia/Lord_Howe").kind, "ok");
});

test("Samoa skipped 30 December 2011 entirely: a whole date with no clock times", () => {
  const r = at(2011, 12, 30, 8, 0, "Pacific/Apia");
  assert.equal(r.kind, "gap");
  assert.equal(r.ms, utc(2011, 12, 30, 18, 0));
  // Read on the clocks that now apply, that moment is 31 December - a different date.
  assert.deepEqual(wallClock(r.ms, "Pacific/Apia"), { y: 2011, m: 12, d: 31, hh: 8, mm: 0, ss: 0 });
  assert.equal(at(2011, 12, 29, 8, 0, "Pacific/Apia").kind, "ok");
  assert.equal(at(2011, 12, 31, 8, 0, "Pacific/Apia").kind, "ok");
});

test("transitions: found to the second, in order, and none where there is no daylight saving", () => {
  const ny = transitions("America/New_York", utc(2026, 1, 1), utc(2027, 1, 1));
  assert.deepEqual(ny, [
    { at: utc(2026, 3, 8, 7, 0), from: -5 * H, to: -4 * H },
    { at: utc(2026, 11, 1, 6, 0), from: -4 * H, to: -5 * H },
  ]);
  assert.deepEqual(transitions("Asia/Kolkata", utc(2026, 1, 1), utc(2027, 1, 1)), []);
  assert.equal(transitions("Australia/Lord_Howe", utc(2026, 1, 1), utc(2027, 1, 1)).length, 2);
  const apia = transitions("Pacific/Apia", utc(2011, 12, 1), utc(2012, 1, 31));
  assert.deepEqual(apia, [{ at: utc(2011, 12, 30, 10, 0), from: -10 * H, to: 14 * H }]);
});

test("small helpers", () => {
  assert.equal(formatOffset(5.5 * H), "+05:30");
  assert.equal(formatOffset(-4 * H), "-04:00");
  assert.equal(formatOffset(0), "+00:00");
  assert.equal(formatOffset(12.75 * H), "+12:45");
  assert.equal(isValidZone("America/New_York"), true);
  assert.equal(isValidZone("Mars/Olympus_Mons"), false);
  assert.equal(isValidZone(""), false);
  assert.ok(allZones().length > 400);
});

test("SWEEP: for every zone and 40 random wall-clock times each, the answer reads back correctly", () => {
  const rng = createRng(20261101);
  let checked = 0;
  const kinds = { ok: 0, gap: 0, overlap: 0 };
  for (const zone of allZones()) {
    for (let k = 0; k < 40; k += 1) {
      const wanted = { y: 2000 + rng.int(31), m: 1 + rng.int(12), d: 1 + rng.int(28), hh: rng.int(24), mm: rng.int(60) };
      const r = localToInstant(wanted, zone);
      const back = wallClock(r.ms, zone);
      const readsAsWanted = back.y === wanted.y && back.m === wanted.m && back.d === wanted.d && back.hh === wanted.hh && back.mm === wanted.mm;
      kinds[r.kind] += 1;
      if (r.kind === "gap") {
        // Pushed forward, never back: the clock now reads LATER than what was asked for.
        const asked = Date.UTC(wanted.y, wanted.m - 1, wanted.d, wanted.hh, wanted.mm);
        const got = Date.UTC(back.y, back.m - 1, back.d, back.hh, back.mm, back.ss);
        assert.ok(got > asked, `${zone} ${JSON.stringify(wanted)}: gap time was pulled back`);
        assert.ok(got - asked <= 25 * H, `${zone} ${JSON.stringify(wanted)}: pushed by more than a day`);
      } else {
        assert.ok(readsAsWanted, `${zone} ${JSON.stringify(wanted)} (${r.kind}) reads back as ${JSON.stringify(back)}`);
      }
      if (r.kind === "overlap") {
        // The other reading of the same wall time must be later: we took the first.
        const second = [r.ms + H / 2, r.ms + H, r.ms + 1.5 * H, r.ms + 2 * H, r.ms + 24 * H].find((t) => {
          const w = wallClock(t, zone);
          return w.y === wanted.y && w.m === wanted.m && w.d === wanted.d && w.hh === wanted.hh && w.mm === wanted.mm;
        });
        assert.ok(second === undefined || second > r.ms, `${zone}: a later reading exists, so the earlier must have been chosen`);
      }
      checked += 1;
    }
  }
  assert.ok(checked > 16000);
  assert.ok(kinds.gap + kinds.overlap > 0, "the sweep must actually meet some gaps/overlaps to prove anything");
});
