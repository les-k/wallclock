/* Clock time <-> real moments, for any time zone, using only what the browser
 * (or Node) already knows. No time-zone library.
 *
 * The one question this answers: "when, exactly, is 08:00 on 8 March 2026 in
 * New York?" Easy on most days. Twice a year it isn't:
 *
 *   spring forward   02:30 never happens (the clock jumps 02:00 -> 03:00)
 *   fall back        01:30 happens twice
 *
 * and a few places have skipped a whole date (Samoa went from 29 to 31 December
 * 2011). Every one of those needs a rule, and the rule has to be chosen, not
 * stumbled into. These are the same rules RFC 5545 (calendar files) and
 * Python's zoneinfo use, so a calendar app and this code agree:
 *
 *   a time that doesn't exist  -> read with the offset from BEFORE the change
 *                                 (02:30 becomes 03:30)
 *   a time that happens twice  -> the FIRST one
 */

const formatters = new Map();
function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of a moment in a zone: { y, m, d, hh, mm, ss }. */
export function wallClock(ms, timeZone) {
  const parts = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = Number(p.value);
  return { y: parts.year, m: parts.month, d: parts.day, hh: parts.hour, mm: parts.minute, ss: parts.second };
}

/** How far ahead of UTC the zone's clocks are at this moment, in ms. */
export function offsetAt(ms, timeZone) {
  const w = wallClock(ms, timeZone);
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) - Math.floor(ms / 1000) * 1000;
}

/**
 * The moment (ms since 1970, UTC) at which a zone's clock reads y-m-d hh:mm.
 * See the file header for what happens when that time doesn't exist or happens
 * twice. `kind` says which it was: "ok" | "gap" | "overlap".
 */
export function localToInstant({ y, m, d, hh, mm }, timeZone) {
  const wanted = Date.UTC(y, m - 1, d, hh, mm, 0);
  // Reading the wanted clock time as if it were UTC, the real moment is within
  // 14 hours of it, so the offsets a day either side bracket every possibility.
  const before = offsetAt(wanted - 86400000, timeZone);
  const after = offsetAt(wanted + 86400000, timeZone);
  const valid = [];
  for (const offset of new Set([before, after])) {
    const candidate = wanted - offset;
    if (offsetAt(candidate, timeZone) === offset) valid.push(candidate);
  }
  if (valid.length === 2) return { ms: Math.min(...valid), kind: "overlap" };
  if (valid.length === 1) return { ms: valid[0], kind: "ok" };
  return { ms: wanted - before, kind: "gap" };
}

/**
 * Every clock change between two moments, found by sampling the offset twice a
 * day and bisecting down to the exact second. Returns
 * [{ at, from, to }] with `at` the moment of the change (ms) and from/to the
 * offsets either side (ms).
 */
export function transitions(timeZone, fromMs, toMs) {
  const out = [];
  const STEP = 12 * 3600000;
  let t0 = fromMs;
  let o0 = offsetAt(t0, timeZone);
  for (let t1 = fromMs + STEP; ; t1 += STEP) {
    if (t1 > toMs) t1 = toMs;
    const o1 = offsetAt(t1, timeZone);
    if (o1 !== o0) {
      let lo = t0;
      let hi = t1;
      while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
        if (offsetAt(mid, timeZone) === o0) lo = mid;
        else hi = mid;
      }
      out.push({ at: hi, from: o0, to: offsetAt(hi, timeZone) });
    }
    t0 = t1;
    o0 = o1;
    if (t1 >= toMs) break;
  }
  return out;
}

/** Is this a time zone the runtime knows? */
export function isValidZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export const allZones = () => Intl.supportedValuesOf("timeZone");
export const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** "+05:30" style label for an offset in ms. */
export function formatOffset(ms) {
  const sign = ms < 0 ? "-" : "+";
  const total = Math.round(Math.abs(ms) / 60000);
  return `${sign}${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
