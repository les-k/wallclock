/* The shortcut, written the way it is usually written.
 *
 * "Remind me at 08:00 every day" -> work out the first 08:00, then repeat every
 * 24 hours. It is one line, it is what setInterval(fn, 86_400_000) does, and it
 * is what a cron-style "every 86400 seconds" or "store the UTC time of day"
 * amounts to. All of those are the same thing: the reminder stays fixed in UTC,
 * so it follows the clock only for as long as the zone's UTC offset doesn't
 * change. bench/run.js measures what that costs.
 *
 * Kept out of src/ on purpose: it is here to be measured, not used.
 */
import { localToInstant } from "../src/tz.js";
import { parseDate } from "../src/schedule.js";

const DAY = 86400000;

/**
 * `count` daily reminders starting on startDate, as a naive scheduler would
 * produce them: the first one right, the rest at +24h each.
 */
export function everyTwentyFourHours({ time, startDate }, zone, count) {
  const s = parseDate(startDate);
  const [hh, mm] = time.split(":").map(Number);
  const first = localToInstant({ ...s, hh, mm }, zone).ms;
  return Array.from({ length: count }, (_, n) => first + n * DAY);
}
