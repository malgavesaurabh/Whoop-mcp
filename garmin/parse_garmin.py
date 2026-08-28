#!/usr/bin/env python3
"""Parse Garmin exports (FIT activity files or Connect full-export ZIP/JSON/CSV)
into a compact daily/session summary Claude can analyze in chat.

Usage: python3 parse_garmin.py <file.fit | export.zip | file.csv | file.json>
Prints JSON to stdout.
"""
import sys, os, json, zipfile, csv, io, statistics as st
from datetime import timezone

def parse_fit(path_or_bytes, name="activity"):
    from fitparse import FitFile
    fit = FitFile(path_or_bytes)
    out = {"file": name, "type": None, "records": 0}
    hr, spd, dist, cad = [], [], 0, []
    for m in fit.get_messages(("session", "record", "sport")):
        d = {f.name: f.value for f in m}
        if m.name == "sport":
            out["type"] = str(d.get("sport"))
        elif m.name == "session":
            for k in ("sport","total_distance","total_timer_time","total_calories",
                      "avg_heart_rate","max_heart_rate","avg_speed","max_speed",
                      "total_ascent","training_load_peak","total_training_effect",
                      "total_anaerobic_training_effect","start_time","avg_cadence"):
                if d.get(k) is not None:
                    v = d[k]
                    out[k] = v.replace(tzinfo=timezone.utc).isoformat() if hasattr(v, "isoformat") else (float(v) if isinstance(v,(int,float)) else str(v))
        elif m.name == "record":
            out["records"] += 1
            if d.get("heart_rate"): hr.append(d["heart_rate"])
            if d.get("speed"): spd.append(d["speed"])
            if d.get("cadence"): cad.append(d["cadence"])
    if hr:
        out["hr_series"] = {"avg": round(st.mean(hr),1), "max": max(hr), "min": min(hr),
                            "p50": st.median(hr), "time_zones_est": None}
    if out.get("total_distance") and out.get("total_timer_time"):
        km = out["total_distance"]/1000; mins = out["total_timer_time"]/60
        out["pace_min_per_km"] = round(mins/km, 2) if km > 0.05 else None
    return out

def parse_zip(path):
    res = {"activities": [], "wellness_files": [], "other": []}
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            low = n.lower()
            try:
                if low.endswith(".fit") and "activity" in low:
                    res["activities"].append(parse_fit(io.BytesIO(z.read(n)), os.path.basename(n)))
                elif low.endswith(".json") and any(k in low for k in ("sleep","wellness","hrv","heart","udsfile","user")):
                    data = json.loads(z.read(n))
                    res["wellness_files"].append({"file": os.path.basename(n),
                        "keys": list(data.keys())[:20] if isinstance(data, dict) else f"list[{len(data)}]",
                        "sample": data[:3] if isinstance(data, list) else None})
                else:
                    res["other"].append(n)
            except Exception as e:
                res["other"].append(f"{n} (error: {e})")
    res["other"] = res["other"][:40]
    return res

def parse_csv(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    return {"file": os.path.basename(path), "rows": len(rows),
            "columns": list(rows[0].keys()) if rows else [], "head": rows[:10], "tail": rows[-5:]}

def main():
    p = sys.argv[1]
    low = p.lower()
    if low.endswith(".fit"): out = parse_fit(p, os.path.basename(p))
    elif low.endswith(".zip"): out = parse_zip(p)
    elif low.endswith(".csv"): out = parse_csv(p)
    elif low.endswith(".json"):
        out = json.load(open(p))
        if isinstance(out, list): out = {"rows": len(out), "sample": out[:5]}
    else: out = {"error": f"unsupported file type: {p}"}
    print(json.dumps(out, indent=1, default=str))

if __name__ == "__main__":
    main()
