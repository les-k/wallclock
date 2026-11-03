/* Reminders -> a calendar file (.ics) the phone's own calendar turns into alarms.
 *
 * Why a calendar file and not notifications from this page: a web page can only
 * alert you while it is open, and browsers throttle or kill background pages.
 * For medication, "usually works" is not good enough, so the page's job is to
 * write down the schedule precisely and hand it to the one program that is
 * built to fire alarms reliably with the app closed - the calendar.
 *
 * Two ways to say what time it is (see the README for the measurements):
 *
 *   "floating"  08:00 on whatever clock the phone is showing, wherever it is.
 *               No time zone is written down, so there is nothing to go stale
 *               when a government changes its clock rules, and the phone's own
 *               calendar handles every daylight-saving change. The default.
 *   "zone"      08:00 on one named place's clock. Needs the zone's rules written
 *               into the file (a VTIMEZONE), which freezes the rules known today.
 */
import { localToInstant, offsetAt, transitions } from "./tz.js";
import { occurrences, parseDate, validateSpec } from "./schedule.js";

const CRLF = "\r\n";
const DAY = 86400000;
const WEEKDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const pad = (n, w = 2) => String(n).padStart(w, "0");
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
const local = (y, m, d, hh, mm, ss = 0) => `${pad(y, 4)}${pad(m)}${pad(d)}T${pad(hh)}${pad(mm)}${pad(ss)}`;

/** Escape a TEXT value (RFC 5545 3.3.11): backslash, semicolon, comma, newline. */
export function escapeText(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Fold a content line at 75 octets, never splitting a multi-byte character. */
export function fold(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    if (bytes + n > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = 74; // continuation lines start with a space, which counts
    }
    current += ch;
    bytes += n;
  }
  parts.push(current);
  return parts.join(CRLF + " ");
}

/** A short, stable fingerprint, so re-importing the same reminder updates it instead of duplicating it. */
function fingerprint(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

const offsetText = (ms) => {
  const sign = ms < 0 ? "-" : "+";
  const total = Math.round(Math.abs(ms) / 1000);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${sign}${pad(hh)}${pad(mm)}${ss ? pad(ss) : ""}`;
};

/**
 * The rules of one zone over [fromMs, toMs], as a VTIMEZONE: every clock change
 * written out explicitly. After the last one listed, calendars keep the final
 * offset, so the window has to cover as far as the reminders run.
 */
export function vtimezone(zone, fromMs, toMs) {
  const changes = transitions(zone, fromMs, toMs);
  const start = offsetAt(fromMs, zone);
  const lines = ["BEGIN:VTIMEZONE", `TZID:${zone}`, "BEGIN:STANDARD", "DTSTART:19700101T000000", `TZOFFSETFROM:${offsetText(start)}`, `TZOFFSETTO:${offsetText(start)}`, "END:STANDARD"];
  for (const t of changes) {
    // DTSTART of a change is the wall-clock time on the OLD clock when it happens.
    const d = new Date(t.at + t.from);
    const kind = t.to > t.from ? "DAYLIGHT" : "STANDARD";
    lines.push(`BEGIN:${kind}`, `DTSTART:${local(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds())}`, `TZOFFSETFROM:${offsetText(t.from)}`, `TZOFFSETTO:${offsetText(t.to)}`, `END:${kind}`);
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

/**
 * The first date the rule actually lands on. It must be a whole number of
 * "every N days" steps from the start date, NOT merely the first matching
 * weekday: for "every 2 days, weekends only" starting on a Monday, the days are
 * Monday + 0, 2, 4, 6... and counting the steps from a Saturday instead would
 * pick the other parity and a different set of days than the app shows.
 */
function firstDate(med) {
  const s = parseDate(med.startDate);
  for (let n = 0; n <= 7 * med.everyDays; n += med.everyDays) {
    const d = new Date(Date.UTC(s.y, s.m - 1, s.d) + n * DAY);
    if (!med.weekdays || med.weekdays.includes(d.getUTCDay())) return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }
  throw new Error("those weekdays never line up with every-N-days");
}

/**
 * @param meds  [{ name, notes?, times, startDate, endDate, everyDays, weekdays }]
 * @param opts  mode "floating" (default) | "zone"; zone for mode "zone"; now (ms) for DTSTAMP
 */
export function buildCalendar(meds, { mode = "floating", zone = null, now = Date.now() } = {}) {
  if (!Array.isArray(meds) || meds.length === 0) throw new Error("add at least one medication");
  if (meds.length > 50) throw new Error("at most 50 medications in one file");
  if (mode !== "floating" && mode !== "zone") throw new Error("mode must be floating or zone");
  if (mode === "zone" && !zone) throw new Error("a zone is needed for mode zone");

  const events = [];
  const seen = new Set();
  let windowEnd = 0;

  meds.forEach((med, mi) => {
    const name = String(med.name ?? "").trim();
    if (!name) throw new Error(`medication ${mi + 1} needs a name`);
    if (name.length > 80) throw new Error(`"${name.slice(0, 20)}…" is too long a name (80 characters at most)`);
    const problem = validateSpec(med);
    if (problem) throw new Error(`${name}: ${problem}`);
    const day = firstDate(med);

    for (const time of [...med.times].sort()) {
      const [hh, mm] = time.split(":").map(Number);
      const uid = `${fingerprint(JSON.stringify([name, med.notes ?? "", time, med.startDate, med.endDate ?? null, med.everyDays, med.weekdays ?? null, mode, zone]))}@wallclock`;
      if (seen.has(uid)) continue; // an identical reminder listed twice is one reminder
      seen.add(uid);

      const rule = ["FREQ=DAILY", `INTERVAL=${med.everyDays}`];
      if (med.weekdays) rule.push(`BYDAY=${[...med.weekdays].sort().map((d) => WEEKDAY[d]).join(",")}`);
      let dtstart;
      if (mode === "floating") {
        dtstart = `DTSTART:${local(day.y, day.m, day.d, hh, mm)}`;
        if (med.endDate) {
          const e = parseDate(med.endDate);
          rule.push(`UNTIL=${local(e.y, e.m, e.d, 23, 59, 59)}`); // floating start -> floating UNTIL (RFC 5545 3.3.10)
        }
      } else {
        dtstart = `DTSTART;TZID=${zone}:${local(day.y, day.m, day.d, hh, mm)}`;
        if (med.endDate) {
          const e = parseDate(med.endDate);
          const until = localToInstant({ ...e, hh: 23, mm: 59 }, zone).ms + 59000;
          rule.push(`UNTIL=${stamp(until)}`); // zoned start -> UTC UNTIL
          windowEnd = Math.max(windowEnd, until);
        } else {
          windowEnd = Math.max(windowEnd, localToInstant({ ...day, hh, mm }, zone).ms + 10 * 366 * DAY);
        }
      }

      const text = `Take ${name}`;
      const lines = [
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${stamp(now)}`,
        dtstart,
        "DURATION:PT5M",
        `RRULE:${rule.join(";")}`,
        `SUMMARY:${escapeText(text)}`,
      ];
      if (med.notes && String(med.notes).trim()) lines.push(`DESCRIPTION:${escapeText(String(med.notes).trim().slice(0, 300))}`);
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(text)}`, "TRIGGER:PT0S", "END:VALARM", "END:VEVENT");
      events.push(lines);
    }
  });

  const head = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//wallclock//medication reminders//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Medication reminders"];
  let zoneBlock = [];
  if (mode === "zone") {
    const earliest = Math.min(...meds.map((m) => { const s = parseDate(m.startDate); return Date.UTC(s.y, s.m - 1, s.d); })) - 2 * DAY;
    zoneBlock = vtimezone(zone, earliest, windowEnd + 2 * DAY);
  }
  return [...head, ...zoneBlock, ...events.flat(), "END:VCALENDAR"].map(fold).join(CRLF) + CRLF;
}

/** The next few reminders as the person will see them, in the zone they apply to. */
export function preview(med, zone, { fromMs = Date.now(), limit = 8 } = {}) {
  return occurrences(med, zone, { fromMs, limit });
}
