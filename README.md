# wallclock — medication reminders that stay at the same time, and why "every 24 hours" doesn't

**Repeating a daily 08:00 reminder every 24 hours put 48.2% of reminders at the
wrong clock time in the 131 time zones that change their clocks, by up to two
hours. This project's schedule was wrong on 0 of 152,205.**

A static page where you list your medicines and times, then download one
calendar file (.ics) to open on your phone. The phone's own calendar does the
ringing, so it works with the page closed. What you type never leaves the device:
the page's Content-Security-Policy forbids every network request, and the
browser reported all six attempts I made to send data out.

```bash
npm install            # one dev dependency (ical.js), used by tests only
npm test               # 37 tests
npm run bench          # the every-24-hours measurement, ~45 s -> bench/results.json
node bench/ics-check.js   # a calendar library reads our files, every zone
PYTHON=python node bench/oracle.js   # second opinion from Python's zoneinfo (~3 min)
```

The app has no dependencies and no build step: serve the folder as static files.

## Why "every 24 hours" is wrong

"Remind me at 08:00 every day" is easy to write as "first 08:00, then +24 hours,
repeatedly". It is also what `setInterval(fn, 86_400_000)` does. On the two days
a year when clocks change, a day is 23 or 25 hours long, so from then until the
next change the reminder fires an hour off the wall clock.

Measured, for all 417 time zones this runtime knows, a daily 08:00 reminder for
a year, started on the 1st of each month in turn (the damage depends on when you
create it):

| | |
|---|---|
| zones where the shortcut is ever wrong | **131 of 417** (the 131 that change clocks) |
| reminders at the wrong clock time | **276,835 of 1,826,460** — 15.2% across all zones, **48.2%** in zones that change clocks |
| drift sizes | 272,509 at ±60 min; 2,184 at ±30 min (Lord Howe Island only); 2,142 at ±120 min (Antarctica/Troll only) |
| this project's schedule, same zones | **0 wrong of 152,205** (every zone, 1 Jan – 31 Dec 2026) |

The schedule steps through **calendar dates** and asks, for each, "what moment is
08:00 on that date's clock?" rather than adding 24 hours. Zones are weighted
equally here, not by population.

## The awkward hours

Twice a year one local hour doesn't exist, and once it happens twice. Both need
a rule. Mine are the ones in RFC 5545 (the calendar-file standard) and Python's
`zoneinfo`:

- a time that **doesn't exist** (02:30 when clocks jump 02:00 → 03:00) is read with
  the offset from *before* the change, so it becomes 03:30;
- a time that **happens twice** (01:30 when clocks fall back) is the **first** one;
- a **date that doesn't exist** (Samoa skipped 30 December 2011) gets no reminder;
- two doses that collapse onto the same moment become one.

Which hours are affected varies by place. Across the 262 clock changes of 2026:

| the skipped or repeated hour starts at | skipped | repeated |
|---|---|---|
| 00:00 | 6 | 2 |
| 01:00 | 10 | 65 |
| 02:00 | 100 | 46 |
| 03:00 | 12 | 11 |
| evening (21:00–23:00) | 3 | 7 |

244 of 262 start between 01:00 and 03:59 and 252 between 00:00 and 03:59. So a
generic "avoid 1–3 a.m." would have been wrong for 18 of 262 changes. My first
version of the warning said exactly that; the app now names the exact stretch for
the person's own zone and date ("the clock jumps over 02:00 to 03:00").

### Checked against an independent implementation

`bench/oracle.py` answers the same questions with Python's `zoneinfo`, a
separate implementation reading a separate copy of the time-zone database
(runtime: tzdata 2024b; Python: tzdata 2026c).

- **156,462 clock-time conversions** in all 417 zones, 2000–2024, concentrated on
  the days around each clock change (148,304 ordinary, 4,075 in a skipped hour,
  4,083 in a repeated hour): **6 disagreements, all in one zone, Europe/Chisinau
  (2022–2024).**
- Those 6 are not the conversion code. The two databases disagree about *when*
  Moldova's clocks change: the runtime's data switches at 00:00 UTC, tzdata 2026c
  at 01:00 UTC (the same moment as Romania). The runtime's own clock reads 03:45
  in Chisinau at 00:45 UTC, and my answer reads back correctly on it in all 6. I
  have not determined which database is right.

### Rules change, and old data doesn't know

Governments change daylight-saving rules, sometimes with weeks of notice. The
same comparison for **2025–2030**: **6 of 417 zones** have different clock changes
in the two databases.

| zone | clock changes 2025–2030 in the runtime's data | in tzdata 2026c |
|---|---|---|
| Africa/Casablanca | 13 | 5 |
| Africa/El_Aaiun | 13 | 5 |
| America/Asuncion | 12 | 0 |
| America/Edmonton | 12 | 3 |
| America/Vancouver | 12 | 3 |
| Europe/Chisinau | 12 | 12 (at different moments) |

I did not look up why each changed. The practical point is the design: a calendar
file that names a time zone has to carry that zone's rules, frozen as they were
when the file was made, and in these six places a file made from the older data
would ring at the wrong hour for years. So the **default is "my phone's clock"**:
the file records "08:00" with no time zone at all (a *floating* time), and the
phone applies whatever rules it currently knows. "One place's clock" is offered
for people who want to stay on one place's time while travelling, with that
caveat on the screen.

## What a calendar app does with the file

I parsed generated files with **ical.js**, an independent JavaScript calendar
implementation (it began as Mozilla's calendar library), for every zone that changes its clocks in 2026,
every one of its changes (131 zones, 262 changes), with reminders placed in the
skipped hour, the repeated hour, and at an ordinary time:

| reminders | agree with this project's schedule |
|---|---|
| ordinary | **4,978 of 4,978** |
| in a skipped hour | **0 of 258** — all read exactly one clock-change early |
| in a repeated hour | **0 of 262** — all read as the *second* occurrence |
| any other disagreement | 0 |

On ordinary times, the file, the time-zone rules written into it, and the
recurrence rules (every N days, weekdays, end dates) mean the same thing to an
independent engine as to this code. In the two awkward hours, ical.js does the
opposite of RFC 5545 on both counts. **I tested only ical.js.** I have not
tested Apple, Google or Outlook calendars, and they may agree with the standard
or with each other. That uncertainty is why the app warns about those hours
instead of picking one and implying it is universal.

## Bugs found while building it

- **My first calendar-vs-code probe tested nothing in the skipped hour.** Its
  arithmetic left the hour unchanged (01:00, not 02:00) and reported 115 of 131
  zones in agreement. The rewrite found the real result above.
- **"Every 2 days, weekends only" gave different days in the preview and in the
  calendar.** The preview counted every-other-day from the start date; the file
  started at the first weekend day and counted from there (Jan 11, 17, 25… against
  Jan 10, 18, 24…). Only a comparison with an independent engine caught it.
  Combinations that can never land (every 7 days on a different weekday) are now
  refused.
- A test that claimed an 11-hour interval in the wrong place, another that asserted
  01:30 is special on spring-forward day (it isn't: that hour exists), and a
  hand-written "avoid 1–3 a.m." that the data above contradicted.

## What this does not show

- **Nothing was run on a phone.** The file parses and means the right thing to
  ical.js; I have not watched an iPhone, an Android phone or Outlook ring. The
  "how to open it" steps in the app are from general knowledge, not tested.
- **Alarm delivery is the phone's job.** Silent mode, focus modes, a denied
  notification permission and a disabled calendar all stop a reminder, and none
  of that is visible to this page.
- **Clock times only.** "Take every 8 hours" is not expressible; three clock times
  are, and their spacing will change by an hour across a clock change because the
  clock did. For medicines where the interval matters, that matters.
- **Floating reminders move with the phone.** Cross eight time zones and "08:00"
  becomes 08:00 there, so doses can land closer together or further apart than
  intended. That is a medical-timing question for a pharmacist, not something this
  tool can settle.
- **Two clock changes within about two days** of each other, in one zone, would
  break the conversion's assumption. The sweep over every zone and 16,680 random
  times found none, but I have not proved there are none.
- **Zones are equally weighted, one year (2026), one runtime's data.** The
  conversion's tests use fixed dates; the benchmark uses 2026 rules from tzdata
  2024b.
- **Not medical advice**, and not a medical device. It writes down times you were
  already given.

## Layout

```
index.html  style.css  app.js     the interface
src/tz.js         clock time <-> real moments, gaps and overlaps, clock-change finder
src/schedule.js   the reminders a schedule means; warnings for the awkward hours
src/ics.js        the calendar file: escaping, folding, VTIMEZONE, floating or pinned
bench/            the 24-hour shortcut, the benchmark, the Python cross-check, ical.js check
test/             37 tests, including a sweep of all 417 zones
```

## Licence

MIT.
