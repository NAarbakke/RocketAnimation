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
video/          everything video: render.js (Playwright), hf.js + compositions (HyperFrames), out/ for finished files
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

## Rendering video

```bash
npm run render -- "srm.html?film" --duration 18        # video/out/srm.mp4, 1920x1080 @ 30 fps
npm run render -- index.html --duration 60 --fps 60    # the launch, HUD included
npm run render -- engine.html --size 1280x720 --out video/out/engine-720.mp4
```

`video/render.js` starts the Vite dev server, opens the page in headless Chrome through Playwright, steps it
one frame at a time on a virtual clock and pipes the screenshots to ffmpeg (H.264). Frames are stepped rather
than recorded live, so the result is smooth however slow the GPU is. `--click <selector>` (repeatable) presses
a control before the first frame. A page that sets `window.__film` (the solid motor with `?film`: 3D stage
only, ignition after 1 s, slow orbit) is given the time directly; any other page is driven through
`requestAnimationFrame`, so CSS transitions there still run in real time and look snappier than live.
`renderVideo()` is exported for use from other scripts. ffmpeg comes from the `ffmpeg-static` package
(`FFMPEG_PATH` overrides it); the browser is the installed Chrome (`--channel msedge` or `chromium` to change).

HyperFrames handles the editing side. Both commands go through `video/hf.js`, which runs the HyperFrames CLI
with the bundled ffmpeg and ffprobe on `PATH`:

- `npm run video` films the solid motor directly: it builds the site into `video/site` and renders the
  composition in `video/index.html`, which drives the lab's `window.__film` clock, to `video/out/srm-hyperframes.mp4`.
- `npm run sample` uses both tools: Playwright renders a clip of each page into `video/clips/`, then
  HyperFrames cuts them together with titles (`video/showcase.html`) into `video/out/showcase.mp4`.

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
