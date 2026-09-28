"""Default solid rocket motor for the Solid Motor lab (build123d, millimetres, motor axis = Z, nozzle at -Z).

    npm run cad           # export once  -> public/models/srm.glb (+ srm.json)
    npm run cad:watch     # re-export every time you save this file

The lab finds parts by label, so keep these names (case-insensitive, prefixes are fine):
    grain*          propellant (one or more segments) -- REQUIRED; burn-back is computed from this
    nozzle*         must contain the throat -- REQUIRED; throat/exit area come from this
    case*, insulation*, forward_closure*, igniter*   -- optional, displayed
Everything else is displayed as-is. Swap this file for your own CadQuery/FreeCAD export as long as
the labels match and the result is a .glb in public/models/.
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
import time
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "models"

# ---- parameters (mm) -------------------------------------------------------
GRAIN = "bates"          # "bates" | "star" | "finocyl"
CASE_ID = 300.0          # case inner diameter
CASE_WALL = 6.0
INSULATION = 4.0         # liner between case and propellant
GRAIN_LEN = 1200.0       # total propellant length
SEGMENTS = 3             # bates only
SEG_GAP = 30.0           # bates only
CORE_D = 100.0           # bates/finocyl core diameter
STAR_POINTS = 8          # star only
STAR_RI, STAR_RO = 45.0, 95.0
FINS, FIN_R, FIN_W, FIN_FRAC = 6, 110.0, 16.0, 0.4  # finocyl: fin tip radius, width, aft fraction of length
KN_TARGET = 250.0        # throat sized for this burning-area/throat-area ratio at ignition
EXPANSION = 8.0          # nozzle exit/throat area ratio
GRAIN_Z0 = 300.0         # aft face of the grain (throat sits at z = 0)


def build():
    from build123d import (Axis, Circle, Color, Compound, Cylinder, Location, Plane, Polygon, Polyline, Rectangle,
                           Unit, export_gltf, extrude, make_face, revolve)

    rg = CASE_ID / 2 - INSULATION  # grain outer radius (case-bonded)

    def ring_z(r_out, r_in, z0, length):
        return Cylinder(r_out, length, align=None).moved(Location((0, 0, z0))) - Cylinder(r_in, length, align=None).moved(Location((0, 0, z0)))

    def revolved(pts):
        return revolve(make_face(Plane.XZ * Polyline(*pts, close=True)), Axis.Z)

    # propellant ------------------------------------------------------------
    grains, ab0 = [], 0.0
    if GRAIN == "bates":
        seg = (GRAIN_LEN - (SEGMENTS - 1) * SEG_GAP) / SEGMENTS
        rc = CORE_D / 2
        for i in range(SEGMENTS):
            grains.append(ring_z(rg, rc, GRAIN_Z0 + i * (seg + SEG_GAP), seg))
        ab0 = SEGMENTS * (2 * math.pi * rc * seg + 2 * math.pi * (rg**2 - rc**2))
        inhibit = []
    else:
        if GRAIN == "star":
            pts = []
            for k in range(STAR_POINTS * 2):
                a = k * math.pi / STAR_POINTS
                r = STAR_RO if k % 2 == 0 else STAR_RI
                pts.append((r * math.cos(a), r * math.sin(a)))
            section = Circle(rg) - Polygon(*pts, align=None)
            perim = sum(math.dist(pts[k], pts[(k + 1) % len(pts)]) for k in range(len(pts)))
            ab0 = perim * GRAIN_LEN
        else:  # finocyl: round core full length, slots in the aft part
            section = Circle(rg) - Circle(CORE_D / 2)
            ab0 = math.pi * CORE_D * GRAIN_LEN
        body = extrude(Plane.XY.offset(GRAIN_Z0) * section, amount=GRAIN_LEN)
        if GRAIN == "finocyl":
            fl = GRAIN_LEN * FIN_FRAC
            for k in range(FINS):
                slot = extrude(Plane.XY.offset(GRAIN_Z0) * Rectangle(FIN_R, FIN_W, align=None).moved(Location((0, -FIN_W / 2, 0))), amount=fl)
                body -= slot.rotate(Axis.Z, k * 360 / FINS)
            ab0 += FINS * 2 * (FIN_R - CORE_D / 2) * fl
        grains.append(body)
        inhibit = ["forward", "aft"] if GRAIN == "star" else ["forward"]

    # nozzle: throat sized so Kn = Ab/At hits the target at ignition ------------
    rt = math.sqrt(ab0 / KN_TARGET / math.pi)
    re = rt * math.sqrt(EXPANSION)
    ld = (re - rt) / math.tan(math.radians(15))
    r_in = CASE_ID / 2 - 10
    inner = [(r_in, GRAIN_Z0 - 20), (r_in * 0.55, GRAIN_Z0 * 0.45), (rt * 1.25, 30.0), (rt, 0.0), (rt * 1.15, -25.0), (re, -ld)]
    wall = lambda z: 26.0 if z > -40 else 9.0
    outer = [(r + wall(z), z) for r, z in reversed(inner)]
    nozzle = revolved(inner + outer)

    # case, liner, closures ------------------------------------------------------
    z_case0, z_case1 = GRAIN_Z0 - 30, GRAIN_Z0 + GRAIN_LEN + 20
    case = ring_z(CASE_ID / 2 + CASE_WALL, CASE_ID / 2, z_case0, z_case1 - z_case0)
    insulation = ring_z(CASE_ID / 2, rg, GRAIN_Z0, GRAIN_LEN)
    fwd = Cylinder(CASE_ID / 2 + CASE_WALL, 24, align=None).moved(Location((0, 0, z_case1)))
    igniter = Cylinder(22, 140, align=None).moved(Location((0, 0, z_case1 - 140)))

    parts = [(case, "case", (0.62, 0.64, 0.68)), (insulation, "insulation", (0.16, 0.15, 0.14)), (nozzle, "nozzle", (0.2, 0.19, 0.18)),
             (fwd, "forward_closure", (0.55, 0.57, 0.6)), (igniter, "igniter", (0.8, 0.45, 0.2))]
    parts += [(g, f"grain_{i + 1}", (0.74, 0.66, 0.52)) for i, g in enumerate(grains)]
    children = []
    for shape, label, rgb in parts:
        shape.label = label
        shape.color = Color(*rgb)
        children.append(shape)
    motor = Compound(label="srm", children=children)

    OUT.mkdir(parents=True, exist_ok=True)
    export_gltf(motor, str(OUT / "srm.glb"), unit=Unit.MM, binary=True, linear_deflection=0.4, angular_deflection=0.15)
    (OUT / "srm.json").write_text(json.dumps({"units": "m", "grain": GRAIN, "inhibit": inhibit, "meop_MPa": 9.0}, indent=2))
    print(f"srm.glb written: {GRAIN}, Ab0 {ab0 / 1e6:.3f} m^2, throat d {2 * rt:.1f} mm, exit d {2 * re:.1f} mm")


if __name__ == "__main__":
    if "--watch" in sys.argv:
        me, seen = Path(__file__), 0.0
        print("watching", me.name, "- save it to re-export (Ctrl+C to stop)")
        while True:
            m = me.stat().st_mtime
            if m != seen:
                seen = m
                subprocess.run([sys.executable, str(me)])  # fresh process = fresh module state
            time.sleep(0.5)
    else:
        build()
