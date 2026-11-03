/* "Take it at 08:00 and 20:00, every day" -> the real moments that means.
 *
 * Dates are stepped on the CALENDAR (day 1, day 2, day 3 ...), never by adding
 * 24 hours. On the two days a year when clocks change, a day is 23 or 25 hours
 * long, so adding 24h drifts the reminder by an hour for the next six months.
 * bench/run.js measures how often that happens.
 *
 * A spec is:
 *   times       ["08:00", "20:00"]      clock times, 24-hour
 *   startDate   "2026-11-01"
 *   endDate     "2026-12-01" | null     last day, inclusive; null = no end
 *   everyDays   1                       1 = daily, 2 = every other day ...
 *   weekdays    null | [1,3,5]          0 = Sunday .. 6 = Saturday; null = any
 */
import { localToInstant, wallClock, transitions } from "./tz.js";

const DAY = 86400000;
const MAX_DAYS_SCANNED = 3700; // ten years: a hard stop so a bad spec can't loop forever

export const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseDate(text) {
  const m = DATE.exec(text ?? "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  // Reject 2026-02-30: Date.UTC would quietly roll it into March.
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/** Returns an error message, or null if the spec is usable. */
export function validateSpec(spec) {
  if (!Array.isArray(spec.times) || spec.times.length === 0) return "add at least one time";
  if (spec.times.length > 12) return "at most 12 times a day";
  if (spec.times.some((t) => !TIME.test(t))) return "times look like 08:00 (24-hour)";
  if (new Set(spec.times).size !== spec.times.length) return "the same time is listed twice";
  const start = parseDate(spec.startDate);
  if (!start) return "the start date isn't a real date";
  if (spec.endDate != null) {
    const end = parseDate(spec.endDate);
    if (!end) return "the end date isn't a real date";
    if (Date.UTC(end.y, end.m - 1, end.d) < Date.UTC(start.y, start.m - 1, start.d)) return "the end date is before the start date";
  }
  if (!Number.isInteger(spec.everyDays) || spec.everyDays < 1 || spec.everyDays > 365) return "'every N days' needs a whole number from 1 to 365";
  if (spec.weekdays != null) {
    if (!Array.isArray(spec.weekdays) || spec.weekdays.length === 0) return "pick at least one weekday";
    if (spec.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "weekdays are 0 (Sunday) to 6 (Saturday)";
  }
  if (spec.weekdays != null && spec.everyDays > 1) {
    // Stepping N days at a time visits only some weekdays; if none of them is a
    // chosen one, the reminder would never fire.
    const first = new Date(Date.UTC(start.y, start.m - 1, start.d)).getUTCDay();
    const visited = new Set(Array.from({ length: 7 }, (_, k) => (first + k * spec.everyDays) % 7));
    if (!spec.weekdays.some((d) => visited.has(d))) return "that every-N-days never lands on the weekdays you picked";
  }
  return null;
}

/**
 * The moments the reminders fall on, in order, in the given time zone.
 *
 *   zone     an IANA zone name ("America/New_York")
 *   fromMs   skip anything earlier than this moment
 *   limit    stop after this many
 *
 * Two policy choices, both worth knowing:
 *  - A date that doesn't exist in the zone (Samoa, 30 Dec 2011) gets NO
 *    reminder: that day never happened.
 *  - If two of a day's times land on the same moment because one fell into a
 *    spring-forward gap (02:30 and 03:30 on the day clocks jump 02:00 -> 03:00),
 *    there is ONE reminder, not two at once.
 */
export function occurrences(spec, zone, { fromMs = -Infinity, limit = 100 } = {}) {
  const problem = validateSpec(spec);
  if (problem) throw new Error(problem);

  const start = parseDate(spec.startDate);
  const end = spec.endDate ? parseDate(spec.endDate) : null;
  const endDay = end ? Date.UTC(end.y, end.m - 1, end.d) : Infinity;
  const times = [...spec.times].sort();
  const out = [];

  for (let n = 0; n < MAX_DAYS_SCANNED && out.length < limit; n += spec.everyDays) {
    const dayMs = Date.UTC(start.y, start.m - 1, start.d) + n * DAY; // calendar arithmetic, not clock arithmetic
    if (dayMs > endDay) break;
    const day = new Date(dayMs);
    if (spec.weekdays && !spec.weekdays.includes(day.getUTCDay())) continue;
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();

    const today = [];
    for (const t of times) {
      const [hh, mm] = t.split(":").map(Number);
      const r = localToInstant({ y, m, d, hh, mm }, zone);
      const back = wallClock(r.ms, zone);
      if (back.d !== d || back.m !== m) continue; // that calendar date doesn't exist here
      today.push({ ms: r.ms, kind: r.kind, wanted: { y, m, d, hh, mm } });
    }
    today.sort((a, b) => a.ms - b.ms);
    for (const o of today) {
      if (o.ms < fromMs) continue;
      if (out.length && out[out.length - 1].ms === o.ms) continue; // collapsed into the previous reminder
      if (out.length >= limit) break;
      out.push(o);
    }
  }
  return out;
}

/**
 * Reminders that land in the hour a clock change skips or repeats, in the next
 * `days` days. Those are the ones where calendar apps disagree with each other
 * (bench/ics-check.js: ical.js reads both cases the opposite way to RFC 5545),
 * so the person should be told, with a suggestion, before they depend on it.
 *
 * Returns [{ date, wanted, ranAs, kind: "skipped" | "repeated", window, ms }],
 * where `window` is the exact stretch of the wall clock the change skips or
 * repeats that day, "02:00-03:00" - computed for this zone and date, because
 * clock changes happen at many different hours (bench/README: 10 of 262 in 2026
 * were at midnight or in the evening, so a fixed "avoid 1-3 a.m." would be wrong).
 */
export function edgeWarnings(spec, zone, { fromMs = Date.now(), days = 400 } = {}) {
  const horizon = fromMs + days * DAY;
  return occurrences(spec, zone, { fromMs, limit: 6000 })
    .filter((o) => o.kind !== "ok" && o.ms <= horizon)
    .map((o) => {
      const ran = wallClock(o.ms, zone);
      const p = (n) => String(n).padStart(2, "0");
      // The change responsible is within a day and a half of this reminder.
      const tr = transitions(zone, o.ms - 36 * 3600000, o.ms + 36 * 3600000)[0];
      let window = null;
      if (tr) {
        const before = wallClock(tr.at - 1000, zone);
        const after = wallClock(tr.at, zone);
        const plusOneSecond = new Date(Date.UTC(before.y, before.m - 1, before.d, before.hh, before.mm, before.ss + 1));
        const hhmm = (h, m) => `${p(h)}:${p(m)}`;
        const resumed = hhmm(plusOneSecond.getUTCHours(), plusOneSecond.getUTCMinutes());
        const reading = hhmm(after.hh, after.mm);
        window = tr.to > tr.from ? `${resumed}-${reading}` : `${reading}-${resumed}`;
      }
      const { y, m, d, hh, mm } = o.wanted;
      return {
        date: `${y}-${p(m)}-${p(d)}`,
        wanted: `${p(hh)}:${p(mm)}`,
        ranAs: `${p(ran.hh)}:${p(ran.mm)}`,
        kind: o.kind === "gap" ? "skipped" : "repeated",
        window,
        ms: o.ms,
      };
    });
}
