// Solid rocket motor lab. Geometry comes from a preset or from public/models/srm.glb; either way the grain is
// voxelised in a worker, burn-back is a distance field, and ballistics + visuals are derived from that.
import * as THREE from 'three';
import { createStage, lin } from '../shared/stage';
import { createPlume } from '../shared/plume';
import { ambient, machFromArea, thrustCoef } from '../shared/nozzle';
import { PROPS, simulate, at, type Sim, type Propellant } from './ballistics';
import { loadCad, type CadMotor } from './model';
import { createGrainVolume } from './volume';
import type { BurnJob, BurnResult, MotorGeom, Preset } from './types';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const TAU = Math.PI * 2, DEG = Math.PI / 180;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const f0 = (n: number) => Math.round(n).toLocaleString('en-US'), f1 = (n: number) => n.toFixed(1), f2 = (n: number) => n.toFixed(2);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const V2 = THREE.Vector2, V3 = THREE.Vector3;

// =====================================================================
// Stage
// =====================================================================
const stage = $('stage');
const st = createStage($('c') as HTMLCanvasElement, stage);
if (!st || !st.renderer.capabilities.isWebGL2) { $('err').hidden = false; throw new Error('WebGL 2 required'); }
const { renderer, scene, camera, controls } = st;
renderer.localClippingEnabled = true;
const key = new THREE.DirectionalLight(lin(0xe6eeff), 0.9); key.position.set(4, 5, 3); scene.add(key);
const rim = new THREE.DirectionalLight(lin(0x7090ff), 0.45); rim.position.set(-4, 1, -4); scene.add(rim);
const portLight = new THREE.PointLight(0xff9a50, 0, 2.5, 1.5); scene.add(portLight);
const exitLight = new THREE.PointLight(0xffb070, 0, 4, 1.5); scene.add(exitLight);

// =====================================================================
// Motor definitions (canonical frame: axis +Y forward, throat at origin)
// =====================================================================
const MOTOR = { R: 0.146, L: 1.2, y0: 0.3, caseR: 0.15, caseY0: 0.27, caseY1: 1.52, wall: 0.006, meop: 9e6 };
const KN0 = 250; // preset nozzles are sized for this Kn at ignition
type GrainKey = 'bates' | 'star' | 'finocyl' | 'endburner' | 'cad';
const base: Preset = { type: 'bates', R: MOTOR.R, L: MOTOR.L, y0: MOTOR.y0, segs: 3, gap: 0.03, core: 0.05, starN: 8, starRi: 0.045, starRo: 0.095, fins: 6, finR: 0.11, finW: 0.016, finFrac: 0.4 };
const GRAINS: Record<Exclude<GrainKey, 'cad'>, { preset: Preset; fwd: boolean; aft: boolean; note: string }> = {
  bates: { preset: { ...base }, fwd: false, aft: false,
    note: 'Three hollow cylinders burning on the inside and on both ends. As the core widens the ends shrink, so the burning area stays nearly constant and the thrust curve is neutral. It is the standard test-motor grain.' },
  star: { preset: { ...base, type: 'star' }, fwd: true, aft: true,
    note: 'A star-shaped bore with inhibited ends. The star points hold a lot of surface that burns off early, so thrust starts high and falls away, which suits a lift-off boost followed by a lighter rocket.' },
  finocyl: { preset: { ...base, type: 'finocyl', core: 0.04 }, fwd: true, aft: false,
    note: 'Fin-o-cylinder: a round core with slots at the aft end. The fins add a burst of area at ignition that burns away, then the core carries on. Large boosters use tricks like this to shape their thrust.' },
  endburner: { preset: { ...base, type: 'endburner' }, fwd: true, aft: false,
    note: 'Burns only from the aft face, like a cigarette. The area is small and constant, so thrust is low but lasts a long time. Used for sustainers and gas generators.' },
};
const CAD_URL = '/models/srm.glb', CAD_MANIFEST = '/models/srm.json';

const S = { grain: 'bates' as GrainKey, prop: 'apcp', throat: 1, tempC: 21, alt: 0, cut: true, labels: true, real: false };
let P: Propellant = PROPS.apcp;
let res: BurnResult | null = null, geom: MotorGeom | null = null, sim: Sim | null = null, cad: CadMotor | null = null, cadError = '', cadStamp = '';
const play = { t: 0, playing: false, started: false };

// =====================================================================
// Worker
// =====================================================================
const worker = new Worker(new URL('./burn.worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;
const waiting = new Map<number, { ok: (r: BurnResult) => void; fail: (e: Error) => void }>();
worker.onmessage = e => {
  const w = waiting.get(e.data.id); if (!w) return;
  waiting.delete(e.data.id); if (e.data.ok) w.ok(e.data.r); else w.fail(new Error(e.data.error));
};
const burn = (job: BurnJob) => new Promise<BurnResult>((ok, fail) => { const id = nextId++; waiting.set(id, { ok, fail }); worker.postMessage({ ...job, id }); });

function presetGeom(ab0: number): MotorGeom {
  const rt = Math.sqrt(ab0 / KN0 / Math.PI), re = rt * Math.sqrt(8), ld = (re - rt) / Math.tan(15 * DEG);
  const pts: [number, number][] = [[0.14, MOTOR.y0 - 0.02], [0.077, MOTOR.y0 * 0.45], [rt * 1.25, 0.03], [rt, 0], [rt * 1.15, -0.025], [re, -ld]];
  const n = 180, y = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const yy = pts[0][1] + ((pts[5][1] - pts[0][1]) * i) / (n - 1);
    let k = 0; while (k < 4 && yy < pts[k + 1][1]) k++;
    const [ra, ya] = pts[k], [rb, yb] = pts[k + 1];
    y[i] = yy; r[i] = ra + ((rb - ra) * (yy - ya)) / (yb - ya);
  }
  return { source: 'preset', caseR: MOTOR.caseR, caseY0: MOTOR.caseY0, caseY1: MOTOR.caseY1, nozzle: { y, r }, rt, re, ye: -ld, meop: MOTOR.meop };
}

// =====================================================================
// Hardware meshes
// =====================================================================
const std = (hex: number, metal: number, rough: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color: lin(hex), metalness: metal, roughness: rough, side: THREE.DoubleSide, envMapIntensity: 0.75, ...extra });
const MAT = {
  case: std(0x9aa1aa, 0.85, 0.3), insul: std(0x2b2826, 0.1, 0.8), nozzle: std(0x2f2b28, 0.35, 0.55, { emissive: lin(0xff5a1a), emissiveIntensity: 0 }),
  steel: std(0xb0b8c2, 0.9, 0.28), cut: std(0xc9412a, 0.1, 0.6, { emissive: lin(0x3a0a03) }), ign: std(0xc98a4a, 0.6, 0.4, { emissive: lin(0xffc070), emissiveIntensity: 0 }),
};
const clipPlane = new THREE.Plane(new V3(-1, 0, 0), 0); // keeps x <= 0
const hw = new THREE.Group(); scene.add(hw);
let volume: ReturnType<typeof createGrainVolume> | null = null;

const phi = () => (S.cut ? [Math.PI, Math.PI] : [0, TAU]);
function lathe(pts: THREE.Vector2[], mat: THREE.Material) { const [a, b] = phi(); hw.add(new THREE.Mesh(new THREE.LatheGeometry(pts, b < TAU ? 64 : 112, a, b), mat)); }
function wall(inner: THREE.Vector2[], outer: THREE.Vector2[], mat: THREE.Material) {
  lathe(inner, mat); lathe(outer, mat);
  lathe([inner[0], outer[0]], mat); lathe([inner[inner.length - 1], outer[outer.length - 1]], mat);
  if (!S.cut) return;
  const g = new THREE.ShapeGeometry(new THREE.Shape().setFromPoints([...outer, ...inner.slice().reverse()]), 2);
  for (const r of [-Math.PI / 2, Math.PI / 2]) { const m = new THREE.Mesh(g, MAT.cut); m.rotation.y = r; hw.add(m); }
}
function nozzleProfile(g: MotorGeom) { // visual throat follows the throat-diameter slider
  const dr = g.rt * (S.throat - 1);
  return Array.from(g.nozzle.y, (y, i) => new V2(Math.max(0.004, g.nozzle.r[i] + dr * Math.exp(-((y / 0.05) ** 2))), y));
}

function buildHardware() {
  hw.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && !cad?.root.getObjectById(m.id)) m.geometry.dispose(); });
  hw.clear();
  if (!geom) return;
  if (geom.source === 'cad' && cad) {
    hw.add(cad.root);
    for (const { mesh, role } of cad.parts) {
      mesh.visible = role !== 'grain';
      const old = mesh.material as THREE.MeshStandardMaterial;
      const col = (mesh.userData.col ??= old.color ? old.color.clone() : new THREE.Color(0.6, 0.6, 0.6)) as THREE.Color;
      mesh.material = new THREE.MeshStandardMaterial({
        color: col, metalness: role === 'insulation' || role === 'liner' ? 0.1 : 0.7, roughness: 0.4, side: THREE.DoubleSide, envMapIntensity: 0.75,
        clippingPlanes: S.cut ? [clipPlane] : [], emissive: role === 'nozzle' ? lin(0xff5a1a) : new THREE.Color(0), emissiveIntensity: 0,
      });
      if (role === 'nozzle') mesh.userData.hot = true;
    }
    return;
  }
  const { caseR, caseY0, caseY1 } = geom, cw = MOTOR.wall;
  wall([new V2(caseR, caseY1), new V2(caseR, caseY0)], [new V2(caseR + cw, caseY1), new V2(caseR + cw, caseY0)], MAT.case);
  wall([new V2(MOTOR.R, MOTOR.y0 + MOTOR.L), new V2(MOTOR.R, MOTOR.y0)], [new V2(caseR, MOTOR.y0 + MOTOR.L), new V2(caseR, MOTOR.y0)], MAT.insul);
  const inner = nozzleProfile(geom), outer = inner.map(p => new V2(p.x + (p.y > -0.04 ? 0.026 : 0.009), p.y));
  wall(inner, outer, MAT.nozzle);
  const [a, b] = phi();
  const fc = new THREE.Mesh(new THREE.CylinderGeometry(caseR + cw, caseR + cw, 0.024, 96, 1, false, a, b), MAT.steel); fc.position.y = caseY1 + 0.012; hw.add(fc);
  const ig = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.14, 32, 1, false, a, b), MAT.ign); ig.position.y = caseY1 - 0.07; hw.add(ig);
}

// =====================================================================
// Nozzle flow profile (for particles), plume, particles, smoke
// =====================================================================
const flow = { y: new Float32Array(0), r: new Float32Array(0), vis: new Float32Array(0), y0: 0, y1: 0 };
function buildFlow() {
  if (!geom) return;
  const g = P.g, rt = geom.rt * S.throat, prof = nozzleProfile(geom), n = prof.length;
  flow.y = new Float32Array(n); flow.r = new Float32Array(n); flow.vis = new Float32Array(n);
  let vmax = 1e-6;
  for (let i = 0; i < n; i++) {
    const { x: r, y } = prof[i], M = machFromArea((r / rt) ** 2, g, y < 0), T = 1 / (1 + ((g - 1) / 2) * M * M);
    flow.y[i] = y; flow.r[i] = r; flow.vis[i] = M * Math.sqrt(T); vmax = Math.max(vmax, flow.vis[i]);
  }
  for (let i = 0; i < n; i++) flow.vis[i] = 0.25 + 1.9 * (flow.vis[i] / vmax);
  flow.y0 = flow.y[0]; flow.y1 = flow.y[n - 1];
}
const flowIdx = (y: number) => clamp(Math.round(((flow.y0 - y) / (flow.y0 - flow.y1)) * (flow.y.length - 1)), 0, flow.y.length - 1);

const plume = createPlume(); scene.add(plume.mesh);

const NP = 1600;
const pPos = new Float32Array(NP * 3), pCol = new Float32Array(NP * 3), pSize = new Float32Array(NP);
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aCol', new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1).setUsage(THREE.DynamicDrawUsage));
const ptsU = { uScale: { value: 500 } };
const pts = new THREE.Points(pGeo, new THREE.ShaderMaterial({
  uniforms: ptsU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `attribute float aSize; attribute vec3 aCol; uniform float uScale; varying vec3 vCol;
    void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv;
      gl_PointSize = aSize > 0.0 ? clamp(aSize*uScale/-mv.z, 1.5, 28.0) : 0.0; vCol = aCol; }`,
  fragmentShader: `varying vec3 vCol; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, d); gl_FragColor = vec4(vCol*a*a, 1.0); }`,
}));
pts.frustumCulled = false; scene.add(pts);
const part = { y: new Float32Array(NP), cs: new Float32Array(NP), sn: new Float32Array(NP), f: new Float32Array(NP) };

const NS = 220;
const sPos = new Float32Array(NS * 3), sCol = new Float32Array(NS * 4), sSize = new Float32Array(NS), sVel = new Float32Array(NS * 3), sLife = new Float32Array(NS);
for (let i = 0; i < NS; i++) sLife[i] = -Math.random() * 3;
const sGeo = new THREE.BufferGeometry();
sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
sGeo.setAttribute('aCol', new THREE.BufferAttribute(sCol, 4));
sGeo.setAttribute('aSize', new THREE.BufferAttribute(sSize, 1));
const smoke = new THREE.Points(sGeo, new THREE.ShaderMaterial({
  uniforms: ptsU, transparent: true, depthWrite: false,
  vertexShader: `attribute float aSize; attribute vec4 aCol; uniform float uScale; varying vec4 vCol;
    void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = min(aSize*uScale/-mv.z, 64.0); vCol = aCol; }`,
  fragmentShader: `varying vec4 vCol; void main(){ float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vCol.rgb, vCol.a*smoothstep(0.5, 0.0, d)); }`,
}));
smoke.frustumCulled = false; smoke.renderOrder = 2; scene.add(smoke);

function sliceOf(y: number) { return res ? clamp(Math.floor((y - res.oy) / res.h), 0, res.ny - 1) : 0; }
/** Gas radius at height y after web w (nearly exact for round ports, a fair guess for stars). -1 = still solid. */
function gasRadius(y: number, w: number) {
  if (!res || !geom) return -1;
  const j = sliceOf(y), mn = res.minD[j];
  if (mn < 0) return geom.caseR * 0.95;            // no propellant in this slice (segment gap, plenum)
  if (w < mn) return -1;
  return w >= res.maxD[j] ? geom.caseR * 0.95 : Math.min(geom.caseR * 0.95, Math.max(res.portR[j], 0.01) + (w - mn));
}
function spawn(i: number, w: number) {
  const th = Math.random() * TAU; part.cs[i] = Math.cos(th); part.sn[i] = Math.sin(th); part.f[i] = Math.sqrt(Math.random()) * 0.95;
  if (!res) return;
  for (let k = 0; k < 6; k++) { const y = res.yMin + Math.random() * (res.yMax - res.yMin); if (gasRadius(y, w) > 0) { part.y[i] = y; return; } }
  part.y[i] = res.yMin - 0.01;
}

function updateParticles(dt: number, B: number, w: number) {
  if (!res || !geom || !flow.y.length) return;
  const len = plume.shape.len, span = res.yMax - res.yMin, glow = 0.1 * B;
  for (let i = 0; i < NP; i++) {
    let y = part.y[i];
    const inPort = y > res.yMin, inNoz = !inPort && y > flow.y1;
    const v = inPort ? 0.06 + 0.9 * clamp((res.yMax - y) / span, 0, 1) : inNoz ? (y > flow.y0 ? 1 : flow.vis[flowIdx(y)]) : flow.vis[flow.vis.length - 1] * (1 - 0.4 * (flow.y1 - y) / len);
    y -= v * dt * (0.3 + 0.7 * B);
    if (y < flow.y1 - len || B < 0.01) { spawn(i, w); y = part.y[i]; }
    part.y[i] = y;
    const o = i * 3; let r: number, c = P.flame, k = 1, size = 0.012;
    if (y > res.yMin) { const gr = gasRadius(y, w); r = (gr > 0 ? gr : 0.01) * part.f[i]; k = 0.7; }
    else if (y > flow.y1) { r = (y > flow.y0 ? geom.caseR * 0.9 : flow.r[flowIdx(y)] * 0.92) * part.f[i]; c = P.core; k = 0.9; }
    else { const u = (flow.y1 - y) / len; r = plume.radiusAt((u * len) / plume.shape.re) * part.f[i]; k = Math.pow(1 - u, 2) * 1.4; size = 0.014 + u * 0.05; }
    pPos[o] = r * part.cs[i]; pPos[o + 1] = y; pPos[o + 2] = r * part.sn[i];
    pCol[o] = c[0] * k * glow; pCol[o + 1] = c[1] * k * glow; pCol[o + 2] = c[2] * k * glow;
    pSize[i] = B > 0.01 ? size : 0;
  }
  pGeo.attributes.position.needsUpdate = pGeo.attributes.aCol.needsUpdate = pGeo.attributes.aSize.needsUpdate = true;
}
function updateSmoke(dt: number, B: number) {
  const sc = P.smoke, y0 = flow.y1 - plume.shape.len * 0.35;
  for (let i = 0; i < NS; i++) {
    const was = sLife[i]; let l = was + dt * 0.3;
    if (l >= 1 || (was < 0 && l >= 0)) {
      l = l >= 1 ? l - 1 : l;
      sPos.set([(Math.random() - 0.5) * 0.2, y0 - Math.random() * 0.3, (Math.random() - 0.5) * 0.2], i * 3);
      sVel.set([(Math.random() - 0.5) * 0.3, -1.4 - Math.random() * 0.6, (Math.random() - 0.5) * 0.3], i * 3);
      sCol[i * 4 + 3] = 0; if (B < 0.02) l = -Math.random(); // only emit while burning
    }
    sLife[i] = l;
    for (let k = 0; k < 3; k++) sPos[i * 3 + k] += sVel[i * 3 + k] * dt;
    sVel[i * 3 + 1] *= 1 - 0.5 * dt;
    sSize[i] = l < 0 ? 0 : 0.12 + l * 1.1;
    const a = l < 0 ? 0 : sc[3] * Math.pow(1 - l, 1.6) * smooth(0, 0.1, l);
    sCol.set([sc[0], sc[1], sc[2], a], i * 4);
  }
  sGeo.attributes.position.needsUpdate = sGeo.attributes.aCol.needsUpdate = sGeo.attributes.aSize.needsUpdate = true;
}

// =====================================================================
// Load / compute pipeline
// =====================================================================
let loadSeq = 0;
async function rebuild() {
  const my = ++loadSeq;
  $('busy').hidden = false;
  try {
    let job: BurnJob, g: MotorGeom | null = null;
    if (S.grain === 'cad') {
      cad = await loadCad(`${CAD_URL}?t=${Date.now()}`, `${CAD_MANIFEST}?t=${Date.now()}`);
      const inh = cad.manifest.inhibit ?? [];
      job = { kind: 'mesh', tris: cad.grainTris, bounds: cad.bounds, voxels: 1.8e6, inhibitFwd: inh.includes('forward'), inhibitAft: inh.includes('aft') };
      g = cad.geom; cadError = ''; cadStamp = new Date().toLocaleTimeString();
    } else {
      const d = GRAINS[S.grain], p = d.preset;
      job = { kind: 'preset', preset: p, bounds: [-p.R, p.y0, -p.R, p.R, p.y0 + p.L, p.R], voxels: 1.6e6, inhibitFwd: d.fwd, inhibitAft: d.aft };
    }
    const r = await burn(job);
    if (my !== loadSeq) return;
    res = r; geom = g ?? presetGeom(r.ab[0]);
    volume?.dispose(); if (volume) scene.remove(volume.mesh);
    volume = createGrainVolume(r); scene.add(volume.mesh);
    volume.uniforms.uAlb.value.copy(lin(P.color)); volume.uniforms.uCut.value = S.cut ? 1 : 0;
    const iso = niceStep(r.wmax / 7); volume.uniforms.uIso.value = r.wmax / iso;
    $('legIso').textContent = `${f0(iso * 1000)} mm of web`;
    for (let i = 0; i < NP; i++) spawn(i, 0);
    buildHardware(); resim(true);
  } catch (e) {
    cadError = String((e as Error).message || e);
    if (S.grain === 'cad') caption('CAD model not loaded', cadError);
  } finally { if (my === loadSeq) $('busy').hidden = true; renderCadBox(); }
}
function niceStep(x: number) { const p = Math.pow(10, Math.floor(Math.log10(x))), m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }

function resim(resetTime = false) {
  if (!res || !geom) return;
  const prev = sim;
  sim = simulate(res, P, geom.rt * S.throat, geom.re, { tempC: S.tempC, altKm: S.alt });
  if (resetTime || !prev) { play.t = 0; play.playing = false; play.started = false; }
  else play.t = Math.min(play.t, sim.tEnd);
  buildFlow();
  if (geom.source === 'preset' && resetTime === false) buildHardware(); // throat slider reshapes preset nozzles
  refreshStatic();
}

// =====================================================================
// UI
// =====================================================================
function seg(id: string, attr: string, cur: string) { document.querySelectorAll(`#${id} button`).forEach(b => b.setAttribute('aria-checked', String((b as HTMLElement).dataset[attr] === cur))); }
function setGrain(g: GrainKey) {
  S.grain = g; seg('grains', 'g', g);
  $('grainNote').textContent = g === 'cad' ? 'Your model from public/models/srm.glb. Burn-back, pressure, thrust and the visuals are all computed from its grain and nozzle geometry.' : GRAINS[g].note;
  rebuild();
}
function setProp(k: string) { S.prop = k; P = PROPS[k]; seg('props', 'p', k); $('propNote').textContent = P.note; if (volume) volume.uniforms.uAlb.value.copy(lin(P.color)); resim(true); }
document.querySelectorAll('#grains button').forEach(b => b.addEventListener('click', () => setGrain((b as HTMLElement).dataset.g as GrainKey)));
document.querySelectorAll('#props button').forEach(b => b.addEventListener('click', () => setProp((b as HTMLElement).dataset.p!)));
for (const [id, keyName] of [['grains', 'g'], ['props', 'p']] as const) {
  $(id).addEventListener('keydown', e => {
    const bs = [...document.querySelectorAll<HTMLElement>(`#${id} button`)], i = bs.findIndex(b => b.getAttribute('aria-checked') === 'true');
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return; e.preventDefault(); e.stopPropagation();
    const nb = bs[(i + d + bs.length) % bs.length]; nb.click(); nb.focus(); void keyName;
  });
}
const slider = (id: string, fn: (v: number) => void) => $(id).addEventListener('input', e => fn(+(e.target as HTMLInputElement).value));
slider('sThroat', v => { S.throat = v / 100; resim(false); });
slider('sTemp', v => { S.tempC = v; resim(false); });
slider('sAlt', v => { S.alt = v; resim(false); });
const toggle = (id: string, k: 'cut' | 'labels' | 'real', fn?: () => void) => $(id).addEventListener('click', () => { S[k] = !S[k]; $(id).setAttribute('aria-pressed', String(S[k])); fn?.(); });
toggle('bCut', 'cut', () => { buildHardware(); if (volume) volume.uniforms.uCut.value = S.cut ? 1 : 0; });
toggle('bLab', 'labels', () => { $('labels').hidden = !S.labels; });
toggle('bSpeed', 'real');

function togglePlay() {
  if (!sim) return;
  if (play.playing) play.playing = false;
  else { if (play.t >= sim.tEnd) play.t = 0; play.playing = true; if (play.t === 0) { play.started = true; caption('Ignition', 'The igniter floods the port with hot gas and the whole exposed surface lights at once'); } }
}
$('bPlay').addEventListener('click', togglePlay);
$('bRun').addEventListener('click', togglePlay);
const scrub = $('scrub') as HTMLInputElement;
scrub.addEventListener('input', () => { if (!sim) return; play.playing = false; play.started = true; play.t = (+scrub.value / 1000) * sim.tEnd; });
window.addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (t.closest?.('input, select, button, [role=radio]')) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  if (e.key === 'ArrowRight') goStep(step + 1);
  if (e.key === 'ArrowLeft') goStep(step - 1);
});

let capTimer = 0;
function caption(title: string, sub?: string) { $('cap').innerHTML = title + (sub ? `<small>${sub}</small>` : ''); $('cap').classList.add('on'); capTimer = 3; }

function refreshStatic() {
  if (!sim || !geom || !res) return;
  $('oThroat').textContent = `${f1(geom.rt * S.throat * 2000)} mm`;
  $('oTemp').textContent = `${S.tempC} °C`;
  $('oAlt').textContent = `${f1(S.alt)} km`;
  const pa = ambient(S.alt);
  $('altHint').textContent = pa < 50 ? 'Effectively vacuum: the plume balloons out' : `Ambient pressure ${f1(pa / 1000)} kPa`;
  const s = sim;
  $('rIt').innerHTML = `${f0(s.It / 1000)}<small>kN·s</small>`;
  $('rIt2').textContent = `${s.cls}-class motor · ${f1(s.mprop)} kg propellant`;
  $('rTb').innerHTML = `${f1(s.tb)}<small>s</small>`;
  $('rTb2').textContent = `web ${f0(res.wmax * 1000)} mm`;
  $('rIsp').innerHTML = `${f0(s.isp)}<small>s</small>`;
  $('rIsp2').textContent = `expansion ratio ${f1(s.eps)}`;
  const over = s.pcMax > geom.meop;
  $('rPmax').innerHTML = `<span class="${over ? 'warn' : ''}">${f1(s.pcMax / 1e5)}</span><small>bar</small>`;
  $('rPmax2').innerHTML = over ? `<span class="warn">Over the ${f0(geom.meop / 1e5)} bar case limit: the case would burst</span>` : `case limit ${f0(geom.meop / 1e5)} bar`;
  $('shapeTag').textContent = `${s.shape} thrust curve`;
  if (s.chuffed) caption('Chuffing', 'Kn is too low to sustain pressure, so the motor sputters instead of burning steadily. Shrink the throat.');
  renderTour(); drawTime(); drawAb();
}

function badge(text: string, color: string) { const b = $('badge'); b.textContent = text; b.style.color = color; }
function updateLive() {
  if (!sim || !res || !geom) return;
  const t = play.t, s = sim, burning = play.started && t > 0 && t < s.tb;
  const pc = play.started ? at(s, s.pc, t) : ambient(S.alt), F = play.started ? at(s, s.F, t) : 0, kn = burning ? at(s, s.kn, t) : 0;
  const r = burning ? at(s, s.r, t) : 0, w = play.started ? at(s, s.w, t) : 0, md = play.started ? at(s, s.mdot, t) : 0;
  $('rF').innerHTML = `${f1(F / 1000)}<small>kN</small>`; $('rF2').textContent = `${f0(F / G0kg)} kgf`;
  $('rPc').innerHTML = `${f1(pc / 1e5)}<small>bar</small>`; $('rPc2').textContent = `${f0((pc / geom.meop) * 100)} % of case limit`;
  $('rKn').innerHTML = kn ? f0(kn) : '—'; $('rKn2').textContent = kn ? `Ab ${f2(kn * s.At)} m² · At ${f0(s.At * 1e6)} mm²` : `At ${f0(s.At * 1e6)} mm²`;
  $('rR').innerHTML = r ? `${f1(r * 1000)}<small>mm/s</small>` : '—'; $('rR2').textContent = `r = a·Pcⁿ, n = ${P.n}`;
  $('rMd').innerHTML = `${f1(md)}<small>kg/s</small>`; $('rMd2').textContent = `${f1(Math.max(0, s.mprop * (1 - w / res.wmax)))} kg left`;
  $('rW').innerHTML = `${f0(Math.min(100, (w / res.wmax) * 100))}<small>%</small>`; $('rW2').textContent = `${f1(w * 1000)} of ${f0(res.wmax * 1000)} mm`;
  const phase = !play.started || t === 0 ? 'Ready' : t < s.tb ? (play.playing ? 'Burning' : 'Paused') : t < s.tEnd ? 'Tail-off' : 'Burnout';
  $('state').textContent = phase; $('state').classList.toggle('live', phase === 'Burning');
  $('bRun').textContent = $('bPlay').textContent = play.playing ? 'Pause' : t >= s.tEnd ? 'Re-ignite' : play.started && t > 0 ? 'Resume' : 'Ignite';
  $('tLabel').textContent = `T+${f1(t)} s / ${f1(s.tEnd)} s`;
  scrub.value = String(Math.round((t / s.tEnd) * 1000));
  if (!burning) badge(phase, 'var(--dim)');
  else {
    const n = thrustCoef(pc, ambient(S.alt), s.eps, P.g);
    badge(n.sep ? 'Flow separation' : pc > geom.meop ? 'Over case limit' : 'Burning', n.sep || pc > geom.meop ? 'var(--bad)' : 'var(--amber)');
  }
  return { pc, F, w, B: s.pcMax > 0 ? clamp((pc - ambient(S.alt)) / (s.pcMax - ambient(S.alt)), 0, 1) : 0 };
}
const G0kg = 9.80665;

function renderCadBox() {
  const ok = cad && !cadError;
  $('cadBox').innerHTML = (ok
    ? `<b>Loaded</b> <code>public/models/srm.glb</code>, ${cad!.parts.length} meshes, at ${cadStamp}.<br>Throat ${f1(cad!.geom.rt * 2000)} mm, exit ${f1(cad!.geom.re * 2000)} mm, grain ${f0((cad!.bounds[4] - cad!.bounds[1]) * 1000)} mm long.<br>`
    : cadError ? `<span class="warn">${cadError}</span><br>` : '')
    + `Edit <code>cad/srm.py</code> (build123d) and run <code>npm run cad:watch</code>. Every save re-exports the GLB and this page reloads it in place. Or drop in your own GLB with parts named <code>grain…</code> and <code>nozzle…</code> (plus optional <code>case…</code>, <code>insulation…</code>, <code>igniter…</code>). Units and axis are detected automatically.`;
}

// =====================================================================
// Charts
// =====================================================================
const CSS = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const COL = { ink: CSS('--ink'), dim: CSS('--dim'), amber: CSS('--amber'), cyan: CSS('--cyan'), violet: CSS('--violet'), bad: CSS('--bad'), line: 'rgba(234,240,247,.12)' };
function fit(cv: HTMLCanvasElement): [CanvasRenderingContext2D, number, number] | null {
  const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1;
  if (!r.width) return null;
  cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
  const c = cv.getContext('2d')!; c.setTransform(d, 0, 0, d, 0, 0); c.font = '10px ' + CSS('--mono'); c.textBaseline = 'middle';
  return [c, r.width, r.height];
}
const cvT = $('cvT') as HTMLCanvasElement, cvA = $('cvA') as HTMLCanvasElement;
function drawTime() {
  const F = fit(cvT); if (!F || !sim || !geom) return;
  const [c, W, H] = F, l = 40, r = 40, t = 10, b = 20, pw = W - l - r, ph = H - t - b, s = sim;
  const fMax = Math.max(...s.F) * 1.1 || 1, pMax = Math.max(s.pcMax, geom.meop) * 1.1;
  const X = (x: number) => l + (pw * x) / s.tEnd, Yf = (v: number) => t + ph * (1 - v / fMax), Yp = (v: number) => t + ph * (1 - v / pMax);
  c.strokeStyle = COL.line; c.fillStyle = COL.dim; c.lineWidth = 1;
  for (const v of [0, 0.5, 1]) {
    c.beginPath(); c.moveTo(l, t + ph * (1 - v)); c.lineTo(l + pw, t + ph * (1 - v)); c.stroke();
    c.textAlign = 'right'; c.fillText(`${f0((v * fMax) / 1000)} kN`, l - 4, t + ph * (1 - v));
    c.textAlign = 'left'; c.fillText(`${f0((v * pMax) / 1e5)} bar`, l + pw + 4, t + ph * (1 - v));
  }
  c.textAlign = 'center'; c.fillText('0 s', l + 6, H - 7); c.fillText(`${f1(s.tEnd)} s`, l + pw - 14, H - 7);
  c.setLineDash([4, 3]); c.strokeStyle = COL.bad; c.beginPath(); c.moveTo(l, Yp(geom.meop)); c.lineTo(l + pw, Yp(geom.meop)); c.stroke(); c.setLineDash([]);
  const line = (ch: Float32Array, Y: (v: number) => number, col: string) => { c.strokeStyle = col; c.lineWidth = 1.8; c.beginPath(); s.t.forEach((x, i) => c.lineTo(X(x), Y(ch[i]))); c.stroke(); };
  line(s.pc, Yp, COL.cyan); line(s.F, Yf, COL.amber);
  c.strokeStyle = COL.ink; c.lineWidth = 1; c.beginPath(); c.moveTo(X(play.t), t); c.lineTo(X(play.t), t + ph); c.stroke();
  c.fillStyle = COL.amber; c.beginPath(); c.arc(X(play.t), Yf(play.started ? at(s, s.F, play.t) : 0), 3.5, 0, TAU); c.fill();
}
function drawAb() {
  const F = fit(cvA); if (!F || !res || !sim) return;
  const [c, W, H] = F, l = 40, r = 12, t = 10, b = 20, pw = W - l - r, ph = H - t - b, ab = res.ab, n = ab.length;
  const aMax = Math.max(...ab) * 1.15 || 1, X = (i: number) => l + (pw * i) / (n - 1), Y = (v: number) => t + ph * (1 - v / aMax);
  c.strokeStyle = COL.line; c.fillStyle = COL.dim; c.lineWidth = 1;
  for (const v of [0, 0.5, 1]) { c.beginPath(); c.moveTo(l, Y(v * aMax)); c.lineTo(l + pw, Y(v * aMax)); c.stroke(); c.textAlign = 'right'; c.fillText(`${f2(v * aMax)} m²`, l - 4, Y(v * aMax)); }
  c.textAlign = 'left'; c.fillText('0 % web', l, H - 7); c.textAlign = 'right'; c.fillText('100 %', l + pw, H - 7);
  c.fillStyle = 'rgba(197,140,255,.12)'; c.beginPath(); c.moveTo(X(0), Y(0)); for (let i = 0; i < n; i++) c.lineTo(X(i), Y(ab[i])); c.lineTo(X(n - 1), Y(0)); c.fill();
  c.strokeStyle = COL.violet; c.lineWidth = 1.8; c.beginPath(); for (let i = 0; i < n; i++) c.lineTo(X(i), Y(ab[i])); c.stroke();
  const w = play.started ? at(sim, sim.w, play.t) : 0, x = X(clamp(w / res.wmax, 0, 1) * (n - 1));
  c.strokeStyle = COL.ink; c.beginPath(); c.moveTo(x, t); c.lineTo(x, t + ph); c.stroke();
}
cvT.addEventListener('pointerdown', e => {
  if (!sim) return;
  const seek = (ev: PointerEvent) => { const r = cvT.getBoundingClientRect(); play.t = clamp(((ev.clientX - r.left - 40) / (r.width - 80)) * sim!.tEnd, 0, sim!.tEnd); play.started = true; play.playing = false; };
  seek(e); cvT.setPointerCapture(e.pointerId);
  const mv = (ev: PointerEvent) => seek(ev), up = () => { cvT.removeEventListener('pointermove', mv); cvT.removeEventListener('pointerup', up); };
  cvT.addEventListener('pointermove', mv); cvT.addEventListener('pointerup', up);
});

// =====================================================================
// Tour + hotspots
// =====================================================================
type Cam = { t: number[]; d: number; dir: number[] };
const g = () => geom!, R0 = () => (res ? res : null);
const overview = (): Cam => ({ t: [0, (MOTOR.caseY1 + (geom?.ye ?? -0.3)) / 2 - 0.05, 0], d: 4.3, dir: [1, 0.22, 0.3] });
const STEPS: { hot: string | null; title: string; cam: () => Cam; body: () => string; try: string }[] = [
  { hot: null, title: 'How a solid rocket motor works', cam: overview,
    body: () => `A solid motor is the simplest rocket there is. Fuel and oxidiser are mixed into one rubbery solid, the <b>grain</b>, cast inside a steel or composite tube. There are no pumps and no valves. Once it is lit, the shape of the grain alone decides how hard it pushes and for how long.`,
    try: 'Press Ignite, or scrub the timeline, to watch the grain burn back.' },
  { hot: 'grain', title: 'Propellant grain', cam: () => ({ t: [0, MOTOR.y0 + MOTOR.L * 0.75, -0.05], d: 1.4, dir: [1, 0.2, 0.25] }),
    body: () => `This grain holds <b>${f1(sim?.mprop ?? 0)} kg of ${P.name}</b>. Every gram contains its own oxidiser, so it will burn anywhere, including in vacuum and underwater. It burns only on surfaces exposed to the hot gas in the channel down the middle, the <b>port</b>.`,
    try: 'Switch between propellants and watch the flame colour and the impulse change.' },
  { hot: 'case', title: 'Case & insulation', cam: () => ({ t: [0, MOTOR.y0 + MOTOR.L * 0.5, -g().caseR], d: 1.1, dir: [1, 0.15, -0.2] }),
    body: () => `The motor case is the combustion chamber, a pressure vessel rated to <b>${f0(g().meop / 1e5)} bar</b>. A rubber liner (dark band) bonds the grain to the case and shields the metal from the ${f0(P.Tc)} K gas. Outside surfaces bonded to the case cannot burn, so the flame can only eat outwards from the port.`,
    try: 'Shrink the throat until the peak pressure passes the case limit.' },
  { hot: 'igniter', title: 'Igniter', cam: () => ({ t: [0, MOTOR.caseY1 - 0.1, 0], d: 0.9, dir: [1, -0.3, 0.2] }),
    body: () => `A small pyrotechnic charge at the forward end fires hot gas and particles down the port. That lights the whole exposed surface in a few hundredths of a second. From then on it cannot be switched off. A solid motor burns until the propellant runs out.`,
    try: 'Ignite and watch the first frames.' },
  { hot: 'port', title: 'Port & flame front', cam: () => ({ t: [0, MOTOR.y0 + MOTOR.L * 0.45, 0], d: 1.2, dir: [1, 0.1, 0.3] }),
    body: () => `Propellant burns <b>perpendicular to its surface</b> at the same speed everywhere, so the burning surface moves like a wave, and corners round off as it goes. The glowing layer is the flame front, and the faint lines on the cut face show where it will be later. The burned space becomes more chamber, full of gas at ${f0((sim?.pcMax ?? 0) / 1e5)} bar at peak.`,
    try: 'Scrub the timeline slowly and follow one contour line.' },
  { hot: 'shape', title: 'Grain shape → thrust curve', cam: () => ({ t: [0, MOTOR.y0 + MOTOR.L * 0.3, 0.08], d: 1.3, dir: [1, 0.35, 0.15] }),
    body: () => `Thrust follows the <b>burning area</b>. More area makes more gas, and that raises the pressure. This ${S.grain === 'cad' ? 'CAD' : S.grain} grain has a <b>${sim?.shape}</b> curve: a growing area gives a progressive curve, a constant one is neutral, and a shrinking one is regressive. Designers shape the port to get the thrust profile the mission needs.`,
    try: 'Compare BATES, Star, Finocyl and End in the “Burning area vs web” chart.' },
  { hot: 'rate', title: 'Burn-rate law', cam: () => ({ t: [0, (R0()?.yMin ?? 0.3) + 0.1, 0.1], d: 1.2, dir: [1, 0.2, 0.3] }),
    body: () => `Propellant burns faster at higher pressure: <b>r = a·Pcⁿ</b>, with n = ${P.n} for ${P.name}. Balancing gas made against gas escaping gives <b>Pc = (a·ρ·c*·Kn)^(1/(1−n))</b>. Because n &lt; 1, a pressure spike slows itself down, so the motor is stable. The exponent 1/(1−n) ≈ ${f2(1 / (1 - P.n))} also amplifies small changes: a warm grain or a slightly small throat raises the pressure a lot.`,
    try: 'Set the grain temperature to −40 °C, then +60 °C, and compare burn time and peak pressure.' },
  { hot: 'throat', title: 'Nozzle & throat', cam: () => ({ t: [0, 0.02, 0], d: 0.9, dir: [1, 0.05, 0.3] }),
    body: () => `The same gas dynamics as a liquid engine. Flow chokes at Mach 1 in the throat (${f1(g().rt * S.throat * 2000)} mm across), then expands supersonically in the bell. Solid-motor throats are usually graphite or carbon-carbon, because the hot, particle-laden exhaust <b>erodes</b> them, which slowly lowers Kn during the burn. That erosion is not modelled here.`,
    try: 'Open the Liquid engine lab from the switcher to compare the two nozzles.' },
  { hot: 'plume', title: 'Plume & smoke', cam: () => ({ t: [0, (geom?.ye ?? -0.3) - 1.1, 0], d: 3.6, dir: [1, 0.05, 0.35] }),
    body: () => `${P.name === 'KNSB' ? 'Potassium salts' : 'Aluminium oxide droplets'} make the flame bright and leave the thick white trail typical of solid boosters. The plume shape still depends on exit pressure versus air pressure, exactly as in the liquid engine.`,
    try: 'Drag altitude up during a burn.' },
  { hot: null, title: 'Burnout & tail-off', cam: overview,
    body: () => `When the flame reaches the case liner, the burning area collapses and the pressure blows down through the throat in a fraction of a second. This motor delivered <b>${f0((sim?.It ?? 0) / 1000)} kN·s</b> of total impulse, which makes it a <b>${sim?.cls}-class</b> motor. Each letter doubles the impulse, starting from A = 2.5 N·s.`,
    try: 'Load your own geometry: edit cad/srm.py or export a GLB, then pick CAD.' },
];
const HOT: Record<string, [string, () => number[]]> = {
  grain: ['Propellant grain', () => [0, MOTOR.y0 + MOTOR.L * 0.8, -0.1]],
  case: ['Case & liner', () => [0, MOTOR.y0 + MOTOR.L * 0.55, -(geom?.caseR ?? 0.15) - 0.004]],
  igniter: ['Igniter', () => [0, (geom?.caseY1 ?? 1.5) - 0.07, 0]],
  port: ['Port', () => [0, MOTOR.y0 + MOTOR.L * 0.45, 0]],
  shape: ['Grain shape', () => [0, MOTOR.y0 + MOTOR.L * 0.25, 0.1]],
  rate: ['Burn rate', () => [0, (res?.yMin ?? 0.3) + 0.08, 0.1]],
  throat: ['Throat', () => [0, 0, 0.05]],
  plume: ['Exhaust plume', () => [0, (geom?.ye ?? -0.3) - 0.9, 0]],
};
const hotEls: Record<string, HTMLButtonElement> = {};
STEPS.forEach((s, i) => {
  const d = document.createElement('button'); d.type = 'button'; d.setAttribute('aria-label', `Stop ${i}: ${s.title}`);
  d.addEventListener('click', () => goStep(i)); $('tDots').appendChild(d);
  if (!s.hot) return;
  const b = document.createElement('button'); b.className = 'hot'; b.type = 'button';
  b.innerHTML = `<i>${i}</i><span>${HOT[s.hot][0]}</span>`; b.setAttribute('aria-label', `Stop ${i}: ${HOT[s.hot][0]}`);
  b.addEventListener('click', () => goStep(i)); $('labels').appendChild(b); hotEls[s.hot] = b;
});
let step = 0, tw: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; k: number } | null = null;
function renderTour() {
  const s = STEPS[step];
  $('tStep').textContent = step ? `Stop ${step} of ${STEPS.length - 1}` : 'Guided tour';
  $('tTitle').textContent = s.title;
  $('tBody').innerHTML = geom ? s.body() : '';
  $('tTry').textContent = s.try;
  ($('tPrev') as HTMLButtonElement).disabled = step === 0;
  $('tNext').textContent = step === 0 ? 'Start tour ›' : step === STEPS.length - 1 ? 'Overview ›' : 'Next ›';
  [...$('tDots').children].forEach((d, i) => d.classList.toggle('on', i === step));
  for (const k in hotEls) hotEls[k].classList.toggle('on', k === s.hot);
}
function goStep(i: number, instant = false) {
  step = (i + STEPS.length) % STEPS.length; renderTour();
  const c = STEPS[step].cam(), target = new V3(...c.t), pos = target.clone().add(new V3(...c.dir).normalize().multiplyScalar(c.d));
  if (instant || reduceMotion) { camera.position.copy(pos); controls.target.copy(target); tw = null; }
  else tw = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, k: 0 };
}
controls.addEventListener('start', () => { tw = null; });
$('tPrev').addEventListener('click', () => goStep(step - 1));
$('tNext').addEventListener('click', () => goStep(step + 1));
$('tMin').addEventListener('click', () => {
  const min = $('tour').classList.toggle('min');
  $('tMin').textContent = min ? '+' : '–'; $('tMin').setAttribute('aria-expanded', String(!min));
});

// =====================================================================
// CAD hot reload: vite's model-watch plugin pings us when public/models changes
// =====================================================================
if (import.meta.hot) {
  import.meta.hot.on('model-changed', (d: { file: string }) => {
    if (!d.file.startsWith('srm')) return;
    if (S.grain === 'cad') { caption('CAD model updated', d.file); rebuild(); }
    else { cadStamp = ''; renderCadBox(); }
  });
}

// =====================================================================
// Frame loop
// =====================================================================
st.onResize(() => {
  const [, h] = st.size();
  ptsU.uScale.value = (h * st.pr()) / (2 * Math.tan((camera.fov * DEG) / 2));
  drawTime(); drawAb();
});
const pv = new V3();
let last = performance.now(), time = 0, frameN = 0;
function frame(now: number) {
  const raw = (now - last) / 1000; last = now;
  update(Math.min(0.05, raw));
  st!.render(raw, time);
  requestAnimationFrame(frame);
}
function update(dt: number) {
  time += dt; frameN++;
  if (sim && play.playing) {
    const rate = S.real ? 1 : Math.max(sim.tEnd / 14, 0.25);
    play.t = Math.min(sim.tEnd, play.t + dt * rate);
    if (play.t >= sim.tEnd) { play.playing = false; caption('Burnout', `${f0(sim.It / 1000)} kN·s total impulse in ${f1(sim.tb)} s`); }
  }
  const live = updateLive();
  if (live && sim && geom && res) {
    const { pc, w, B } = live, pa = ambient(S.alt);
    volume?.setWeb(w);
    const flash = play.started ? clamp(1 - play.t / 0.25, 0, 1) * (play.t > 0 ? 1 : 0) : 0;
    if (volume) { volume.uniforms.uFront.value = B * 0.3 + flash * 0.5; volume.uniforms.uGlow.value = B * 0.35; volume.uniforms.uTime.value = time; volume.uniforms.uFlame.value.set(P.flame[0] * 0.9, P.flame[1] * 0.45, P.flame[2] * 0.2); }
    const n = thrustCoef(Math.max(pc, pa * 1.01), pa, sim.eps, P.g);
    let yJet = geom.ye;
    if (n.sep) { const i = flow.r.findIndex((r, k) => flow.y[k] < 0 && (r / (geom!.rt * S.throat)) ** 2 >= n.epsEff); if (i >= 0) yJet = flow.y[i]; }
    plume.set({ pe: n.pe, pa, re: geom.rt * S.throat * Math.sqrt(n.epsEff), Me: n.Me, len: (0.6 + 14 * geom.re) * (0.4 + 0.6 * B), sep: n.sep, look: P });
    plume.mesh.position.y = yJet; plume.mesh.visible = B > 0.005;
    plume.uniforms.uGain.value = B * 0.3; plume.uniforms.uTime.value = time; plume.uniforms.uFlash.value = flash * 0.5;
    updateParticles(dt, B, w); updateSmoke(dt, B);
    const hot = Math.max(B, 0);
    MAT.nozzle.emissiveIntensity = 0.12 * hot; MAT.ign.emissiveIntensity = flash * 3;
    cad?.parts.forEach(p => { if (p.mesh.userData.hot) (p.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.12 * hot; });
    portLight.position.set(0.05, (res.yMin + res.yMax) / 2, 0); portLight.intensity = (B + flash * 2) * 1.2;
    exitLight.position.set(0.1, geom.ye - 0.3, 0.2); exitLight.intensity = B * 0.9;
    if (frameN % 6 === 0) { drawTime(); drawAb(); }
  }
  if (tw) {
    tw.k = Math.min(1, tw.k + dt / 1.4);
    const e = tw.k < 0.5 ? 4 * tw.k ** 3 : 1 - Math.pow(-2 * tw.k + 2, 3) / 2;
    camera.position.lerpVectors(tw.p0, tw.p1, e); controls.target.lerpVectors(tw.t0, tw.t1, e);
    if (tw.k >= 1) tw = null;
  }
  controls.update();
  if (S.labels && geom) {
    const [w, h] = st!.size();
    for (const k in hotEls) {
      pv.set(...(HOT[k][1]() as [number, number, number])).project(camera);
      const el = hotEls[k], vis = pv.z < 1 && Math.abs(pv.x) < 1.05 && Math.abs(pv.y) < 1.05;
      el.style.visibility = vis ? 'visible' : 'hidden';
      if (vis) el.style.transform = `translate(${((pv.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-pv.y * 0.5 + 0.5) * h).toFixed(1)}px) translateY(-50%)`;
    }
  }
  if (capTimer > 0 && (capTimer -= dt) <= 0) $('cap').classList.remove('on');
}

// Film mode (srm.html?film): no rAF loop; the HyperFrames composition in video/ drives time through window.__film.
// Frames are rendered in order, so seeking forward steps the particle sim at 60 Hz; a backward seek replays from 0.
function film() {
  document.documentElement.classList.add('film');
  controls.autoRotate = true; controls.autoRotateSpeed = 0.6; // advances per update() call, so 60 Hz steps keep it deterministic
  const shot = () => { // overview, pulled back and down so the plume stays in frame
    goStep(0, true); controls.target.y -= 0.7;
    camera.position.sub(controls.target).multiplyScalar(1.35).add(controls.target);
  };
  shot();
  let ft = 0;
  const ready = new Promise<void>(ok => { const wait = () => (sim ? ok() : setTimeout(wait, 50)); wait(); });
  (window as any).__film = {
    ready,
    seek(t: number) {
      if (t < ft) { ft = 0; time = 0; play.t = 0; play.playing = play.started = false; shot(); }
      while (ft < t - 1e-6) {
        if (!play.started && ft >= 1) togglePlay(); // 1 s of cold motor, then ignite
        const dt = Math.min(1 / 60, t - ft); update(dt); ft += dt;
      }
      st!.render(0, time);
    },
  };
}

// ---------- boot ----------
$('propNote').textContent = P.note;
if (matchMedia('(max-width: 900px)').matches) $('tMin').click();
renderCadBox();
goStep(0, true);
const qs = new URLSearchParams(location.search);
setGrain(qs.get('grain') as GrainKey || 'bates');
if (qs.has('film')) film(); else requestAnimationFrame(frame);
