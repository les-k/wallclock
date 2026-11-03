"""An independent second opinion on time zones.

src/tz.js leans on the JavaScript runtime's built-in time-zone data (ICU). That
would prove nothing if the check used the same data and the same code path, so
this script answers the same two questions with Python's zoneinfo, a separate
implementation reading a separate copy of the IANA database:

  convert      "what moment is y-m-d hh:mm on a zone's clock?" for a list of cases
  transitions  "when do the zone's clocks change between two moments?"

Both read JSON on stdin and write JSON on stdout. Python's rules for the two
awkward cases are the ones the JS code is meant to match (PEP 495, fold=0):
a time that does not exist is read with the offset from before the change; a
time that happens twice is the first one.
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, available_timezones


def offset_ms(zone, ms):
    dt = datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone(zone)
    return int(dt.utcoffset().total_seconds() * 1000)


def convert(cases):
    out = []
    for c in cases:
        try:
            zone = ZoneInfo(c["zone"])
        except Exception:
            out.append(None)
            continue
        dt = datetime(c["y"], c["m"], c["d"], c["hh"], c["mm"], tzinfo=zone, fold=0)
        out.append(int(dt.timestamp() * 1000))
    return out


def transitions(zones, from_ms, to_ms):
    step = 12 * 3600 * 1000
    result = {}
    for name in zones:
        try:
            zone = ZoneInfo(name)
        except Exception:
            result[name] = None
            continue
        found = []
        t0 = from_ms
        o0 = offset_ms(zone, t0)
        t1 = from_ms
        while True:
            t1 = min(t1 + step, to_ms)
            o1 = offset_ms(zone, t1)
            if o1 != o0:
                lo, hi = t0, t1
                while hi - lo > 1000:
                    mid = lo + ((hi - lo) // 2000) * 1000
                    if offset_ms(zone, mid) == o0:
                        lo = mid
                    else:
                        hi = mid
                found.append({"at": hi, "from": o0, "to": offset_ms(zone, hi)})
            t0, o0 = t1, o1
            if t1 >= to_ms:
                break
        result[name] = found
    return result


if __name__ == "__main__":
    mode = sys.argv[1]
    payload = json.load(sys.stdin)
    if mode == "convert":
        json.dump(convert(payload), sys.stdout)
    elif mode == "transitions":
        json.dump(transitions(payload["zones"], payload["from"], payload["to"]), sys.stdout)
    elif mode == "version":
        import tzdata
        json.dump({"python": sys.version.split()[0], "tzdata": tzdata.IANA_VERSION, "zones": len(available_timezones())}, sys.stdout)
    else:
        sys.exit(f"unknown mode {mode}")
