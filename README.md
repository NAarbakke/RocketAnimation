# Kestrel labs

Three linked pages: the **launch** animation, a **liquid engine** lab (gas-generator cycle) and a
**solid motor** lab. Switch between them with the tabs in the top-left corner.

```bash
npm install
npm run dev          # http://localhost:5173  (launch · /engine.html · /srm.html)
npm run build        # static site in dist/, host anywhere
```

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Renderer | three.js **0.147** (pinned) | Same renderer and version the pages were tuned on, so the look is unchanged. Upgrading (r15x+ changes lighting and colour management) is a deliberate re-tune, not a bump. |
| Build / dev | Vite 6 + TypeScript | Instant reload; watches `public/models/` and hot-swaps CAD exports into open pages without losing state. |
| Heavy compute | Web Worker (`src/srm/burn.worker.ts`) | Grain voxelisation and the distance transform run off the main thread. |
| CAD | build123d (Python, `cad/.venv`) | Code-CAD scripts export named-part GLBs. CadQuery `Assembly.save('x.glb')` and FreeCAD's glTF export work the same way. |

Performance budget (measured on Intel UHD integrated graphics): no MSAA on the HDR target, bloom at half
resolution, render scale starts at ≤1.25× and steps down automatically below ~40 fps, then bloom turns off
as a last resort. See `src/shared/stage.ts`.

## Layout

```
index.html, engine.html, srm.html   pages
src/shared/     stage (renderer + post + quality), nozzle gas dynamics, plume, lab.css
src/launch/     launch animation (migrated as-is, plain JS module)
src/engine/     liquid-engine lab (migrated as-is, plain JS module)
src/srm/        solid-motor lab: main, burn worker, ballistics, CAD loader, grain volume renderer
cad/srm.py      default solid motor (build123d), exports public/models/srm.glb + srm.json
public/models/  CAD exports the site loads
```

## Using your own CAD (solid motor)

1. Edit `cad/srm.py`, or write your own script, then run `npm run cad:watch` in a second terminal.
   Every save re-exports `public/models/srm.glb`.
2. On the Solid motor page, pick **CAD**. Each export is picked up live: the grain burn-back,
   pressure, thrust, charts, plume and tour all recompute from the new geometry.

**Contract.** A GLB with parts named by prefix (case-insensitive):

| Name | Needed | Used for |
| --- | --- | --- |
| `grain…` | yes, one or more closed solids | voxelised; burn-back distance field, Ab(w), propellant mass |
| `nozzle…` | yes | sliced along the axis; throat and exit radius, flow profile |
| `case…` | optional | case inner radius (particle/plume bounds); displayed |
| `insulation…`, `liner…`, `forward_closure…`, `igniter…`, anything else | optional | displayed |

- Axis, orientation and units (m or mm) are detected: the axis runs from nozzle to grain, and the throat
  is found as the narrowest nozzle section.
- An optional `public/models/srm.json` next to the GLB sets
  `{"units": "mm", "inhibit": ["forward", "aft"], "meop_MPa": 9}`. Inhibited ends are treated as bonded and
  don't burn; `meop_MPa` is the case pressure limit used for burst warnings.
- The grain is assumed case-bonded on its outside. Faces open to the port or to the end gaps burn.

## Not done yet

- **CAD import for the liquid engine.** The same pattern applies: slice a `chamber`/`nozzle` part for the
  contour that drives the 1-D flow, spin `rotor*` parts, and take flow paths from a manifest. The engine
  code is still procedural.
- **Launch page shaders.** The log-depth `#include`s are spliced mid-line, so the earth, clouds, atmosphere,
  flood beams, plumes and smoke/fire shaders never compile (see the note above `LOGV` in `src/launch/main.js`).
  Fixing that brings them back but drops the page to ~7 fps on Intel UHD and changes the look, so it needs a
  tuning pass (cheaper earth/cloud noise) before it ships.
- Solid-motor physics omits erosive burning, throat erosion and the ignition transient. The footnote on
  the page says so.
