"""Generates relevo's animated hero SVG: one 14 s SMIL timeline, every
animation on the same clock (dur=T, indefinite), so GitHub's <img> loops it
in sync. Usage: python3 docs/make-hero.py docs/relevo-hub.svg [en]
(Spanish by default; en writes the English copy. The round header stays as
relevo writes it.)"""
import sys
from html import escape

DESC_ES = 'La planificadora recibe un objetivo y escribe dos handoff, uno a researcher y otro a builder. relevo abre cada worker en un pane de Herdr, los enlaza y les envía su paso en la misma ronda. Los dos trabajan a la vez. El informe de researcher llega primero y queda retenido; cuando llega el de builder, la planificadora lee los dos en un solo turno y termina.'
DESC_EN = "The planner gets a goal and writes two handoffs, one to researcher and one to builder. relevo opens each worker in a Herdr pane, links it and sends it its step in the same round. Both work at once. The researcher's report arrives first and is held; when the builder's arrives, the planner reads both in one turn and finishes."
LANG = sys.argv[2] if len(sys.argv) > 2 else "es"
EN = {'relevo: una planificadora reparte en paralelo a workers que abre en Herdr': 'relevo: a planner hands steps in parallel to workers it opens in Herdr',
    'una planificadora · workers con nombre · en paralelo · en Herdr': 'one planner · named workers · in parallel · in Herdr',
    'reparte con &lt;handoff to="…"&gt;, abre lo que falta, espera todos los informes': 'hands out with &lt;handoff to="…"&gt;, opens what is missing, waits for every report',
    'claude · esta sesión': 'claude · this session',
    'PLANNER, sin workers aún': 'PLANNER, no workers yet',
    '/relevo goal crea un CRUD en FastAPI': '/relevo goal build a CRUD in FastAPI',
    'cómo pagina y valida el repo': 'how the repo paginates and validates',
    'enlazada': 'linked',
    '↳ ronda 1 · a los dos a la vez': '↳ round 1 · to both at once',
    'leyendo src/ · 3 patrones': 'reading src/ · 3 patterns',
    'escribiendo app/ · pytest -q': 'writing app/ · pytest -q',
    'trabajando': 'working',
    'informe listo': 'report ready',
    'INFORMES RETENIDOS': 'HELD REPORTS',
    'esperando a builder…': 'waiting for builder…',
    '2 INFORMES · 1 TURNO': '2 REPORTS · 1 TURN',
    'CRUD listo · tests en verde': 'CRUD done · tests green',
    'ronda': 'round',
    'esperando objetivo': 'waiting for a goal',
    'abriendo workers en Herdr': 'opening workers in Herdr',
    'turno de researcher, builder': 'researcher, builder working',
    'researcher entregó, falta builder': 'researcher done, builder still out',
    'trabajando aquí': 'working here',
    'terminado': 'done'}


def _(s):
    return EN.get(s, s) if LANG == "en" else s


T = 14.0  # seconds per loop
E = 0.25  # fade length

def kt(*ts):
    return ";".join(f"{max(0.0, min(1.0, t / T)):.4f}" for t in ts)

def show(on, off=T - 0.6, fade=E):
    """Opacity 0 -> 1 at `on`, back to 0 at `off`."""
    return (f'<animate attributeName="opacity" dur="{T}s" repeatCount="indefinite" calcMode="linear" '
            f'values="0;0;1;1;0;0" keyTimes="{kt(0, on, on + fade, off, off + fade, T)}"/>')

def grow(attr, on, until, a, b, off=T - 0.6):
    """attr goes a -> b between on and until, holds, snaps back after off."""
    return (f'<animate attributeName="{attr}" dur="{T}s" repeatCount="indefinite" calcMode="spline" '
            f'keySplines="0 0 1 1;.4 0 .2 1;0 0 1 1;0 0 1 1" '
            f'values="{a};{a};{b};{b};{a}" keyTimes="{kt(0, on, until, off + E, T)}"/>')

def move(path, start, end, off=T - 0.6):
    """A packet rides `path` between start and end, hidden outside that span."""
    return (f'<animateMotion dur="{T}s" repeatCount="indefinite" calcMode="linear" path="{path}" '
            f'keyPoints="0;0;1;1" keyTimes="{kt(0, start, end, T)}"/>'
            f'<animate attributeName="opacity" dur="{T}s" repeatCount="indefinite" '
            f'values="0;0;1;1;0;0" keyTimes="{kt(0, start - 0.01, start, end, end + 0.15, T)}"/>')

def text(x, y, s, cls="t", on=None, off=T - 0.6, anchor=None):
    a = f' text-anchor="{anchor}"' if anchor else ""
    o = ' opacity="0"' if on is not None else ""
    anim = show(on, off) if on is not None else ""
    return f'<text x="{x}" y="{y}" class="{cls}"{a}{o}>{s}{anim}</text>'

def typed(x, y, parts, on, per=0.035, off=T - 0.6, cls="t"):
    """Characters appear one by one from `on`: a terminal typing a command."""
    out = [f'<text x="{x}" y="{y}" class="{cls}">']
    t = on
    for seg_cls, seg in parts:
        for ch in seg:
            c = escape(ch) if ch != " " else "&#160;"
            out.append(f'<tspan class="{seg_cls}" opacity="0">{c}{show(t, off, 0.01)}</tspan>')
            t += per
    out.append("</text>")
    return "".join(out), t

W, H = 1000, 600
PLANNER = "#a78bfa"
WORKER = "#34d399"
HELD = "#fbbf24"
DONE = "#60a5fa"

svg = []
add = svg.append
add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" '
    f'aria-labelledby="title desc">')
add(f'<title id="title">{_("relevo: una planificadora reparte en paralelo a workers que abre en Herdr")}</title>')
add(f'<desc id="desc">{DESC_EN if LANG == "en" else DESC_ES}</desc>')
add(f'''<defs>
<style>
  .t {{ font: 500 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; fill: #c9d1d9; }}
  .dim {{ fill: #6e7681; }}
  .p {{ fill: {PLANNER}; }} .w {{ fill: {WORKER}; }} .h {{ fill: {HELD}; }} .d {{ fill: {DONE}; }}
  .b {{ font-weight: 700; }}
  .tag {{ fill: #ff7b72; }} .attr {{ fill: #79c0ff; }} .str {{ fill: #a5d6ff; }}
  .chip {{ font: 700 11px ui-monospace, SFMono-Regular, Menlo, monospace; fill: #0d1117; letter-spacing: .06em; }}
  .h1 {{ font: 800 30px ui-sans-serif, -apple-system, "Segoe UI", Inter, sans-serif; fill: #f0f6fc; letter-spacing: -.02em; }}
  .h2 {{ font: 500 15px ui-sans-serif, -apple-system, "Segoe UI", Inter, sans-serif; fill: #8b949e; }}
  .lbl {{ font: 700 11px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; }}
</style>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#0b0f17"/><stop offset="1" stop-color="#111827"/>
</linearGradient>
<radialGradient id="glowP"><stop offset="0" stop-color="{PLANNER}" stop-opacity=".9"/><stop offset="1" stop-color="{PLANNER}" stop-opacity="0"/></radialGradient>
<radialGradient id="glowW"><stop offset="0" stop-color="{WORKER}" stop-opacity=".9"/><stop offset="1" stop-color="{WORKER}" stop-opacity="0"/></radialGradient>
<radialGradient id="glowH"><stop offset="0" stop-color="{HELD}" stop-opacity=".9"/><stop offset="1" stop-color="{HELD}" stop-opacity="0"/></radialGradient>
<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="#1f2937" stroke-width=".6"/></pattern>
<clipPath id="win"><rect x="20" y="96" width="960" height="484" rx="14"/></clipPath>
</defs>''')

# Backdrop and headline.
add(f'<rect width="{W}" height="{H}" rx="20" fill="url(#bg)"/>')
add(f'<rect width="{W}" height="{H}" rx="20" fill="url(#grid)" opacity=".55"/>')
add('<text x="36" y="52" class="h1">relevo</text>')
add(f'<text x="148" y="52" class="h2">{_("una planificadora · workers con nombre · en paralelo · en Herdr")}</text>')
SUBTITLE = 'reparte con &lt;handoff to="…"&gt;, abre lo que falta, espera todos los informes'
add(f'<text x="36" y="78" class="t dim">{_(SUBTITLE)}</text>')

# The Herdr window.
add('<rect x="20" y="96" width="960" height="484" rx="14" fill="#0d1117" stroke="#30363d"/>')
add('<g clip-path="url(#win)">')
add('<rect x="20" y="96" width="960" height="30" fill="#161b22"/>')
for i, c in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
    add(f'<circle cx="{40 + i * 18}" cy="111" r="5.5" fill="{c}"/>')
add('<text x="500" y="115" class="t dim" text-anchor="middle">Herdr — claude-mods / 1</text>')
add('</g>')

# Planner pane: full width until the split, then the left half.
PX, PY, PH = 32, 136, 380
add(f'<rect x="{PX}" y="{PY}" height="{PH}" rx="10" fill="#0f141b" stroke="{PLANNER}" stroke-opacity=".75" width="936">'
    f'{grow("width", 2.7, 3.2, 936, 452)}</rect>')
add(f'<rect x="{PX + 12}" y="{PY + 12}" width="78" height="20" rx="4" fill="{PLANNER}"/>')
add(f'<text x="{PX + 51}" y="{PY + 26}" class="chip" text-anchor="middle">PLANNER</text>')
add(f'<text x="{PX + 100}" y="{PY + 26}" class="t dim">{_("claude · esta sesión")}</text>')

L = PX + 14
line, t = typed(L, PY + 58, [("dim", "❯ "), ("t", "/relevo planner")], 0.3)
add(line)
add(text(L, PY + 78, _("PLANNER, sin workers aún"), "t dim", on=t + 0.1))
line, t = typed(L, PY + 104, [("dim", "❯ "), ("t", _("/relevo goal crea un CRUD en FastAPI"))], t + 0.4)
add(line)
GOAL_DONE = t

# The two handoff blocks the planner writes.
HB = GOAL_DONE + 0.3
add(text(L, PY + 132, '<tspan class="tag">&lt;handoff</tspan> <tspan class="attr">to</tspan>=<tspan class="str">"researcher"</tspan><tspan class="tag">&gt;</tspan>', on=HB))
add(text(L + 18, PY + 150, _("cómo pagina y valida el repo"), "t dim", on=HB + 0.15))
add(text(L, PY + 176, '<tspan class="tag">&lt;handoff</tspan> <tspan class="attr">to</tspan>=<tspan class="str">"builder"</tspan><tspan class="tag">&gt;</tspan>', on=HB + 0.35))
add(text(L + 18, PY + 194, "app/main.py · models · tests", "t dim", on=HB + 0.5))

# The split: two worker panes slide in on the right.
SPLIT = 2.95
WX, WW = 500, 468
panes = {
    "researcher": dict(y=PY, h=184, on=SPLIT, color=WORKER),
    "builder": dict(y=PY + 196, h=184, on=SPLIT + 0.2, color=WORKER),
}
for name, p in panes.items():
    y, h, on = p["y"], p["h"], p["on"]
    add(f'<g opacity="0">{show(on)}')
    add(f'<rect x="{WX}" y="{y}" width="{WW}" height="{h}" rx="10" fill="#0f141b" stroke="{WORKER}" stroke-opacity=".7"/>')
    cw = 14 + 8 * len(name)
    add(f'<rect x="{WX + 12}" y="{y + 12}" width="{cw}" height="20" rx="4" fill="{WORKER}"/>')
    add(f'<text x="{WX + 12 + cw / 2}" y="{y + 26}" class="chip" text-anchor="middle">{name.upper()}</text>')
    add(f'<text x="{WX + 22 + cw}" y="{y + 26}" class="t dim">hc run --name {name} -- claude</text>')
    add('</g>')

# Link: each worker joins back; ✓ appears.
LINK = {"researcher": 3.8, "builder": 4.05}
for name, p in panes.items():
    y = p["y"]
    add(text(WX + 14, y + 58, f'❯ /relevo join {name} <tspan class="dim">75b0de…</tspan>', on=p["on"] + 0.25))
    add(text(WX + 14, y + 78, f'<tspan class="w b">✓</tspan> {_("enlazada")} · {"BUILDER" if name == "builder" else "RESEARCHER"} ⇄ planner', on=LINK[name]))

# Packets: the planner's steps fly to both workers at once (one round).
SEND = 4.4
FLY = 0.7
src = (PX + 300, PY + 160)
for name, p in panes.items():
    dst = (WX + 30, p["y"] + 100)
    path = f'M{src[0]},{src[1]} C{src[0] + 120},{src[1]} {dst[0] - 120},{dst[1]} {dst[0]},{dst[1]}'
    add(f'<path d="{path}" fill="none" stroke="{PLANNER}" stroke-width="1.5" stroke-dasharray="4 6" opacity="0">'
        f'{show(SEND - 0.1, SEND + FLY + 0.3)}'
        f'<animate attributeName="stroke-dashoffset" dur="{T}s" repeatCount="indefinite" values="0;-200" /></path>')
    add(f'<g opacity="0"><circle r="14" fill="url(#glowP)"/><circle r="5" fill="{PLANNER}"/>{move(path, SEND, SEND + FLY)}</g>')
add(text(L, PY + 220, _("↳ ronda 1 · a los dos a la vez"), "t p b", on=SEND, off=6.8))

# Work: progress bars; the researcher finishes first.
WORK = {"researcher": (SEND + FLY, 7.0), "builder": (SEND + FLY, 9.2)}
for name, p in panes.items():
    y = p["y"]
    start, end = WORK[name]
    add(text(WX + 14, y + 108, '[relevo ronda 1 · de planner]', "t dim", on=start))
    add(f'<rect x="{WX + 14}" y="{y + 124}" width="{WW - 28}" height="8" rx="4" fill="#1f2937" opacity="0">{show(start)}</rect>')
    add(f'<rect x="{WX + 14}" y="{y + 124}" width="0" height="8" rx="4" fill="{WORKER}">'
        f'{grow("width", start, end, 0, WW - 28)}</rect>')
    label = _("leyendo src/ · 3 patrones") if name == "researcher" else _("escribiendo app/ · pytest -q")
    add(text(WX + 14, y + 156, f'<tspan class="w">⠿</tspan> {_("trabajando")} · {label}', on=start, off=end))
    add(text(WX + 14, y + 156, f'<tspan class="w b">✓</tspan> &lt;handoff&gt; {_("informe listo")}', on=end))

MERGE = 10.45
# The held tray inside the planner pane.
TRAY_Y = PY + 236
add(f'<g opacity="0">{show(6.9, MERGE - 0.25)}')
add(f'<rect x="{L - 2}" y="{TRAY_Y}" width="424" height="76" rx="8" fill="#1a1508" stroke="{HELD}" stroke-dasharray="5 4"/>')
add(f'<text x="{L + 10}" y="{TRAY_Y + 20}" class="lbl h">{_("INFORMES RETENIDOS")}</text>')
add('</g>')

R_SEND, R_FLY = 7.05, 0.65
B_SEND, B_FLY = 9.25, 0.65
for name, t0, fly, slot in [("researcher", R_SEND, R_FLY, 0), ("builder", B_SEND, B_FLY, 1)]:
    p = panes[name]
    s = (WX + 30, p["y"] + 128)
    d = (L + 30 + slot * 200, TRAY_Y + 46)
    path = f'M{s[0]},{s[1]} C{s[0] - 160},{s[1]} {d[0] + 160},{d[1]} {d[0]},{d[1]}'
    add(f'<g opacity="0"><circle r="14" fill="url(#glowW)"/><circle r="5" fill="{WORKER}"/>{move(path, t0, t0 + fly)}</g>')
    add(f'<g opacity="0">{show(t0 + fly, MERGE - 0.25)}<rect x="{d[0] - 18}" y="{d[1] - 13}" width="186" height="24" rx="5" fill="#0d1117" stroke="{WORKER}" stroke-opacity=".6"/>'
        f'<text x="{d[0] - 8}" y="{d[1] + 3}" class="t"><tspan class="w b">↓</tspan> {name}</text></g>')

add(text(L + 220, TRAY_Y + 50, _("esperando a builder…"), "t h", on=R_SEND + R_FLY + 0.1, off=B_SEND + B_FLY - 0.1))

# Both reports merge into one planner turn.
add(f'<g opacity="0">{show(MERGE)}')
add(f'<rect x="{L - 2}" y="{TRAY_Y}" width="424" height="76" rx="8" fill="#140f24" stroke="{PLANNER}"/>')
add(f'<text x="{L + 10}" y="{TRAY_Y + 22}" class="t"><tspan class="p b">❯</tspan> [relevo ronda 1 · de researcher] …</text>')
add(f'<text x="{L + 10}" y="{TRAY_Y + 42}" class="t"><tspan class="p b">❯</tspan> [relevo ronda 1 · de builder] …</text>')
add(f'<text x="{L + 10}" y="{TRAY_Y + 64}" class="lbl p">{_("2 INFORMES · 1 TURNO")}</text>')
add('</g>')

DONE_T = 11.6
add(f'<g opacity="0">{show(DONE_T)}')
add(f'<rect x="{L - 2}" y="{PY + 326}" width="424" height="40" rx="8" fill="#0b1a2e" stroke="{DONE}"/>')
add(f'<text x="{L + 12}" y="{PY + 351}" class="t"><tspan class="tag">&lt;done&gt;</tspan> {_("CRUD listo · tests en verde")} <tspan class="d b">✓</tspan></text>')
add('</g>')

# Status band, as relevo draws it above the prompt.
BY = 532
add(f'<rect x="32" y="{BY}" width="936" height="34" rx="8" fill="#161b22" stroke="#30363d"/>')
add(f'<circle cx="50" cy="{BY + 17}" r="5" fill="{WORKER}"><animate attributeName="fill" dur="{T}s" repeatCount="indefinite" '
    f'values="#8b949e;#8b949e;{WORKER};{HELD};{PLANNER};{DONE};#8b949e" keyTimes="{kt(0, 2.9, 3.0, 7.7, 10.45, 11.6, T)}" calcMode="discrete"/></circle>')
add(f'<text x="64" y="{BY + 22}" class="t"><tspan class="b" style="fill:#d2a8ff">relevo</tspan></text>')
add(f'<rect x="124" y="{BY + 8}" width="72" height="18" rx="4" fill="{PLANNER}"/><text x="160" y="{BY + 21}" class="chip" text-anchor="middle">PLANNER</text>')
add(f'<text x="206" y="{BY + 22}" class="t p">⇄</text>')
add(text(226, BY + 22, "?", "t dim", on=0.0, off=2.9))
add(text(226, BY + 22, 'researcher <tspan class="h">…</tspan>, builder <tspan class="h">…</tspan>', "t b", on=2.95, off=3.95))
add(text(226, BY + 22, 'researcher <tspan class="w">✓</tspan>, builder <tspan class="w">✓</tspan>', "t b", on=4.05))
add(text(470, BY + 22, f'· {_("ronda")} <tspan class="dim">▱▱▱▱▱▱▱▱▱▱</tspan> 0/10', "t", on=0.0, off=SEND))
add(text(470, BY + 22, f'· {_("ronda")} <tspan class="p">▰</tspan><tspan class="dim">▱▱▱▱▱▱▱▱▱</tspan> 1/10', "t", on=SEND))
STATES = [
    (0.0, 2.9, "esperando objetivo", "dim"),
    (2.9, 4.4, "abriendo workers en Herdr", "dim"),
    (4.4, 7.7, "turno de researcher, builder", "w"),
    (7.7, 10.45, "researcher entregó, falta builder", "h"),
    (10.45, 11.6, "trabajando aquí", "p"),
    (11.6, T - 0.6, "terminado", "d"),
]
for on, off, s, c in STATES:
    add(text(668, BY + 22, f'· <tspan class="{c}">{_(s)}</tspan>', "t", on=on, off=off))

add('</svg>')
open(sys.argv[1], "w").write("\n".join(svg))
print("ok", len("\n".join(svg)) // 1024, "KB")
