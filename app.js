/* Wallclock - the interface. DOM wiring only: what a schedule means, how clock
 * changes are handled, and how the calendar file is written all live in src/
 * and are tested there. Everything typed here goes in through textContent or
 * .value, never innerHTML.
 *
 * Typing never rebuilds the form (that would steal focus mid-word). Only adding
 * or removing a medicine or a time redraws the cards; the preview and the
 * download button update separately.
 */
import { buildCalendar } from "./src/ics.js";
import { occurrences, validateSpec, edgeWarnings } from "./src/schedule.js";
import { allZones, deviceZone, isValidZone, wallClock, formatOffset, offsetAt } from "./src/tz.js";

const app = document.getElementById("app");
const announceEl = document.getElementById("announce");
const KEY = "wallclock.v1";
const MAX_MEDS = 50;
const MAX_TIMES = 12;
const DAYS = [["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 0]];

/* ------------------------------------------------------------------ helpers */

function h(tag, attrs, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}
// replaceChildren() would turn a null child into the text "null".
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const announce = (msg) => {
  announceEl.textContent = "";
  setTimeout(() => (announceEl.textContent = msg), 50);
};
const p2 = (n) => String(n).padStart(2, "0");

/* -------------------------------------------------------------------- state */

let nextId = 1;
const today = () => {
  const w = wallClock(Date.now(), deviceZone());
  return `${w.y}-${p2(w.m)}-${p2(w.d)}`;
};
const newMed = () => ({ id: nextId++, name: "", notes: "", times: ["08:00"], startDate: today(), endDate: "", everyDays: 1, weekdays: [] });

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!raw || !Array.isArray(raw.meds)) return null;
    const meds = raw.meds.slice(0, MAX_MEDS).map((m) => ({
      id: nextId++,
      name: String(m.name ?? "").slice(0, 80),
      notes: String(m.notes ?? "").slice(0, 200),
      times: (Array.isArray(m.times) ? m.times : ["08:00"]).slice(0, MAX_TIMES).map(String),
      startDate: String(m.startDate ?? today()),
      endDate: String(m.endDate ?? ""),
      everyDays: Number.isInteger(m.everyDays) ? m.everyDays : 1,
      weekdays: Array.isArray(m.weekdays) ? m.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [],
    }));
    return { meds: meds.length ? meds : [newMed()], mode: raw.mode === "zone" ? "zone" : "floating", zone: isValidZone(raw.zone) ? raw.zone : deviceZone() };
  } catch {
    return null; // storage blocked or corrupt: start fresh
  }
}
const state = load() ?? { meds: [newMed()], mode: "floating", zone: deviceZone() };
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ meds: state.meds, mode: state.mode, zone: state.zone }));
  } catch {}
};

const specOf = (m) => ({
  times: m.times.filter(Boolean),
  startDate: m.startDate,
  endDate: m.endDate || null,
  everyDays: Number(m.everyDays),
  weekdays: m.weekdays.length ? m.weekdays : null,
});
const problemOf = (m) => (m.name.trim() ? validateSpec(specOf(m)) : "give it a name");
const clockZone = () => (state.mode === "zone" ? state.zone : deviceZone());

/* --------------------------------------------------------------------- page */

const medsBox = h("div", {});
const previewBox = h("section", { class: "card", "aria-labelledby": "prev-h" });
const downloadBox = h("section", { class: "card" });
const errorEls = new Map();

function renderMeds() {
  errorEls.clear();
  fill(medsBox, state.meds.map((m, i) => medCard(m, i)));
}

function medCard(m, index) {
  const err = h("p", { class: "error", role: "alert" });
  errorEls.set(m.id, err);

  const timesBox = h("div", { class: "times" });
  const drawTimes = () => fill(timesBox, m.times.map((t, i) =>
    h("span", { class: "time-chip" },
      h("input", { type: "time", value: t, "aria-label": `Time ${i + 1} for ${m.name || "this medicine"}`, oninput: (e) => { m.times[i] = e.target.value; touch(); } }),
      m.times.length > 1 ? h("button", { type: "button", class: "quiet", "aria-label": `Remove time ${i + 1}`, onclick: () => { m.times.splice(i, 1); drawTimes(); touch(); } }, "×") : null)),
    m.times.length < MAX_TIMES ? h("button", { type: "button", class: "quiet", onclick: () => { m.times.push("20:00"); drawTimes(); touch(); } }, "+ Add a time") : null);
  drawTimes();

  return h("section", { class: "card", "aria-label": `Medicine ${index + 1}` },
    h("div", { class: "row" },
      h("div", {}, h("label", { class: "field", for: `n${m.id}` }, "Medicine"),
        h("input", { type: "text", id: `n${m.id}`, value: m.name, maxlength: 80, placeholder: "e.g. Vitamin D", autocomplete: "off", oninput: (e) => { m.name = e.target.value; touch(); } })),
      h("div", {}, h("label", { class: "field", for: `o${m.id}` }, "Note ", h("span", { class: "hint" }, "(optional)")),
        h("input", { type: "text", id: `o${m.id}`, value: m.notes, maxlength: 200, placeholder: "e.g. with food", autocomplete: "off", oninput: (e) => { m.notes = e.target.value; touch(); } }))),
    h("fieldset", {}, h("legend", {}, "What times?"), timesBox),
    h("div", { class: "row" },
      h("div", {}, h("label", { class: "field", for: `s${m.id}` }, "First day"), h("input", { type: "date", id: `s${m.id}`, value: m.startDate, oninput: (e) => { m.startDate = e.target.value; touch(); } })),
      h("div", {}, h("label", { class: "field", for: `e${m.id}` }, "Last day ", h("span", { class: "hint" }, "(blank = keeps going)")), h("input", { type: "date", id: `e${m.id}`, value: m.endDate, oninput: (e) => { m.endDate = e.target.value; touch(); } })),
      h("div", { class: "narrow" }, h("label", { class: "field", for: `r${m.id}` }, "Every … days"), h("input", { type: "number", id: `r${m.id}`, min: 1, max: 365, value: m.everyDays, oninput: (e) => { m.everyDays = e.target.value === "" ? NaN : Number(e.target.value); touch(); } }))),
    h("details", {}, h("summary", {}, m.weekdays.length ? "Only on certain days (set)" : "Only on certain days"),
      h("div", { class: "days", role: "group", "aria-label": "Days of the week" }, DAYS.map(([label, n]) =>
        h("label", {}, h("input", { type: "checkbox", checked: m.weekdays.includes(n), onchange: (e) => { m.weekdays = e.target.checked ? [...m.weekdays, n] : m.weekdays.filter((d) => d !== n); touch(); } }), label)))),
    err,
    state.meds.length > 1 ? h("div", { class: "actions" }, h("button", { type: "button", class: "quiet danger", onclick: () => { state.meds = state.meds.filter((x) => x.id !== m.id); renderMeds(); touch(); announce("Medicine removed."); } }, "Remove this medicine")) : null);
}

function touch() {
  save();
  renderPreview();
}

function renderPreview() {
  const zone = clockZone();
  const valid = [];
  let anyBad = false;
  for (const m of state.meds) {
    const problem = problemOf(m);
    const el = errorEls.get(m.id);
    const untouched = !m.name.trim() && m.times.length === 1 && m.times[0] === "08:00" && state.meds.length === 1;
    if (el) el.textContent = problem && !untouched ? problem : "";
    if (problem) anyBad = anyBad || !untouched;
    else valid.push(m);
  }

  const now = Date.now();
  const upcoming = valid
    .flatMap((m) => occurrences(specOf(m), zone, { fromMs: now, limit: 12 }).map((o) => ({ ...o, name: m.name.trim() })))
    .sort((a, b) => a.ms - b.ms)
    .slice(0, 8);
  const fmtDay = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: zone });

  const warnings = valid.flatMap((m) => edgeWarnings(specOf(m), zone, { fromMs: now, days: 400 }).map((w) => ({ ...w, name: m.name.trim() })));
  const lines = warnings.slice(0, 3).map((w) => w.kind === "skipped"
    ? `${w.name}: on ${w.date} the clock jumps over ${w.window.replace("-", " to ")}, so ${w.wanted} doesn't exist and will be read as ${w.ranAs}.`
    : `${w.name}: on ${w.date} the clock repeats ${w.window.replace("-", " to ")}, so ${w.wanted} happens twice; the first one is used.`);

  fill(previewBox,
    h("h2", { id: "prev-h" }, "Your next reminders"),
    upcoming.length
      ? h("ul", { class: "upcoming" }, upcoming.map((o) => {
          const w = wallClock(o.ms, zone);
          return h("li", {}, h("span", {}, o.name), h("span", { class: "when" }, `${fmtDay.format(new Date(o.ms))} · ${p2(w.hh)}:${p2(w.mm)}`));
        }))
      : h("p", { class: "hint" }, "Add a medicine and a time to see them here."),
    h("p", { class: "hint" }, state.mode === "zone"
      ? `Shown on ${zone.replace(/_/g, " ")} time (UTC${formatOffset(offsetAt(now, zone))} right now).`
      : `Shown on this device's clock (${zone.replace(/_/g, " ")}, UTC${formatOffset(offsetAt(now, zone))} right now).`),
    lines.length ? h("div", { class: "notice warn" },
      h("b", {}, "Heads up: a clock change hits your times. "),
      lines.join(" "), warnings.length > 3 ? ` (and ${warnings.length - 3} more)` : "",
      " Calendar apps disagree about times inside those hours and may ring an hour apart. A time outside the hours named above is read the same everywhere.") : null);

  const ok = valid.length > 0 && !anyBad;
  const button = h("button", { type: "button", class: "primary", disabled: !ok, onclick: download }, "Download calendar file");
  fill(downloadBox,
    h("h2", {}, "Put them on your phone"),
    h("p", { class: "hint" }, "One file, made on this device. Open it on your phone and your calendar will ring at each time, even when this page is closed."),
    h("div", { class: "actions" }, button, h("button", { type: "button", class: "quiet danger", onclick: clearAll }, "Clear everything")),
    ok ? null : h("p", { class: "hint" }, valid.length ? "Fix the highlighted medicine first." : "Add a medicine and a time first."),
    h("details", {}, h("summary", {}, "How to open it"),
      h("ol", { class: "steps" },
        h("li", {}, "iPhone: open the downloaded file and tap Add All."),
        h("li", {}, "Android: open the file with Google Calendar, or import it at calendar.google.com (Settings, then Import)."),
        h("li", {}, "Computer: double-click the file to open it in your calendar app."),
        h("li", {}, "Steps vary by app. Check that the first reminder shows at the right time."))));
}

function download() {
  const meds = state.meds.filter((m) => !problemOf(m)).map((m) => ({ name: m.name.trim(), notes: m.notes, ...specOf(m) }));
  try {
    const text = buildCalendar(meds, { mode: state.mode, zone: state.mode === "zone" ? state.zone : null });
    const url = URL.createObjectURL(new Blob([text], { type: "text/calendar;charset=utf-8" }));
    const a = h("a", { href: url, download: "medication-reminders.ics" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce("Calendar file downloaded.");
  } catch (err) {
    announce(`Couldn't make the file: ${err.message}`);
    window.alert(`Couldn't make the file: ${err.message}`);
  }
}

function clearAll() {
  if (!window.confirm("Remove every medicine saved on this device?")) return;
  state.meds = [newMed()];
  state.mode = "floating";
  state.zone = deviceZone();
  try { localStorage.removeItem(KEY); } catch {}
  build();
  announce("Cleared.");
}

function clockCard() {
  const zoneSelect = h("select", { id: "zone", "aria-label": "Place", onchange: (e) => { state.zone = e.target.value; touch(); } },
    allZones().map((z) => h("option", { value: z, selected: z === state.zone }, z.replace(/_/g, " "))));
  const pick = (mode) => () => { state.mode = mode; zoneRow.hidden = mode !== "zone"; touch(); };
  const zoneRow = h("div", { hidden: state.mode !== "zone" }, zoneSelect);
  return h("section", { class: "card" },
    h("fieldset", {}, h("legend", {}, "Which clock?"),
      h("label", { class: "choice" }, h("input", { type: "radio", name: "mode", checked: state.mode === "floating", onchange: pick("floating") }),
        h("span", {}, h("b", {}, "My phone's clock (recommended)"), h("span", { class: "hint" }, "08:00 means 08:00 on whatever your phone shows, through daylight saving and when you travel. No time zone is stored, so it can't go out of date."))),
      h("label", { class: "choice" }, h("input", { type: "radio", name: "mode", checked: state.mode === "zone", onchange: pick("zone") }),
        h("span", {}, h("b", {}, "One place's clock"), h("span", { class: "hint" }, "Stays on that place's time even if you travel. The file carries that place's clock-change dates as this browser knows them today; if a government changes the rules later, the file won't know."))),
      zoneRow));
}

function build() {
  fill(app,
    h("h1", {}, "Reminders that stay at the same time."),
    h("p", { class: "lead" }, "Add your medicines and the times you take them. Download one calendar file and open it on your phone: its calendar rings at those times, through daylight saving, even with this page closed."),
    medsBox,
    h("div", { class: "actions" }, h("button", { type: "button", onclick: () => { if (state.meds.length < MAX_MEDS) { state.meds.push(newMed()); renderMeds(); touch(); medsBox.lastElementChild?.querySelector("input")?.focus(); } } }, "+ Add another medicine")),
    clockCard(),
    previewBox,
    downloadBox,
    h("p", { class: "disclaimer" }, "Wallclock helps you remember times you have already been given; it is not medical advice. Follow your prescriber's or pharmacist's instructions, and for medicines where timing matters, don't rely on any single app. What you type is saved only on this device and is never sent anywhere."));
  renderMeds();
  renderPreview();
}

build();
