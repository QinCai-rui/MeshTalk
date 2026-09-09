"""Pretty read-only dashboard for the aggregate telemetry store. Stdlib only.

Run:  TELEMETRY_DB=/data/telemetry.sqlite DASHBOARD_PORT=8090 python dashboard.py
Binds localhost by default; never writes to the DB (opens read-only) and the
DB holds only daily aggregates -- no IPs or identifiers exist to display.

Untracked helper: do not commit.
"""
import json
import os
import sqlite3
import threading
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DB_PATH = os.environ.get("TELEMETRY_DB", "/data/telemetry.sqlite")
_lock = threading.Lock()


def _connect():
    # Read-only so the dashboard can never write/lock the ingest DB.
    try:
        db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, check_same_thread=False)
    except Exception:
        db = sqlite3.connect(DB_PATH, check_same_thread=False)
    db.row_factory = sqlite3.Row
    return db


def summary(days: int):
    days = max(1, min(90, days))
    today = date.today()
    day_list = [(today - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    cutoff = day_list[0]
    out = {
        "days": day_list,
        "pings_total": 0,
        "events_total": 0,
        "versions": [], "oses": [], "arches": [], "event_names": [],
        "pings_per_day": {d: 0 for d in day_list},
        "pings_by_version": {}, "pings_by_os": {}, "pings_by_arch": {},
        "events_per_day": {},
        "recent_pings": [], "recent_events": [],
        "db_exists": os.path.exists(DB_PATH),
    }
    try:
        db = _connect()
    except Exception:
        return out
    try:
        with _lock:
            try:
                rows = db.execute(
                    "SELECT version, os, arch, day, count FROM daily_pings WHERE day >= ?",
                    (cutoff,),
                ).fetchall()
            except Exception:
                rows = []
            try:
                erows = db.execute(
                    "SELECT event, day, count FROM daily_events WHERE day >= ?",
                    (cutoff,),
                ).fetchall()
            except Exception:
                erows = []
            try:
                recent_p = db.execute(
                    "SELECT version, os, arch, day, count FROM daily_pings ORDER BY day DESC LIMIT 100"
                ).fetchall()
                recent_e = db.execute(
                    "SELECT event, day, count FROM daily_events ORDER BY day DESC LIMIT 100"
                ).fetchall()
            except Exception:
                recent_p, recent_e = [], []
    finally:
        try: db.close()
        except Exception: pass
    for r in rows:
        d = r["day"]; c = r["count"] or 0
        out["pings_total"] += c
        if d in out["pings_per_day"]:
            out["pings_per_day"][d] += c
        for key, col in (("pings_by_version", "version"), ("pings_by_os", "os"), ("pings_by_arch", "arch")):
            name = r[col]
            out[key].setdefault(name, {d: 0 for d in day_list})
            if d in out[key][name]:
                out[key][name][d] += c
    for r in erows:
        d = r["day"]; c = r["count"] or 0; name = r["event"]
        out["events_total"] += c
        out["events_per_day"].setdefault(name, {d: 0 for d in day_list})
        if d in out["events_per_day"][name]:
            out["events_per_day"][name][d] += c
    out["versions"] = sorted(out["pings_by_version"], key=lambda v: sum(out["pings_by_version"][v].values()), reverse=True)
    out["oses"] = sorted(out["pings_by_os"], key=lambda v: sum(out["pings_by_os"][v].values()), reverse=True)
    out["arches"] = sorted(out["pings_by_arch"], key=lambda v: sum(out["pings_by_arch"][v].values()), reverse=True)
    out["event_names"] = sorted(out["events_per_day"], key=lambda v: sum(out["events_per_day"][v].values()), reverse=True)
    out["recent_pings"] = [dict(r) for r in recent_p]
    out["recent_events"] = [dict(r) for r in recent_e]
    return out


PAGE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MeshTalk Telemetry</title>
<style>
:root{--bg:#0b1020;--card:#151d33;--card2:#1a2340;--line:#2a355a;--txt:#e8eefc;--mut:#93a1c4;--acc:#7aa2ff;--grn:#4ade80;--org:#fbbf24;--red:#f87171}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,"Segoe UI",Inter,Roboto,sans-serif;background:radial-gradient(1200px 500px at 20% -10%,#1c2a5e 0%,transparent 60%),radial-gradient(900px 500px at 90% 0%,#123f3a 0%,transparent 55%),var(--bg);color:var(--txt);min-height:100vh}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 60px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:end;justify-content:space-between;margin-bottom:18px}
h1{margin:0;font-size:26px;letter-spacing:.3px}h1 span{color:var(--acc)}
.sub{color:var(--mut);font-size:13px;margin-top:4px;max-width:640px}
.days{display:flex;gap:6px}button{cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--txt);border-radius:9px;padding:7px 13px;font-size:13px}button.on{background:var(--acc);border-color:var(--acc);color:#0b1020;font-weight:700}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:16px 0}
.kpi{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:14px;padding:14px 16px}.kpi .l{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.8px}.kpi .v{font-size:30px;font-weight:800;margin-top:2px}.kpi .s{color:var(--mut);font-size:12px}
.card{background:linear-gradient(180deg,var(--card2),var(--card));border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
.card h2{margin:0 0 4px;font-size:16px}.card p.d{margin:0 0 10px;color:var(--mut);font-size:13px}
canvas{width:100%;height:240px;display:block}
.legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;font-size:12px;color:var(--mut)}.legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.bars{display:flex;flex-direction:column;gap:8px;margin-top:6px}.bar-row{display:grid;grid-template-columns:170px 1fr 70px;gap:10px;align-items:center;font-size:13px}.bar-row .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track{height:10px;background:#0d1430;border-radius:6px;overflow:hidden}.fill{height:100%;border-radius:6px;background:linear-gradient(90deg,var(--acc),#4ade80)}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line)}th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.6px}td.n{font-variant-numeric:tabular-nums;text-align:right}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:800px){.cols{grid-template-columns:1fr}.bar-row{grid-template-columns:120px 1fr 56px}}
.tip{position:fixed;pointer-events:none;background:#0d1430f0;border:1px solid var(--line);border-radius:8px;padding:6px 9px;font-size:12px;display:none;z-index:9}
footer{color:var(--mut);font-size:12px;margin-top:14px}.err{background:#3a1620;border:1px solid var(--red);border-radius:10px;padding:10px 14px;display:none;margin:12px 0}
</style></head><body><div class="wrap">
<header><div><h1>◈ MeshTalk <span>Telemetry</span></h1>
<div class="sub">Aggregate install census + room/group/transport counters. No message or file activity, no IPs, no identifiers. Counts are approximate and poisonable by design.</div></div>
<div class="days" id="days"><button data-d="7">7d</button><button data-d="14">14d</button><button data-d="30" class="on">30d</button><button data-d="90">90d</button></div></header>
<div class="err" id="err"></div>
<div class="grid">
<div class="kpi"><div class="l">Version pings</div><div class="v" id="kPings">–</div><div class="s" id="kPingsS"></div></div>
<div class="kpi"><div class="l">Tier-1 events</div><div class="v" id="kEvents">–</div><div class="s" id="kEventsS"></div></div>
<div class="kpi"><div class="l">Versions seen</div><div class="v" id="kVers">–</div><div class="s" id="kVersS"></div></div>
<div class="kpi"><div class="l">Active days</div><div class="v" id="kDays">–</div><div class="s">in selected window</div></div>
</div>
<div class="card"><h2>Version pings per day</h2><p class="d">Tier-0 census, stacked by app version.</p><canvas id="cPings" height="240"></canvas><div class="legend" id="lPings"></div></div>
<div class="card"><h2>Usage events per day</h2><p class="d">Tier-1 counters (room / group / transport-path + sanitized errors). Top 8 + other.</p><canvas id="cEvents" height="240"></canvas><div class="legend" id="lEvents"></div></div>
<div class="cols">
<div class="card"><h2>By version</h2><div class="bars" id="bVers"></div></div>
<div class="card"><h2>By platform</h2><div class="bars" id="bOs"></div><h2 style="margin-top:14px">By arch</h2><div class="bars" id="bArch"></div></div>
</div>
<div class="cols">
<div class="card"><h2>Latest version pings</h2><table><thead><tr><th>Day</th><th>Version</th><th>OS / Arch</th><th style="text-align:right">Count</th></tr></thead><tbody id="tPings"></tbody></table></div>
<div class="card"><h2>Latest events</h2><table><thead><tr><th>Day</th><th>Event</th><th style="text-align:right">Count</th></tr></thead><tbody id="tEvents"></tbody></table></div>
</div>
<footer id="foot"></footer>
</div><div class="tip" id="tip"></div>
<script>
let DAYS=30,DATA=null;
const PAL=["#7aa2ff","#4ade80","#fbbf24","#f472b6","#22d3ee","#a78bfa","#fb923c","#34d399","#94a3b8"];
const col=i=>PAL[i%PAL.length];
const fmt=n=>n>=1e6?(n/1e6).toFixed(1)+"M":n>=1e3?(n/1e3).toFixed(1)+"k":""+n;
function drawStacked(cv,dayList,series,legendEl,maxSeries){
  const dpr=devicePixelRatio||1,W=cv.clientWidth,H=240;cv.width=W*dpr;cv.height=H*dpr;
  const x=cv.getContext("2d");x.scale(dpr,dpr);x.clearRect(0,0,W,H);
  const names=Object.keys(series).sort((a,b)=>tot(series[b])-tot(series[a]));
  const top=names.slice(0,maxSeries),rest=names.slice(maxSeries);
  if(rest.length){const o={};dayList.forEach(d=>o[d]=0);rest.forEach(n=>dayList.forEach(d=>o[d]+=series[n][d]||0));series={};top.forEach(n=>series[n]=arguments[2][n]);series["other"]=o;top.push("other");}
  else{const s={};top.forEach(n=>s[n]=series[n]);series=s;}
  const keys=Object.keys(series),padL=44,padB=22,padT=8,cw=(W-padL-8)/dayList.length;
  let mx=1;dayList.forEach((d,i)=>{let s=0;keys.forEach(k=>s+=series[k][d]||0);mx=Math.max(mx,s)});
  const nice=n=>{const p=Math.pow(10,Math.floor(Math.log10(n)));const m=n/p;return (m<=1?1:m<=2?2:m<=5?5:10)*p};
  mx=nice(mx);const yh=H-padB-padT;
  x.strokeStyle="#2a355a";x.fillStyle="#93a1c4";x.font="11px sans-serif";x.lineWidth=1;
  for(let g=0;g<=4;g++){const y=padT+yh-yh*g/4;x.beginPath();x.moveTo(padL,y);x.lineTo(W-8,y);x.stroke();x.fillText(fmt(mx*g/4),6,y+4)}
  const bw=Math.max(2,Math.min(26,cw*0.62));
  const bars=[];
  dayList.forEach((d,i)=>{let y0=padT+yh;const cx=padL+i*cw+cw/2;
    keys.forEach(k=>{const v=series[k][d]||0;if(!v)return;const h=yh*v/mx,y1=y0-h;
      x.fillStyle=col(keys.indexOf(k)+(k==="other"?8:0));x.fillRect(cx-bw/2,y1,bw,h);y0=y1});
    bars.push({d,x:cx});});
  x.fillStyle="#93a1c4";dayList.forEach((d,i)=>{if(dayList.length>16&&i%Math.ceil(dayList.length/8))return;const cx=padL+i*cw+cw/2;x.fillText(d.slice(5),cx-14,H-7)});
  legendEl.innerHTML=keys.map((k,i)=>`<span><i style="background:${col(i+(k==="other"?8:0))}"></i>${esc(k)} (${fmt(tot(series[k]))})</span>`).join("");
  cv.onmousemove=e=>{const r=cv.getBoundingClientRect(),mxp=e.clientX-r.left;let bi=0,bd=1e9;bars.forEach((b,i)=>{const dd=Math.abs(b.x-mxp);if(dd<bd){bd=dd;bi=i}});const d=dayList[bi];
    const tip=document.getElementById("tip");let h=`<b>${d}</b>`;keys.forEach(k=>{const v=series[k][d]||0;if(v)h+=`<br>${esc(k)}: ${v}`});tip.innerHTML=h;tip.style.display="block";tip.style.left=(e.clientX+14)+"px";tip.style.top=(e.clientY+12)+"px"};
  cv.onmouseleave=()=>document.getElementById("tip").style.display="none";
}
const tot=o=>Object.values(o||{}).reduce((a,b)=>a+b,0);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function hbars(el,map){const totAll=Math.max(1,...Object.values(map).map(tot));el.innerHTML=Object.keys(map).sort((a,b)=>tot(map[b])-tot(map[a])).slice(0,10).map(k=>{const t=tot(map[k]);return `<div class="bar-row"><div class="n">${esc(k)}</div><div class="track"><div class="fill" style="width:${(100*t/totAll).toFixed(1)}%"></div></div><div class="n" style="text-align:right">${fmt(t)}</div></div>`}).join("")||'<div class="sub">no data</div>'}
async function load(){const e=document.getElementById("err");e.style.display="none";
  try{const r=await fetch("/api/summary?days="+DAYS);if(!r.ok)throw new Error("HTTP "+r.status);DATA=await r.json();render()}
  catch(err){e.textContent="Could not load telemetry API: "+err+" (is the ingest DB present?)";e.style.display="block"}}
function render(){const d=DATA;document.getElementById("kPings").textContent=fmt(d.pings_total);
  document.getElementById("kPingsS").textContent="version pings / "+d.days.length+"d";
  document.getElementById("kEvents").textContent=fmt(d.events_total);
  document.getElementById("kEventsS").textContent="tier-1 event counts / "+d.days.length+"d";
  document.getElementById("kVers").textContent=d.versions.length;
  document.getElementById("kVersS").textContent=d.versions.slice(0,3).join(", ")||"—";
  document.getElementById("kDays").textContent=Object.values(d.pings_per_day).filter(v=>v>0).length;
  drawStacked(document.getElementById("cPings"),d.days,d.pings_by_version,document.getElementById("lPings"),6);
  drawStacked(document.getElementById("cEvents"),d.days,d.events_per_day,document.getElementById("lEvents"),8);
  const sumM=m=>{const o={};Object.keys(m).forEach(k=>o[k]={[d.days[0]]:0,...m[k]});return m};
  hbars(document.getElementById("bVers"),d.pings_by_version);
  const osArch={};Object.keys(d.pings_by_os).forEach(k=>osArch["os:"+k]=d.pings_by_os[k]);hbars(document.getElementById("bOs"),d.pings_by_os);
  hbars(document.getElementById("bArch"),d.pings_by_arch);
  document.getElementById("tPings").innerHTML=d.recent_pings.slice(0,20).map(r=>`<tr><td>${r.day}</td><td>${esc(r.version)}</td><td>${esc(r.os)} / ${esc(r.arch)}</td><td class="n">${r.count}</td></tr>`).join("")||'<tr><td colspan="4">no data</td></tr>';
  document.getElementById("tEvents").innerHTML=d.recent_events.slice(0,20).map(r=>`<tr><td>${r.day}</td><td>${esc(r.event)}</td><td class="n">${r.count}</td></tr>`).join("")||'<tr><td colspan="3">no data</td></tr>';
  document.getElementById("foot").textContent=!d.db_exists?"DB not found at server start — showing zeros. Set TELEMETRY_DB to your ingest SQLite file.":"90-day retention · UTC days · generated "+new Date().toISOString()+" · counts approximate";
}
document.getElementById("days").onclick=e=>{const b=e.target.closest("button");if(!b)return;DAYS=+b.dataset.d;document.querySelectorAll("#days button").forEach(x=>x.classList.toggle("on",x===b));load()};
load();setInterval(load,60000);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def _send(self, code, body: bytes, ctype="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/health":
            return self._send(200, b"ok", "text/plain")
        if u.path == "/api/summary":
            try:
                days = int(parse_qs(u.query).get("days", ["30"])[0])
            except Exception:
                days = 30
            body = json.dumps(summary(days)).encode()
            return self._send(200, body, "application/json")
        if u.path in ("/", "/index.html"):
            return self._send(200, PAGE.encode())
        return self._send(404, b"not found", "text/plain")


if __name__ == "__main__":
    port = int(os.environ.get("DASHBOARD_PORT", os.environ.get("PORT", "8090")))
    bind = os.environ.get("BIND", "127.0.0.1")
    ThreadingHTTPServer((bind, port), Handler).serve_forever()
