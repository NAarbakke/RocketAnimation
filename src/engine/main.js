// Liquid-engine lab. Migrated as-is from the single-file page; new code lives in TypeScript (see src/srm).
import * as T from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
const THREE = { ...T, OrbitControls, RoomEnvironment, EffectComposer, RenderPass, ShaderPass, UnrealBloomPass };

(() => {
const $ = id => document.getElementById(id);
const DEG = Math.PI / 180, TAU = Math.PI * 2;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lin = hex => new THREE.Color(hex).convertSRGBToLinear();
const V3 = THREE.Vector3, V2 = THREE.Vector2;

// =====================================================================
// Physics: ideal rocket, quasi-1D isentropic nozzle flow
// =====================================================================
const G0 = 9.80665, RU = 8314.46, PC_NOM = 100e5, RT = 0.13, AT = Math.PI * RT * RT, RHO_OX = 1141;
// Tc(O/F) and M(O/F) are rough fits to equilibrium data at ~100 bar. Colours are linear HDR.
const PROPS = {
  rp1: { name: 'RP-1', of: [1.6, 3.4], ofNom: 2.36, stoich: 3.4, ofPk: 2.6, Tpk: 3700, w: 1.5, Ma: 16, Mb: 2.8, g: 1.22, rhoF: 810,
    fuel: [1.25, 0.55, 0.12], flame: [1.7, 0.62, 0.14], core: [2.4, 1.8, 0.95], disk: [2.2, 1.4, 0.7], smoke: [0.06, 0.05, 0.045, 0.8], gain: 1,
    note: 'Refined kerosene. Dense and storable at room temperature, but it burns sooty: the fuel-rich gas-generator exhaust is the dark smoke trail. Merlin (Falcon 9) and the F-1 (Saturn V) burn it.' },
  ch4: { name: 'CH₄', of: [2.4, 4.2], ofNom: 3.6, stoich: 4.0, ofPk: 3.5, Tpk: 3650, w: 1.6, Ma: 10, Mb: 3.0, g: 1.2, rhoF: 423,
    fuel: [0.3, 1.1, 0.55], flame: [0.45, 0.42, 1.6], core: [1.3, 1.25, 2.4], disk: [1.8, 1.2, 2.2], smoke: [0.55, 0.57, 0.6, 0.22], gain: 0.75,
    note: 'Liquid methane at −162 °C. It burns cleanly with no soot or coking and gives more Isp than kerosene, which suits reusable engines such as Raptor and BE-4. The flame burns blue.' },
  lh2: { name: 'LH₂', of: [4, 8], ofNom: 6, stoich: 7.94, ofPk: 6.8, Tpk: 3700, w: 4, Ma: 3.2, Mb: 1.7, g: 1.2, rhoF: 71,
    fuel: [0.85, 0.5, 1.4], flame: [0.28, 0.3, 0.95], core: [0.8, 0.8, 1.7], disk: [1.9, 1.1, 1.9], smoke: [0.85, 0.87, 0.9, 0.1], gain: 0.28,
    note: 'Liquid hydrogen at −253 °C. Its exhaust is the lightest of the three, so it has the highest Isp, but it is 11× less dense than kerosene and needs huge tanks. The flame is almost invisible, so look for the shock diamonds. Used by RS-25, RL10 and Vulcain.' },
};
const OX_COL = [0.25, 0.62, 1.35], HOT_COL = [1.9, 0.55, 0.12], EXH_COL = [0.9, 0.3, 0.07];

function gas(p, of) {
  const Tc = 600 + (p.Tpk - 600) * Math.exp(-(((of - p.ofPk) / p.w) ** 2));
  const M = p.Ma + p.Mb * of;
  return { Tc, M, R: RU / M, g: p.g };
}
function areaRatio(M, g) { return Math.pow((2 / (g + 1)) * (1 + (g - 1) / 2 * M * M), (g + 1) / (2 * (g - 1))) / M; }
function machFromArea(ar, g, sup) {
  if (ar <= 1) return 1;
  let lo = sup ? 1 : 1e-4, hi = sup ? 30 : 1;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2, big = areaRatio(m, g) > ar;
    if (sup ? big : !big) hi = m; else lo = m;
  }
  return (lo + hi) / 2;
}
const pRatio = (M, g) => Math.pow(1 + (g - 1) / 2 * M * M, -g / (g - 1));
const machFromP = (pr, g) => Math.sqrt(2 / (g - 1) * (Math.pow(pr, -(g - 1) / g) - 1));
const ambient = km => 101325 * Math.exp(-km / 7.2); // single scale height, fine to ~±30 % up to 100 km

function solve(p, of, thr, eps, km, run = 1) {
  const { Tc, R, g, M } = gas(p, of);
  const Pc = PC_NOM * thr * run, pa = ambient(km);
  const cstar = Math.sqrt(R * Tc) / (g * Math.sqrt(Math.pow(2 / (g + 1), (g + 1) / (g - 1))));
  const base = { Tc, R, g, M, Pc, pa, cstar, eps, epsEff: eps };
  if (Pc < 0.5 * pa + 2e4) return Object.assign(base, { off: true, Me: 0, pe: 0, ve: 0, Te: 0, mdot: 0, F: 0, Fmom: 0, Fpres: 0, Isp: 0, CF: 0, Ae: AT * eps, sep: false });
  let Me = machFromArea(eps, g, true), pe = Pc * pRatio(Me, g), epsEff = eps, sep = false;
  if (pe < 0.35 * pa) { // Summerfield: the jet detaches from the wall where p ≈ 0.35 pa
    sep = true; Me = machFromP(0.35 * pa / Pc, g); epsEff = areaRatio(Me, g); pe = 0.35 * pa;
  }
  const ve = Math.sqrt(2 * g / (g - 1) * R * Tc * (1 - Math.pow(pe / Pc, (g - 1) / g)));
  const mdot = Pc * AT / cstar, Ae = AT * eps;
  const Fmom = mdot * ve, Fpres = (pe - pa) * AT * epsEff, F = Fmom + Fpres;
  return Object.assign(base, { off: false, Me, pe, ve, Te: Tc / (1 + (g - 1) / 2 * Me * Me), mdot, Ae, epsEff, sep, Fmom, Fpres, F, Isp: F / (mdot * G0), CF: F / (Pc * AT) });
}
function matchedEps(p, of, thr, km) {
  const { g } = gas(p, of), pa = ambient(km);
  return pa < 1 ? Infinity : areaRatio(machFromP(pa / (PC_NOM * thr), g), g);
}

// =====================================================================
// State
// =====================================================================
const S = { prop: 'rp1', thr: 1, of: 2.36, eps: 16, alt: 0, field: 'T', cut: true, labels: true, slow: false, sound: false };
let P = PROPS.rp1, E, Es; // E: live (scaled by run), Es: steady state
const seq = { phase: 'start', t: 0, run: 0, spin: 0, gg: 0, flash: 0, from: null, cap: -1 };

// =====================================================================
// Renderer, scene, post
// =====================================================================
const canvas = $('c'), stage = $('stage');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (e) { $('err').hidden = false; return; }
// render scale: starts at up to 1.25× and steps down on its own while frames run slow (see frame())
const Q = { pr: Math.min(devicePixelRatio || 1, 1.25), min: 0.5, t: 0, n: 0, warm: 1.5 };
renderer.setPixelRatio(Q.pr);
const scene = new THREE.Scene();
scene.background = lin(0x06080d);
const camera = new THREE.PerspectiveCamera(36, 1, 0.02, 200);
const controls = new THREE.OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.minDistance = 0.5; controls.maxDistance = 16; controls.zoomSpeed = 0.7;
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;

const key = new THREE.DirectionalLight(lin(0xe6eeff), 0.9); key.position.set(4, 5, 3); scene.add(key);
const rim = new THREE.DirectionalLight(lin(0x7090ff), 0.5); rim.position.set(-4, 1, -4); scene.add(rim);
const chamberLight = new THREE.PointLight(0xff7a30, 0, 2.2, 1.5); chamberLight.position.set(0, 0.3, 0); scene.add(chamberLight);
const exitLight = new THREE.PointLight(0xff8a40, 0, 4, 1.5); scene.add(exitLight);
const ggLight = new THREE.PointLight(0xff6a20, 0, 0.8, 1.5); scene.add(ggLight);

// no MSAA: on integrated GPUs resolving a multisampled float target cost ~10 ms/frame; the 1.25× render scale smooths edges instead
const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
const composer = new THREE.EffectComposer(renderer, rt);
composer.setPixelRatio(Q.pr);
composer.addPass(new THREE.RenderPass(scene, camera));
const bloom = new THREE.UnrealBloomPass(new V2(256, 256), 0.55, 0.45, 0.9);
{ const set = bloom.setSize.bind(bloom); bloom.setSize = (w, h) => set(Math.ceil(w / 2), Math.ceil(h / 2)); } // half-res glow
composer.addPass(bloom);
const grade = new THREE.ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new V2(1, 1) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; uniform vec2 uRes; varying vec2 vUv;
    vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
    void main(){
      vec2 dc = vUv - 0.5;
      vec3 col = aces(max(texture2D(tDiffuse, vUv).rgb - 0.006, 0.0)*1.1); // floor hides 8-bit bloom banding
      col = pow(col, vec3(1.0/2.2));
      col *= 1.0 - dot(dc,dc)*0.5;
      col += (fract(sin(dot(vUv*uRes + uTime*61.0, vec2(12.9898,78.233)))*43758.5453) - 0.5)*0.015;
      gl_FragColor = vec4(col, 1.0);
    }`
});
composer.addPass(grade);

const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

// =====================================================================
// Materials
// =====================================================================
const std = (hex, metal, rough, extra) => new THREE.MeshStandardMaterial(Object.assign({ color: lin(hex), metalness: metal, roughness: rough, side: THREE.DoubleSide, envMapIntensity: 0.75 }, extra));
const MAT = {
  jacket: std(0x9aa1aa, 0.85, 0.3),
  liner: std(0xc27b50, 0.9, 0.28, { emissive: lin(0xff5a1a), emissiveIntensity: 0 }),
  ext: std(0x3b3e45, 0.7, 0.42, { emissive: lin(0xff6a1a), emissiveIntensity: 0 }),
  cut: std(0xc9412a, 0.1, 0.6, { emissive: lin(0x3a0a03) }),
  steel: std(0xb0b8c2, 0.9, 0.28),
  rotor: std(0xdfe3e8, 0.95, 0.2),
  pipe: std(0x9aa2ac, 0.85, 0.34),
  housing: std(0x80888f, 0.85, 0.36),
  dark: std(0x34302c, 0.6, 0.6),
  inj: std(0xd0d6de, 0.9, 0.25, { emissive: lin(0x9fd8ff), emissiveIntensity: 0 }),
};
const XRAY = [MAT.pipe, MAT.housing, MAT.dark];
function setXray(on) {
  for (const m of XRAY) { m.transparent = on; m.opacity = on ? 0.16 : 1; m.depthWrite = !on; m.needsUpdate = true; }
}

// =====================================================================
// Engine geometry (metres; engine axis = +y, throat at y = 0)
// =====================================================================
const YI = 0.62, YC = 0.30, RC = 0.22, W_REGEN = 0.034, W_EXT = 0.012;
const XT = -0.05, ZT = -0.74, GY = 0.6, GZ = ZT - 0.36, YX = -0.85; // turbopump axis, gas generator, turbine exhaust outlet
const G = {};
function setGeom(eps) {
  const re = RT * Math.sqrt(eps), L = 0.8 * (re - RT) / Math.tan(15 * DEG); // 80 % bell
  Object.assign(G, { eps, re, L, ye: -L, yR: Math.max(-L, -0.5) });
}
function rIn(y) {
  if (y >= YC) return RC;
  if (y >= 0) return RT + (RC - RT) * (1 - Math.cos(Math.PI * y / YC)) / 2;
  const a = 0.05, s = Math.min(1, -y / G.L), se = (s < a ? s * s / (2 * a) : s - a / 2) / (1 - a / 2);
  return RT + (G.re - RT) * (0.85 * (1 - Math.pow(1 - se, 1.8)) + 0.15 * se);
}
const wallT = y => (y >= G.yR - 1e-6 ? W_REGEN : W_EXT);
const rOut = y => rIn(y) + wallT(y);

// ---------- 1-D flow along the axis ----------
const NPROF = 240;
const prof = { y: new Float32Array(NPROF), r: new Float32Array(NPROF), M: new Float32Array(NPROF), T: new Float32Array(NPROF), p: new Float32Array(NPROF),
  v: new Float32Array(NPROF), vis: new Float32Array(NPROF), s: new Float32Array(NPROF), col: new Float32Array(NPROF * 3), Mmax: 3 };
// where the jet leaves the wall (the exit, unless the flow has separated)
function sepIndex() { for (let i = 0; i < NPROF; i++) if (prof.y[i] < 0 && (prof.r[i] / RT) ** 2 >= Es.epsEff - 1e-6) return i; return NPROF - 1; }
const pIdx = y => clamp(Math.round((YI - y) / (YI - G.ye) * (NPROF - 1)), 0, NPROF - 1);
function buildProfile() {
  const { R, g, Tc } = gas(P, S.of);
  for (let i = 0; i < NPROF; i++) {
    const y = YI + (G.ye - YI) * i / (NPROF - 1), r = rIn(y);
    const M = y === 0 ? 1 : machFromArea((r / RT) ** 2, g, y < 0), T = 1 / (1 + (g - 1) / 2 * M * M);
    prof.y[i] = y; prof.r[i] = r; prof.M[i] = M; prof.T[i] = T; prof.p[i] = Math.pow(T, g / (g - 1)); prof.v[i] = M * Math.sqrt(g * R * Tc * T);
  }
  const ve = prof.v[NPROF - 1];
  for (let i = 0; i < NPROF; i++) prof.vis[i] = 0.1 + 1.9 * prof.v[i] / ve; // visual speed, m/s on screen
  prof.s[0] = 0;
  for (let i = 1; i < NPROF; i++) prof.s[i] = prof.s[i - 1] + 2 * (prof.y[i - 1] - prof.y[i]) / (prof.vis[i - 1] + prof.vis[i]); // travel time
  prof.Mmax = Math.max(2, Math.ceil(prof.M[NPROF - 1]));
}

// ---------- colour maps (sRGB stops) ----------
const CMAPS = {
  T: [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]],
  p: [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]],
  M: [[59, 76, 192], [98, 130, 234], [141, 176, 254], [184, 208, 249], [221, 221, 221], [245, 196, 173], [244, 154, 123], [222, 96, 77], [180, 4, 38]],
  v: [[13, 8, 135], [84, 2, 163], [139, 10, 165], [185, 50, 137], [219, 92, 104], [244, 136, 73], [254, 188, 43], [240, 249, 33]],
};
function cmap(stops, t) {
  t = clamp(t, 0, 1) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
  return [0, 1, 2].map(k => lerp(stops[i][k], stops[i + 1][k], f) / 255);
}
function fieldNorm(i) {
  switch (S.field) {
    case 'T': return prof.T[i];
    case 'p': return 1 + Math.log10(prof.p[i]) / 3;
    case 'M': { const M = prof.M[i]; return M < 1 ? 0.5 * M : 0.5 + 0.5 * clamp((M - 1) / (prof.Mmax - 1), 0, 1); }
    default: return prof.v[i] / prof.v[NPROF - 1];
  }
}
function paintProfile() {
  for (let i = 0; i < NPROF; i++) { const c = cmap(CMAPS[S.field], fieldNorm(i)); for (let k = 0; k < 3; k++) prof.col[i * 3 + k] = Math.pow(c[k], 2.2); }
  if (gasCore) {
    const ca = gasCore.geometry.attributes.aCol, sa = gasCore.geometry.attributes.aS;
    for (let v = 0; v < ca.count; v++) { const i = v % NPROF; ca.setXYZ(v, prof.col[i * 3], prof.col[i * 3 + 1], prof.col[i * 3 + 2]); sa.setX(v, prof.s[i]); }
    ca.needsUpdate = sa.needsUpdate = true;
  }
  const st = CMAPS[S.field];
  $('ramp').style.background = `linear-gradient(90deg, ${st.map((c, i) => `rgb(${c}) ${(i / (st.length - 1) * 100).toFixed(1)}%`).join(',')})`;
}

// =====================================================================
// Scene building
// =====================================================================
const eng = new THREE.Group(); scene.add(eng);
const rotors = [];
let gasCore = null, injPts = [], ggGlow = null, paths = {};
const m4 = new THREE.Matrix4(), dummy = new THREE.Object3D();

const phi = () => (S.cut ? [Math.PI, Math.PI] : [0, TAU]);
function sample(y0, y1, n, f) { const a = []; for (let i = 0; i <= n; i++) { const y = y0 + (y1 - y0) * i / n; a.push(new V2(f(y), y)); } return a; }
function lathe(pts, mat) { const [a, b] = phi(); const m = new THREE.Mesh(new THREE.LatheGeometry(pts, b < TAU ? 72 : 128, a, b), mat); eng.add(m); return m; }
function mesh(geo, mat, x, y, z, parent = eng) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; }
function tube(pts, r, mat) {
  const c = new THREE.CatmullRomCurve3(pts.map(p => new V3(...p)));
  eng.add(new THREE.Mesh(new THREE.TubeGeometry(c, Math.max(24, pts.length * 16), r, 12, false), mat));
  return pts;
}
function torus(R, r, y, mat) { // horizontal ring, halved to the x ≤ 0 side in cutaway
  const g = new THREE.TorusGeometry(R, r, 12, S.cut ? 64 : 128, S.cut ? Math.PI : TAU);
  g.rotateX(Math.PI / 2); if (S.cut) g.rotateY(-Math.PI / 2);
  return mesh(g, mat, 0, y, 0);
}
function pump(y, R, r, nb, parent) {
  mesh(new THREE.CylinderGeometry(R, R, 0.1, 40), MAT.housing, 0, y, 0, parent);
  const vol = new THREE.TorusGeometry(R, 0.036, 12, 48); vol.rotateX(Math.PI / 2); mesh(vol, MAT.housing, 0, y, 0, parent);
  mesh(new THREE.CylinderGeometry(0.05, 0.075, 0.08, 24, 1, true), MAT.housing, 0, y + 0.09, 0, parent);
  const rot = new THREE.Group(); rot.position.y = y; parent.add(rot); rotors.push(rot);
  mesh(new THREE.CylinderGeometry(r, r * 0.9, 0.012, 40), MAT.rotor, 0, -0.032, 0, rot);
  for (let k = 0; k < nb; k++) {
    const a = k / nb * TAU, b = mesh(new THREE.BoxGeometry(r * 0.85, 0.05, 0.006), MAT.rotor, Math.cos(a) * r * 0.5, -0.004, Math.sin(a) * r * 0.5, rot);
    b.rotation.y = -a + 0.55;
  }
}

function buildEngine() {
  eng.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  eng.clear(); rotors.length = 0;
  const cut = S.cut, [pa, pl] = phi(), hasExt = G.ye < G.yR - 1e-3;

  // thrust chamber + nozzle: regeneratively cooled section, then thin radiation-cooled extension
  lathe(sample(YI, G.yR, 90, rIn), MAT.liner);
  lathe(sample(YI, G.yR, 90, y => rIn(y) + W_REGEN), MAT.jacket);
  if (hasExt) {
    lathe(sample(G.yR, G.ye, 110, rIn), MAT.ext);
    lathe(sample(G.yR, G.ye, 110, y => rIn(y) + W_EXT), MAT.ext);
    lathe([new V2(rIn(G.yR) + W_REGEN, G.yR), new V2(rIn(G.yR) + W_EXT, G.yR)], MAT.jacket);
  }
  lathe([new V2(G.re, G.ye), new V2(G.re + wallT(G.ye), G.ye)], hasExt ? MAT.ext : MAT.jacket);

  if (cut) { // section faces, with one coolant channel slot cut lengthwise
    const outer = sample(YI, G.yR, 90, y => rIn(y) + W_REGEN);
    if (hasExt) outer.push(...sample(G.yR, G.ye, 110, y => rIn(y) + W_EXT));
    const shape = new THREE.Shape().setFromPoints([...outer, ...sample(G.ye, YI, 200, rIn)]);
    const slot = new THREE.Path().setFromPoints([...sample(G.yR + 0.02, YI - 0.012, 70, y => rIn(y) + 0.011), ...sample(YI - 0.012, G.yR + 0.02, 70, y => rIn(y) + 0.023)]);
    shape.holes.push(slot);
    const g = new THREE.ShapeGeometry(shape, 4);
    mesh(g, MAT.cut, 0, 0, 0).rotation.y = -Math.PI / 2;
    mesh(g, MAT.cut, 0, 0, 0).rotation.y = Math.PI / 2;
  }

  // injector plate + elements (only the half you can see is populated)
  mesh(new THREE.CylinderGeometry(RC + W_REGEN, RC + W_REGEN, 0.035, 96, 1, false, pa, pl), MAT.steel, 0, YI + 0.0175, 0);
  injPts = [[0, 0]];
  for (let rr = 0.034; rr < RC - 0.014; rr += 0.034) {
    const n = Math.round(TAU * rr / 0.028);
    for (let k = 0; k < n; k++) { const t = (k + 0.5) / n * TAU, x = rr * Math.sin(t), z = rr * Math.cos(t); if (x <= 0.004) injPts.push([x, z]); }
  }
  const inj = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.0065, 0.009, 0.014, 8), MAT.inj, injPts.length);
  injPts.forEach(([x, z], i) => inj.setMatrixAt(i, m4.makeTranslation(x, YI - 0.007, z)));
  eng.add(inj);

  // LOX dome, gimbal, thrust-vector actuator
  const dome = []; for (let i = 0; i <= 24; i++) { const a = i / 24 * Math.PI / 2; dome.push(new V2(0.06 + (RC + W_REGEN - 0.06) * Math.cos(a), YI + 0.035 + 0.19 * Math.sin(a))); }
  lathe(dome, MAT.steel);
  mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.07, 32), MAT.housing, 0, YI + 0.26, 0);
  mesh(new THREE.SphereGeometry(0.05, 24, 16), MAT.rotor, 0, YI + 0.33, 0);
  mesh(new THREE.BoxGeometry(0.24, 0.05, 0.24), MAT.dark, 0, YI + 0.39, 0);
  tube([[-0.11, YI + 0.39, 0.1], [-0.24, 0.66, 0.14], [-0.25, 0.34, 0.12]], 0.018, MAT.housing);

  // manifolds: fuel leaves the jacket at the top, enters it low on the nozzle
  torus(RC + W_REGEN + 0.03, 0.03, YI - 0.02, MAT.steel);
  const rM = rIn(G.yR) + W_REGEN + 0.03;
  torus(rM, 0.028, G.yR + 0.03, MAT.steel);

  // throat marker
  const tr = new THREE.TorusGeometry(RT * 0.995, 0.0035, 8, 96); tr.rotateX(Math.PI / 2);
  mesh(tr, new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.4, 2.6), transparent: true, opacity: 0.8 }), 0, 0, 0);

  // turbopump: LOX pump, fuel pump, turbine on one shaft
  const tp = new THREE.Group(); tp.position.set(XT, 0, ZT); eng.add(tp);
  mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.9, 12), MAT.rotor, 0, 0.72, 0, tp);
  pump(1.0, 0.13, 0.105, 7, tp);
  pump(0.74, 0.115, 0.09, 6, tp);
  mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.09, 48), MAT.housing, 0, 0.36, 0, tp);
  const man = new THREE.TorusGeometry(0.16, 0.042, 12, 48); man.rotateX(Math.PI / 2); mesh(man, MAT.housing, 0, 0.36, 0, tp);
  const trb = new THREE.Group(); trb.position.y = 0.36; tp.add(trb); rotors.push(trb);
  mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.03, 40), MAT.rotor, 0, 0, 0, trb);
  const bl = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.036, 0.007), MAT.rotor, 36);
  for (let k = 0; k < 36; k++) {
    const a = k / 36 * TAU; dummy.position.set(Math.cos(a) * 0.12, 0, Math.sin(a) * 0.12); dummy.rotation.set(0.5, -a, 0, 'YXZ'); dummy.updateMatrix(); bl.setMatrixAt(k, dummy.matrix);
  }
  trb.add(bl);

  // gas generator
  mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.13, 24), MAT.housing, XT, GY, GZ);
  mesh(new THREE.SphereGeometry(0.05, 24, 12, 0, TAU, 0, Math.PI / 2), MAT.housing, XT, GY + 0.065, GZ);
  mesh(new THREE.CylinderGeometry(0.022, 0.05, 0.05, 24), MAT.housing, XT, GY - 0.09, GZ);
  ggGlow = mesh(new THREE.SphereGeometry(0.034, 16, 12), new THREE.MeshBasicMaterial({ color: 0x000000 }), XT, GY, GZ);
  ggLight.position.set(XT + 0.1, GY, GZ);

  // plumbing (and the paths the particles follow)
  const zD = -Math.max(0.74, rOut(YX) + 0.14);
  paths = {
    loxFeed: tube([[XT, 2.8, ZT], [XT, 1.7, ZT], [XT, 1.14, ZT]], 0.05, MAT.pipe),
    fuelFeed: tube([[XT + 0.42, 2.8, ZT], [XT + 0.42, 1.3, ZT], [XT + 0.3, 0.8, ZT], [XT + 0.12, 0.74, ZT]], 0.042, MAT.pipe),
    loxMain: tube([[XT, 1.0, ZT + 0.15], [XT + 0.01, 1.02, ZT + 0.34], [-0.02, 0.9, -0.3], [0, 0.78, -0.225]], 0.036, MAT.pipe),
    fuelMain: tube([[XT, 0.74, ZT + 0.14], [XT, 0.5, ZT + 0.16], [-0.02, G.yR + 0.28, -(rM + 0.1)], [0, G.yR + 0.06, -(rM + 0.02)]], 0.032, MAT.pipe),
    ggOx: tube([[XT, 0.99, ZT - 0.16], [XT - 0.03, 0.88, ZT - 0.3], [XT - 0.012, 0.72, GZ]], 0.013, MAT.pipe),
    ggFuel: tube([[XT, 0.74, ZT - 0.15], [XT + 0.05, 0.76, ZT - 0.28], [XT + 0.012, 0.72, GZ]], 0.013, MAT.pipe),
    ggHot: tube([[XT, GY - 0.11, GZ], [XT, 0.43, GZ + 0.12], [XT, 0.37, ZT - 0.2]], 0.024, MAT.pipe),
    exhaust: tube([[XT, 0.31, ZT], [XT, 0.1, ZT - 0.01], [XT, -0.35, zD], [XT, YX, zD]], 0.045, MAT.dark),
  };
  paths.loxMain = paths.loxMain.concat([[0, 0.74, -0.15], [0, 0.71, -0.05], [0, 0.68, 0.06]]); // continues inside the dome
  mesh(new THREE.SphereGeometry(0.048, 20, 14), MAT.steel, XT + 0.01, 1.02, ZT + 0.34); // main oxidiser valve
  mesh(new THREE.SphereGeometry(0.042, 20, 14), MAT.steel, XT, 0.5, ZT + 0.16);         // main fuel valve
  mesh(new THREE.CylinderGeometry(0.045, 0.075, 0.08, 24, 1, true), MAT.dark, XT, YX - 0.04, zD);
  smokeSrc.set(XT, YX - 0.08, zD);
  if (cut) for (const s of [1, -1]) paths['regen' + s] = sample(G.yR + 0.03, YI - 0.015, 40, y => rIn(y) + 0.017).map(p => [0.003, p.y, s * p.x]);

  // gas core: a translucent volume coloured by the chosen flow property
  const pts = []; for (let i = 0; i < NPROF; i++) pts.push(new V2(Math.max(0.002, prof.r[i] * 0.965), prof.y[i]));
  const cg = new THREE.LatheGeometry(pts, 64);
  cg.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(cg.attributes.position.count * 3), 3));
  cg.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(cg.attributes.position.count), 1));
  gasCore = mesh(cg, coreMat, 0, 0, 0);
  gasCore.visible = cut;
  paintProfile();

  plume.position.y = G.ye;
  setXray(cut);
  buildStreams();
}

// ---------- gas core + plume shaders ----------
const coreMat = new THREE.ShaderMaterial({
  uniforms: { uFlowT: { value: 0 }, uGain: { value: 0 } },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  vertexShader: `attribute vec3 aCol; attribute float aS; varying vec3 vCol, vN, vV; varying float vS, vA;
    void main(){ vCol = aCol; vS = aS; vA = atan(position.z, position.x);
      vec4 w = modelMatrix*vec4(position,1.0); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - w.xyz);
      gl_Position = projectionMatrix*viewMatrix*w; }`,
  fragmentShader: `uniform float uFlowT, uGain; varying vec3 vCol, vN, vV; varying float vS, vA;
    void main(){
      float f = abs(dot(normalize(vN), normalize(vV)));
      float band = fract((vS - uFlowT)*3.0 + 0.12*sin(vA*5.0));
      float streak = 0.55 + 0.6*smoothstep(0.75, 1.0, band);
      gl_FragColor = vec4(vCol*(0.15 + 0.85*f)*streak*uGain, 1.0);
    }`
});

const PLUME_R = `
uniform float uRe, uA1, uA2, uAmp, uCell;
float plumeR(float x){ return uRe*max(0.2, (1.0 + uA1*(1.0-exp(-x/1.5)) + uA2*x)*(1.0 + uAmp*sin(6.2832*x/uCell)*exp(-x/(uCell*3.0)))); }`;
const plumeU = { uTime: { value: 0 }, uLen: { value: 3 }, uRe: { value: 0.5 }, uA1: { value: 0 }, uA2: { value: 0 }, uAmp: { value: 0 }, uCell: { value: 3 },
  uWob: { value: 0 }, uGain: { value: 0 }, uFlash: { value: 0 }, uCore: { value: new V3() }, uFlame: { value: new V3() }, uDisk: { value: new V3() } };
const plumeGeo = new THREE.CylinderGeometry(1, 1, 1, 40, 90, true); plumeGeo.translate(0, -0.5, 0);
const plume = new THREE.Mesh(plumeGeo, new THREE.ShaderMaterial({
  uniforms: plumeU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  vertexShader: NOISE + PLUME_R + `
    uniform float uLen, uWob, uTime; varying float vU, vX; varying vec3 vN, vV, vW;
    void main(){
      float u = -position.y, x = u*uLen/uRe;
      float r = plumeR(x);
      if (uWob > 0.0) r *= 1.0 + uWob*0.3*snoise(vec3(position.x*1.5, u*5.0 - uTime*4.0, position.z*1.5));
      vec4 w = modelMatrix*vec4(position.x*r, -u*uLen, position.z*r, 1.0);
      vN = normalize(vec3(position.x, 0.0, position.z)); vV = normalize(cameraPosition - w.xyz); vU = u; vX = x; vW = w.xyz;
      gl_Position = projectionMatrix*viewMatrix*w;
    }`,
  fragmentShader: NOISE + `
    uniform float uTime, uGain, uFlash, uAmp, uCell, uWob; uniform vec3 uCore, uFlame, uDisk; varying float vU, vX; varying vec3 vN, vV, vW;
    void main(){
      float body = pow(abs(dot(normalize(vN), normalize(vV))), 2.6);
      float fall = exp(-vU*2.6)*smoothstep(1.0, 0.55, vU)*smoothstep(0.0, 0.015, vU);
      float n = snoise(vec3(vW.x*4.0, vW.y*1.4 + uTime*9.0, vW.z*4.0));
      vec3 col = mix(uFlame, uCore, exp(-vU*9.0))*(0.75 + 0.35*n)*(1.0 + uWob*0.6*n);
      float disk = pow(max(0.0, -sign(uAmp)*sin(6.2832*vX/uCell)), 14.0)*min(abs(uAmp)*12.0, 1.6)*exp(-vX/(uCell*3.0));
      col = col*body*fall + uDisk*disk*body*exp(-vU*1.2);
      col = mix(col, vec3(0.25, 1.9, 0.45)*body*fall*2.0, uFlash);
      gl_FragColor = vec4(min(col*uGain, vec3(3.0)), 1.0);
    }`
}));
plume.frustumCulled = false;
scene.add(plume);
const PL = { len: 3, re: 0.5, a1: 0, a2: 0, amp: 0, cell: 3 };
function plumeR(x) { return PL.re * Math.max(0.2, (1 + PL.a1 * (1 - Math.exp(-x / 1.5)) + PL.a2 * x) * (1 + PL.amp * Math.sin(TAU * x / PL.cell) * Math.exp(-x / (PL.cell * 3)))); }
function updatePlumeShape() {
  const e = Es, lk = e.pa < 1 ? 3 : clamp(Math.log10(e.pe / e.pa), -1, 3);
  PL.re = RT * Math.sqrt(e.epsEff);
  PL.a1 = lk > 0 ? 0.45 * lk : 0.35 * lk;
  PL.a2 = 0.04 + 0.1 * Math.max(lk, 0);
  PL.amp = (0.08 + 0.14 * Math.min(Math.abs(lk), 1)) * (lk >= 0 ? 1 : -1) * clamp(e.pa / 5000, 0, 1);
  PL.cell = 1.1 * Math.sqrt(Math.max(e.Me * e.Me - 1, 0.5)) * (1 + Math.max(lk, 0) * 0.5);
  PL.len = (2.2 + 3.2 * G.re) * (0.6 + 0.4 * S.thr) * (1 + 0.25 * Math.max(lk, 0));
  plumeU.uRe.value = PL.re; plumeU.uA1.value = PL.a1; plumeU.uA2.value = PL.a2;
  plumeU.uAmp.value = PL.amp; plumeU.uCell.value = PL.cell; plumeU.uLen.value = PL.len; plumeU.uWob.value = e.sep ? 1 : 0;
  plumeU.uCore.value.set(...P.core); plumeU.uFlame.value.set(...P.flame); plumeU.uDisk.value.set(...P.disk);
  // the separated jet leaves the wall inside the bell
  plume.position.y = prof.y[sepIndex()];
}

// =====================================================================
// Particles: propellant in the plumbing, gas in the chamber, turbine smoke
// =====================================================================
const NP = 3200;
const pPos = new Float32Array(NP * 3), pCol = new Float32Array(NP * 3), pSize = new Float32Array(NP);
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aCol', new THREE.BufferAttribute(pCol, 3).setUsage(THREE.DynamicDrawUsage));
pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1).setUsage(THREE.DynamicDrawUsage));
const ptsU = { uScale: { value: 500 } };
const ptsObj = new THREE.Points(pGeo, new THREE.ShaderMaterial({
  uniforms: ptsU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `attribute float aSize; attribute vec3 aCol; uniform float uScale; varying vec3 vCol;
    void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv;
      gl_PointSize = aSize > 0.0 ? clamp(aSize*uScale/-mv.z, 1.5, 28.0) : 0.0; vCol = aCol; }`,
  fragmentShader: `varying vec3 vCol; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, d); gl_FragColor = vec4(vCol*a*a, 1.0); }`
}));
ptsObj.frustumCulled = false;
scene.add(ptsObj);

// streams follow the pipe paths; state persists across rebuilds so particles don't jump
const STREAMS = [
  // key, count, speed (m/s on screen), size, colour, which run level gates it
  ['loxFeed', 60, 0.35, 0.016, () => OX_COL, 'spin'],
  ['fuelFeed', 60, 0.35, 0.015, () => P.fuel, 'spin'],
  ['loxMain', 80, 0.9, 0.014, () => OX_COL, 'spin'],
  ['fuelMain', 70, 0.9, 0.013, () => P.fuel, 'spin'],
  ['regen1', 70, 0.5, 0.01, () => P.fuel, 'spin', HOT_COL],
  ['regen-1', 70, 0.5, 0.01, () => P.fuel, 'spin', HOT_COL],
  ['ggOx', 16, 0.45, 0.008, () => OX_COL, 'gg'],
  ['ggFuel', 16, 0.45, 0.008, () => P.fuel, 'gg'],
  ['ggHot', 34, 1.1, 0.016, () => HOT_COL, 'gg'],
  ['exhaust', 70, 1.0, 0.022, () => EXH_COL, 'gg'],
];
const streamState = {};
let streams = [];
function buildStreams() {
  streams = []; let off = 0;
  for (const [key, n, speed, size, col, gate, heat] of STREAMS) {
    const pts = paths[key];
    if (!pts) continue;
    const curve = new THREE.CatmullRomCurve3(pts.map(p => new V3(...p)));
    const sp = curve.getSpacedPoints(160), lut = new Float32Array(sp.length * 3);
    sp.forEach((p, i) => lut.set([p.x, p.y, p.z], i * 3));
    let st = streamState[key];
    if (!st) {
      st = streamState[key] = { u: new Float32Array(n), j: new Float32Array(n * 3) };
      for (let i = 0; i < n; i++) { st.u[i] = Math.random(); st.j.set([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5], i * 3); }
    }
    streams.push({ key, n, off, lut, m: sp.length - 1, len: curve.getLength(), speed, size, col, gate, heat, st });
    off += n;
  }
  for (let i = off; i < CH0; i++) pSize[i] = 0;
}
const CH0 = 800, NC = NP - CH0; // chamber particles live in [CH0, NP)
const ch = { y: new Float32Array(NC), cs: new Float32Array(NC), sn: new Float32Array(NC), f: new Float32Array(NC), ex: new Float32Array(NC), ez: new Float32Array(NC), kind: new Uint8Array(NC) };
function spawnC(i, anywhere) {
  const e = injPts[(Math.random() * injPts.length) | 0] || [0, 0], flip = Math.random() < 0.5 ? -1 : 1;
  ch.ex[i] = e[0] * flip; ch.ez[i] = e[1];
  const th = Math.random() * TAU; ch.cs[i] = Math.cos(th); ch.sn[i] = Math.sin(th); ch.f[i] = Math.sqrt(Math.random()) * 0.97; ch.kind[i] = Math.random() < 0.5 ? 0 : 1;
  ch.y[i] = YI - 0.012 - (anywhere ? Math.random() * (YI - G.ye + PL.len) : Math.random() * 0.01);
}

function updateParticles(dt, sm) {
  const lv = { spin: seq.spin, gg: seq.gg };
  for (const s of streams) {
    const level = lv[s.gate], adv = dt * sm * s.speed * (0.15 + 0.85 * level) * (0.5 + 0.5 * S.thr) / s.len;
    const bright = 0.35 + 0.65 * level, c0 = s.col(), h = s.heat, jit = s.size * 1.1;
    for (let i = 0; i < s.n; i++) {
      let u = s.st.u[i] + adv; if (u >= 1) u -= 1; s.st.u[i] = u;
      const f = u * s.m, k = Math.min(s.m - 1, f | 0), t = f - k, o = (s.off + i) * 3, a = k * 3, j = i * 3;
      for (let c = 0; c < 3; c++) pPos[o + c] = s.lut[a + c] + (s.lut[a + 3 + c] - s.lut[a + c]) * t + s.st.j[j + c] * jit;
      const fade = Math.min(1, u * 25, (1 - u) * 16) * bright, w = h ? u * u : 0;
      for (let c = 0; c < 3; c++) pCol[o + c] = (h ? c0[c] + (h[c] - c0[c]) * w : c0[c]) * fade;
      pSize[s.off + i] = s.size;
    }
  }

  // chamber → nozzle → plume
  const run = seq.run, glow = run * 0.22 * (0.55 + 0.45 * S.thr), ve = prof.vis[NPROF - 1];
  for (let i = 0; i < NC; i++) {
    let y = ch.y[i];
    const v = y > G.ye ? prof.vis[pIdx(y)] : ve * (1 - 0.45 * (G.ye - y) / PL.len);
    y -= v * dt * sm * (0.3 + 0.7 * run);
    if (y < G.ye - PL.len || run < 0.01) { spawnC(i, run < 0.01); y = ch.y[i]; }
    ch.y[i] = y;
    const o = (CH0 + i) * 3, cs = ch.cs[i], sn = ch.sn[i], f = ch.f[i];
    let x, z, r = 0, g = 0, b = 0, size = 0.011;
    if (y > YI - 0.09) { // injector spray: oxidiser and fuel jets atomising and mixing
      const q = pIdx(y) * 3, t = (YI - y) / 0.09, rr = prof.r[q / 3] * 0.93 * f;
      x = lerp(ch.ex[i], rr * cs, t * t); z = lerp(ch.ez[i], rr * sn, t * t);
      const c0 = ch.kind[i] ? P.fuel : OX_COL, k = smooth(0.4, 1, t);
      r = lerp(c0[0], prof.col[q] * 1.3, k); g = lerp(c0[1], prof.col[q + 1] * 1.3, k); b = lerp(c0[2], prof.col[q + 2] * 1.3, k);
      size = 0.008;
    } else if (y > G.ye) {
      const q = pIdx(y) * 3, rr = prof.r[q / 3] * 0.93 * f;
      x = rr * cs; z = rr * sn;
      r = prof.col[q] * 1.3; g = prof.col[q + 1] * 1.3; b = prof.col[q + 2] * 1.3;
    } else {
      const u = (G.ye - y) / PL.len, rr = plumeR(u * PL.len / PL.re) * f, fade = Math.pow(1 - u, 2) * P.gain * 0.8;
      x = rr * cs; z = rr * sn;
      r = P.flame[0] * fade; g = P.flame[1] * fade; b = P.flame[2] * fade;
      size = 0.014 + u * 0.05;
    }
    pPos[o] = x; pPos[o + 1] = y; pPos[o + 2] = z;
    pCol[o] = r * glow; pCol[o + 1] = g * glow; pCol[o + 2] = b * glow;
    pSize[CH0 + i] = run > 0.01 ? size : 0;
  }
  pGeo.attributes.position.needsUpdate = pGeo.attributes.aCol.needsUpdate = pGeo.attributes.aSize.needsUpdate = true;
}

// turbine exhaust smoke (normal blending so soot can be dark)
const NS = 240, smokeSrc = new V3();
const sPos = new Float32Array(NS * 3), sCol = new Float32Array(NS * 4), sSize = new Float32Array(NS), sVel = new Float32Array(NS * 3), sLife = new Float32Array(NS);
const sGeo = new THREE.BufferGeometry();
sGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
sGeo.setAttribute('aCol', new THREE.BufferAttribute(sCol, 4));
sGeo.setAttribute('aSize', new THREE.BufferAttribute(sSize, 1));
const smoke = new THREE.Points(sGeo, new THREE.ShaderMaterial({
  uniforms: ptsU, transparent: true, depthWrite: false,
  vertexShader: `attribute float aSize; attribute vec4 aCol; uniform float uScale; varying vec4 vCol;
    void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = min(aSize*uScale/-mv.z, 64.0); vCol = aCol; }`,
  fragmentShader: `varying vec4 vCol; void main(){ float d = length(gl_PointCoord - 0.5); gl_FragColor = vec4(vCol.rgb, vCol.a*smoothstep(0.5, 0.0, d)); }`
}));
smoke.frustumCulled = false; smoke.renderOrder = 2;
scene.add(smoke);
for (let i = 0; i < NS; i++) sLife[i] = -Math.random() * 2.2; // staggered first spawn
function updateSmoke(dt, sm) {
  const sc = P.smoke;
  for (let i = 0; i < NS; i++) {
    const was = sLife[i];
    let l = was + dt * sm * 0.45;
    if (l >= 1 || (was < 0 && l >= 0)) {
      l = l >= 1 ? l - 1 : l; sPos.set([smokeSrc.x, smokeSrc.y, smokeSrc.z], i * 3);
      sVel.set([(Math.random() - 0.5) * 0.16, -0.8 - Math.random() * 0.4, (Math.random() - 0.5) * 0.16], i * 3);
    }
    sLife[i] = l;
    for (let k = 0; k < 3; k++) { sPos[i * 3 + k] += sVel[i * 3 + k] * dt * sm; }
    sVel[i * 3 + 1] *= 1 - 0.6 * dt * sm;
    sSize[i] = l < 0 ? 0 : 0.05 + l * 0.45;
    const a = sc[3] * Math.pow(1 - l, 1.5) * smooth(0, 0.08, l) * seq.gg * (0.6 + 0.4 * S.thr);
    sCol.set([sc[0] + 0.5 * Math.exp(-l * 12) * (S.prop === 'rp1' ? 1 : 0.3), sc[1] + 0.12 * Math.exp(-l * 12), sc[2], a], i * 4);
  }
  sGeo.attributes.position.needsUpdate = sGeo.attributes.aCol.needsUpdate = sGeo.attributes.aSize.needsUpdate = true;
}

// probe ring shown when hovering the nozzle chart
const probe = new THREE.Group(); probe.visible = false; scene.add(probe);
{
  const pts = []; for (let i = 0; i <= 128; i++) pts.push(new V3(Math.cos(i / 128 * TAU), 0, Math.sin(i / 128 * TAU)));
  probe.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: new THREE.Color(4, 4, 4) })));
  const d = new THREE.CircleGeometry(1, 96); d.rotateX(-Math.PI / 2);
  probe.add(new THREE.Mesh(d, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 0.4, 0.45), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })));
}

// =====================================================================
// Hotspots + guided tour
// =====================================================================
const f0 = n => Math.round(n).toLocaleString('en-US');
const f1 = n => n.toFixed(1), f2 = n => n.toFixed(2);
function tpStats(e) {
  const thr = e.Pc / PC_NOM, of = S.of, mo = e.mdot * of / (1 + of), mf = e.mdot / (1 + of);
  const dp = 1.3 * e.Pc; // pump discharge sits well above chamber pressure (injector + cooling-jacket losses)
  return { rpm: 36000 * Math.sqrt(Math.max(thr, 0)) * seq.spin, MW: dp * (mo / RHO_OX + mf / P.rhoF) / 0.65 / 1e6, mo, mf };
}
const STEPS = [
  { hot: null, title: 'How a rocket engine works', cam: () => overview(),
    body: () => `A liquid rocket engine turns chemical energy into a fast jet of gas. This is a <b>gas-generator cycle</b> engine, the design used by Merlin and the F-1, and it is cut in half so you can see inside. The tour follows the propellant through nine stops, from the tanks to the plume.`,
    try: 'Everything in the right-hand panel is live. Move a slider and the physics, the 3D model and the charts all update.' },
  { hot: 'feed', title: 'Propellant feed', cam: () => ({ t: [XT, 1.35, ZT], d: 2.3, dir: [1, 0.15, -0.35] }),
    body: () => `Liquid oxygen at −183 °C (blue) and ${P.name} (${S.prop === 'rp1' ? 'amber' : S.prop === 'ch4' ? 'green' : 'violet'}) come down from the tanks at only a few bar. Tanks have to be thin and light, so they can't hold high pressure. At full throttle this engine swallows <b>${f0(Es.mdot)} kg of propellant every second</b>.`,
    try: 'Keep Cutaway on to see through the pipes.' },
  { hot: 'tp', title: 'Turbopump', cam: () => ({ t: [XT, 0.7, ZT], d: 1.45, dir: [1, 0.2, -0.45] }),
    body: () => { const t = tpStats(Es); return `A turbine and two pumps share one shaft spinning at about <b>${f0(36000 * Math.sqrt(S.thr))} rpm</b>. The pumps raise the propellants from a few bar to about ${f0(Es.Pc * 1.3 / 1e5)} bar. The machine is roughly the size of a suitcase and absorbs about <b>${f1(t.MW)} MW</b>, which is locomotive-class power. ${S.prop === 'lh2' ? 'Hydrogen is so light that pumping it takes most of that power.' : ''}`; },
    try: 'Push the throttle up. Pump speed and power rise with it.' },
  { hot: 'gg', title: 'Gas generator', cam: () => ({ t: [XT, 0.55, ZT - 0.25], d: 1.35, dir: [1, 0.25, -0.8] }),
    body: () => `Something has to drive the turbine. The gas generator burns a small bleed of the same propellants, about 3 %, and runs deliberately <b>fuel-rich</b> so the gas stays near 1,000 K and doesn't melt the turbine blades. The spent gas is then dumped overboard as the ${S.prop === 'rp1' ? 'dark, sooty' : 'faint'} exhaust stream. That wasted propellant is the price of this simple cycle. Staged-combustion engines send it into the main chamber instead.`,
    try: 'Shut the engine down and re-ignite it. The gas generator lights first to spin up the pumps.' },
  { hot: 'regen', title: 'Regenerative cooling', cam: () => ({ t: [0, -0.05, rIn(-0.05) + 0.02], d: 1.25, dir: [1, 0.12, 0.55] }),
    body: () => `The chamber gas reaches <b>${f0(Es.Tc)} K</b>, hotter than the melting point of every metal in the wall. Before the fuel reaches the injector it runs through hundreds of narrow channels in the copper-alloy liner (the slot in the red cut face). It soaks up the heat and keeps the wall at a few hundred degrees.${G.ye < G.yR - 1e-3 ? ' The thin lower nozzle extension has no channels. It is cooled by radiation alone, which is why it glows red.' : ''}`,
    try: 'Watch the fuel in the channel warm from cold to orange as it climbs.' },
  { hot: 'inj', title: 'Injector', cam: () => ({ t: [0, YI - 0.06, 0], d: 0.95, dir: [1, -0.45, 0.2] }),
    body: () => `Hundreds of small elements spray oxidiser and fuel so the jets collide, <b>atomise</b> into a fine mist, mix and evaporate within a few centimetres. The injector sets the mixture ratio (now <b>${f2(S.of)}</b> by mass) and keeps combustion stable. A poorly designed injector can shake an engine apart.`,
    try: `Change the mixture ratio. Running slightly fuel-rich lowers the temperature, but the lighter exhaust molecules can still raise Isp.` },
  { hot: 'cc', title: 'Combustion chamber', cam: () => ({ t: [0, 0.38, 0], d: 1.25, dir: [1, 0.1, 0.25] }),
    body: () => `Here chemical energy becomes heat. The gas is at <b>${f0(Es.Pc / 1e5)} bar</b> and <b>${f0(Es.Tc)} K</b> but hardly moving, around Mach ${f2(prof.M[0])}. The high pressure pushes on the injector face and the chamber walls, and that push is where the thrust is transmitted to the rocket.`,
    try: 'Switch the gas colour to Pressure, then to Temperature.' },
  { hot: 'throat', title: 'Throat', cam: () => ({ t: [0, 0.02, 0], d: 0.95, dir: [1, 0.05, 0.25] }),
    body: () => `This is the narrowest point. Subsonic gas speeds up as the passage narrows and reaches <b>exactly Mach 1</b> at the throat. Once the throat is sonic it is <b>choked</b>: pressure changes further downstream can't travel back upstream, so the throat alone sets the mass flow, ṁ = p꜀·Aₜ / c* = <b>${f0(Es.mdot)} kg/s</b>.`,
    try: 'Switch the gas colour to Mach number. White marks Mach 1.' },
  { hot: 'noz', title: 'Nozzle', cam: () => ({ t: [0, G.ye * 0.5, 0], d: 1.6 + 1.1 * G.L, dir: [1, 0.1, 0.3] }),
    body: () => `This is the counter-intuitive part. Once the gas is supersonic, it speeds up as the passage gets <b>wider</b>. The bell turns heat into directed motion, so temperature and pressure plunge while velocity climbs to <b>${f0(Es.ve)} m/s</b> (Mach ${f2(Es.Me)}). A bigger expansion ratio extracts more energy, but only if the outside air allows it.`,
    try: 'Hover over the “Inside the nozzle” chart. The white ring follows your cursor through the engine.' },
  { hot: 'plume', title: 'Plume & altitude', cam: () => ({ t: [0, G.ye - 1.4, 0], d: 4.8 + 0.6 * G.L, dir: [1, 0.05, 0.35] }),
    body: () => `Thrust = ṁ·vₑ + (pₑ − pₐ)·Aₑ. The exhaust leaves at ${f2(Es.pe / 1e5)} bar into ${Es.pa < 50 ? 'vacuum' : f2(Es.pa / 1e5) + ' bar of air'}, so it is <b>${expState(Es).label.toLowerCase()}</b>. ${Es.pa < 5000 ? 'With almost no air to push back, the plume balloons outward and no shock diamonds form.' : 'That pressure mismatch forms the shock diamonds: the jet over-shoots, gets squeezed back and repeats.'} As the rocket climbs the air thins, the plume balloons out and the same engine makes more thrust. That is why upper stages carry huge vacuum nozzles.`,
    try: 'Drag altitude to 100 km, then press “Match nozzle to this altitude”. Then return to 0 km.' },
];
const HOT = {
  feed: ['Propellant feed', () => [XT + 0.2, 1.75, ZT]],
  tp: ['Turbopump', () => [XT, 0.86, ZT - 0.05]],
  gg: ['Gas generator', () => [XT, GY + 0.02, GZ - 0.02]],
  regen: ['Cooling channels', () => { const y = Math.max(G.yR + 0.15, -0.25); return [0, y, rIn(y) + 0.017]; }],
  inj: ['Injector', () => [0, YI - 0.03, 0.06]],
  cc: ['Combustion chamber', () => [0, 0.42, 0.05]],
  throat: ['Throat', () => [0, 0, 0.05]],
  noz: ['Nozzle', () => [0, G.ye * 0.55, 0.1]],
  plume: ['Exhaust plume', () => [0, G.ye - Math.min(1.4, PL.len * 0.4), 0]],
};
const hotEls = {};
STEPS.forEach((s, i) => {
  if (!s.hot) return;
  const b = document.createElement('button');
  b.className = 'hot'; b.type = 'button';
  b.innerHTML = `<i>${i}</i><span>${HOT[s.hot][0]}</span>`;
  b.setAttribute('aria-label', `Stop ${i}: ${HOT[s.hot][0]}`);
  b.addEventListener('click', () => goStep(i));
  $('labels').appendChild(b); hotEls[s.hot] = b;
});
STEPS.forEach((s, i) => {
  const d = document.createElement('button'); d.type = 'button'; d.setAttribute('aria-label', i ? `Stop ${i}: ${s.title}` : 'Introduction');
  d.addEventListener('click', () => goStep(i)); $('tDots').appendChild(d);
});
let step = 0;
function overview() { return { t: [0, (1.1 + G.ye) / 2 - 0.15, 0.05], d: 4.4 + 0.95 * G.L, dir: [1, 0.2, 0.3] }; }
function renderTour() {
  const s = STEPS[step];
  $('tStep').textContent = step ? `Stop ${step} of ${STEPS.length - 1}` : 'Guided tour';
  $('tTitle').textContent = s.title;
  $('tBody').innerHTML = s.body();
  $('tTry').textContent = s.try;
  $('tPrev').disabled = step === 0;
  $('tNext').textContent = step === 0 ? 'Start tour ›' : step === STEPS.length - 1 ? 'Overview ›' : 'Next ›';
  [...$('tDots').children].forEach((d, i) => d.classList.toggle('on', i === step));
  for (const k in hotEls) hotEls[k].classList.toggle('on', k === s.hot);
}
function goStep(i, instant) {
  step = (i + STEPS.length) % STEPS.length;
  renderTour();
  const c = STEPS[step].cam();
  focus(c.t, c.d, c.dir, instant);
}
let tw = null;
function focus(t, d, dir, instant) {
  const target = new V3(...t), pos = target.clone().add(new V3(...dir).normalize().multiplyScalar(d));
  if (instant || reduceMotion) { camera.position.copy(pos); controls.target.copy(target); tw = null; return; }
  tw = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: target, k: 0 };
}
controls.addEventListener('start', () => { tw = null; });
$('tPrev').addEventListener('click', () => goStep(step - 1));
$('tNext').addEventListener('click', () => goStep(step + 1));
$('tMin').addEventListener('click', () => {
  const min = $('tour').classList.toggle('min');
  $('tMin').textContent = min ? '+' : '–'; $('tMin').setAttribute('aria-expanded', String(!min));
});
addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('input, select')) return;
  if (e.key === 'ArrowRight') goStep(step + 1);
  if (e.key === 'ArrowLeft') goStep(step - 1);
});

// =====================================================================
// Engine start / stop sequence
// =====================================================================
let capTimer = 0;
function caption(title, sub) { $('cap').innerHTML = title + (sub ? `<small>${sub}</small>` : ''); $('cap').classList.add('on'); capTimer = 2.8; }
const START = [
  [0, 'Spin start', 'Helium spins the turbine to get the pumps moving'],
  [0.9, 'Gas generator ignition', 'The turbine now drives itself, and the pumps build pressure'],
  [1.7, 'Main valves open', null],
  [3.0, 'Mainstage', 'Full thrust'],
];
function stepSeq(dt) {
  const q = seq; q.t += dt;
  if (q.phase === 'start') {
    q.spin = Math.max(q.spin, smooth(0, 3, q.t)); q.gg = Math.max(q.gg, smooth(0.9, 1.5, q.t)); q.run = Math.max(q.run, smooth(1.8, 3, q.t));
    q.flash = S.prop === 'rp1' ? clamp(1 - Math.abs(q.t - 1.9) / 0.3, 0, 1) : 0;
    while (q.cap + 1 < START.length && q.t >= START[q.cap + 1][0]) {
      const c = START[++q.cap];
      caption(c[1], c[2] || (S.prop === 'rp1' ? 'TEA-TEB igniter: the green flash' : 'Spark-torch igniter lights the mixture'));
    }
    if (q.t > 3.1) { q.phase = 'main'; q.flash = 0; }
  } else if (q.phase === 'stop') {
    const f = q.from;
    q.run = f.run * (1 - smooth(0, 0.5, q.t)); q.gg = f.gg * (1 - smooth(0, 0.4, q.t)); q.spin = f.spin * (1 - smooth(0.2, 3.5, q.t)); q.flash = 0;
    if (q.t > 3.6) q.phase = 'off';
  }
}
function setRun(on) {
  if (on) { seq.phase = 'start'; seq.t = 0; seq.cap = -1; }
  else { seq.phase = 'stop'; seq.t = 0; seq.from = { run: seq.run, gg: seq.gg, spin: seq.spin }; caption('Shutdown', 'Main valves close, turbopump spins down'); }
}
$('bRun').addEventListener('click', () => setRun(seq.phase === 'off' || seq.phase === 'stop'));

// =====================================================================
// Controls panel
// =====================================================================
function setProp(k) {
  S.prop = k; P = PROPS[k];
  document.querySelectorAll('#props button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.p === k)));
  $('propNote').textContent = P.note;
  const sOF = $('sOF'); sOF.min = P.of[0]; sOF.max = P.of[1]; sOF.value = S.of = P.ofNom;
  refresh('gas');
}
document.querySelectorAll('#props button').forEach(b => b.addEventListener('click', () => setProp(b.dataset.p)));
$('props').addEventListener('keydown', e => {
  const ks = Object.keys(PROPS), i = ks.indexOf(S.prop), d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!d) return; e.preventDefault(); e.stopPropagation();
  setProp(ks[(i + d + ks.length) % ks.length]); document.querySelector(`#props [data-p="${S.prop}"]`).focus();
});
$('sThr').addEventListener('input', e => { S.thr = +e.target.value / 100; refresh('scalar'); });
$('sOF').addEventListener('input', e => { S.of = +e.target.value; refresh('gas'); });
$('sEps').addEventListener('input', e => { S.eps = +e.target.value; refresh('geom'); });
$('sAlt').addEventListener('input', e => { S.alt = +e.target.value; refresh('scalar'); });
$('bMatch').addEventListener('click', () => {
  const m = matchedEps(P, S.of, S.thr, S.alt);
  S.eps = clamp(Math.round(m * 2) / 2, 4, 100); $('sEps').value = S.eps; refresh('geom');
  caption(m > 100 ? 'Nozzle at maximum' : 'Nozzle matched', m > 100 ? `A perfect match here needs ε ≈ ${m === Infinity ? '∞' : f0(m)}, so it is capped at 100` : `ε = ${f1(S.eps)}: exit pressure now equals ambient pressure`);
});
$('field').addEventListener('change', e => { S.field = e.target.value; paintProfile(); updateLegend(); });
const toggle = (id, key, fn) => $(id).addEventListener('click', () => { S[key] = !S[key]; $(id).setAttribute('aria-pressed', String(S[key])); fn && fn(); });
toggle('bCut', 'cut', () => refresh('geom'));
toggle('bLab', 'labels', () => { $('labels').hidden = !S.labels; });
toggle('bSlow', 'slow');
toggle('bSound', 'sound', () => { if (S.sound) initAudio(); });

function refresh(kind) {
  if (kind === 'geom') setGeom(S.eps);
  if (kind === 'geom' || kind === 'gas') buildProfile();
  if (kind === 'geom') buildEngine(); else if (kind === 'gas') paintProfile();
  Es = solve(P, S.of, S.thr, S.eps, S.alt);
  updatePlumeShape();
  $('oThr').textContent = `${Math.round(S.thr * 100)} %`;
  $('oOF').textContent = f2(S.of);
  $('oEps').textContent = f1(S.eps);
  $('oAlt').textContent = S.alt >= 100 ? '100 km' : `${f1(S.alt)} km`;
  $('ofHint').textContent = `${S.of < P.stoich ? 'Fuel-rich' : 'Oxidiser-rich'}. Stoichiometric is ${P.stoich}, and best Isp usually sits a little fuel-rich of it.`;
  $('altHint').textContent = Es.pa < 50 ? `Ambient pressure ${f0(Es.pa)} Pa, effectively vacuum` : `Ambient pressure ${f1(Es.pa / 1000)} kPa (${f0(Es.pa / 1013.25)} % of sea level)`;
  updateLegend(); renderTour(); drawProfile(hoverI); drawAlt();
  dirty = true;
}

function expState(e) {
  if (e.off) return { label: 'Engine off', color: 'var(--dim)' };
  if (e.sep) return { label: 'Flow separation', color: 'var(--bad)' };
  if (e.pa < 50) return { label: 'Under-expanded (vacuum)', color: 'var(--amber)' };
  const r = e.pe / e.pa;
  return r > 1.12 ? { label: 'Under-expanded', color: 'var(--amber)' } : r < 0.88 ? { label: 'Over-expanded', color: 'var(--cyan)' } : { label: 'Ideally expanded', color: 'var(--good)' };
}
let dirty = true;
function updateReadouts() {
  E = solve(P, S.of, S.thr, S.eps, S.alt, seq.run);
  const e = E, off = e.off, tp = tpStats(e), bar = x => f2(x / 1e5);
  const set = (id, v, sub) => { $(id).innerHTML = v; if (sub !== undefined) $(id + '2').textContent = sub; };
  set('rF', off ? '0<small>kN</small>' : `${f0(Math.max(0, e.F) / 1000)}<small>kN</small>`, off ? 'no thrust' : `holds up ${f1(Math.max(0, e.F) / G0 / 1000)} t on Earth`);
  set('rIsp', off ? '—' : `${f0(e.Isp)}<small>s</small>`, `c* ${f0(e.cstar)} m/s · CF ${off ? '—' : f2(e.CF)}`);
  set('rMd', `${f0(e.mdot)}<small>kg/s</small>`, `LOX ${f0(tp.mo)} · ${P.name} ${f0(tp.mf)}`);
  set('rPc', `${f0(e.Pc / 1e5)}<small>bar</small>`, `${off ? '—' : f0(e.Tc)} K · Mach ${f2(prof.M[0])}`);
  set('rVe', off ? '—' : `${f0(e.ve)}<small>m/s</small>`, off ? '' : `${f0(e.ve * 3.6)} km/h`);
  set('rMe', off ? '—' : f2(e.Me), off ? '' : `exit temperature ${f0(e.Te)} K`);
  set('rPe', off ? '—' : `${bar(e.pe)}<small>bar</small>`, `ambient ${e.pa < 50 ? '≈ 0' : bar(e.pa)} bar`);
  set('rTp', `${f0(tp.rpm)}<small>rpm</small>`, `${f1(tp.MW)} MW shaft power`);
  const st = expState(e), b = $('expBadge'); b.textContent = st.label; b.style.color = st.color;
  // thrust equation
  const kN = x => f0(x / 1000);
  $('eq').innerHTML = off ? '<span class="f">F = ṁ·vₑ + (pₑ − pₐ)·Aₑ</span><br>Engine is not running.' :
    `<span class="f">F = ṁ·vₑ + (pₑ − pₐ)·A${e.sep ? '<sub>sep</sub>' : 'ₑ'}</span><br>` +
    `= ${f0(e.mdot)} kg/s × ${f0(e.ve)} m/s + (${bar(e.pe)} − ${bar(e.pa)} bar) × ${f2(AT * e.epsEff)} m²<br>` +
    `= <b>${kN(e.Fmom)} kN</b> ${e.Fpres < 0 ? '−' : '+'} <b style="color:${e.Fpres < 0 ? 'var(--bad)' : 'var(--good)'}">${kN(Math.abs(e.Fpres))} kN</b> = <b>${kN(e.F)} kN</b>` +
    (e.sep ? `<br><span style="color:var(--bad)">The jet has torn away from the wall inside the bell. In a real engine that causes violent side loads.</span>` : '');
  const tot = Math.abs(e.Fmom) + Math.abs(e.Fpres) || 1;
  $('spMom').style.width = `${e.Fmom / tot * 100}%`;
  $('spPr').style.width = `${Math.abs(e.Fpres) / tot * 100}%`;
  $('spPr').style.background = $('kPr').style.background = e.Fpres < 0 ? 'var(--bad)' : 'var(--good)';
  const s = $('state'), ph = seq.phase;
  s.textContent = ph === 'main' ? 'Mainstage' : ph === 'start' ? 'Starting' : ph === 'stop' ? 'Shutting down' : 'Safed';
  s.classList.toggle('live', ph === 'main' || ph === 'start');
  $('bRun').textContent = ph === 'off' || ph === 'stop' ? 'Ignite' : ph === 'start' ? 'Abort' : 'Shut down';
}
function updateLegend() {
  const e = Es, L = { T: ['Gas temperature', '0 K', '', `${f0(e.Tc)} K`], p: ['Gas pressure (log)', `${f2(e.Pc / 1e8)} bar`, `${f1(e.Pc * 0.0316 / 1e5)}`, `${f0(e.Pc / 1e5)} bar`],
    M: ['Mach number', '0', '1 · sonic', f0(prof.Mmax)], v: ['Gas velocity', '0', '', `${f0(prof.v[NPROF - 1])} m/s`] }[S.field];
  $('legName').textContent = L[0]; $('legA').textContent = L[1]; $('legB').textContent = L[2]; $('legC').textContent = L[3];
}

// =====================================================================
// Charts
// =====================================================================
const cvP = $('cvP'), cvA = $('cvA'), CSS = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const COL = { ink: CSS('--ink'), dim: CSS('--dim'), amber: CSS('--amber'), cyan: CSS('--cyan'), violet: CSS('--violet'), bad: CSS('--bad'), line: 'rgba(234,240,247,.12)' };
function fit(cv) {
  const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1;
  if (!r.width) return null;
  cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d);
  const c = cv.getContext('2d'); c.setTransform(d, 0, 0, d, 0, 0);
  c.font = '10px ' + CSS('--mono'); c.textBaseline = 'middle';
  return [c, r.width, r.height];
}
const PAD = { l: 34, r: 30, t: 12, b: 22 };
let hoverI = null;
function drawProfile(hi) {
  const F = fit(cvP); if (!F) return;
  const [c, W, H] = F, { l, r, t, b } = PAD, pw = W - l - r, ph = H - t - b, N = NPROF;
  const X = i => l + pw * i / (N - 1), Y = v => t + ph * (1 - v);
  // nozzle silhouette
  const mid = t + ph / 2, k = (ph / 2) * 0.95 / (G.re + W_EXT);
  c.beginPath();
  for (let i = 0; i < N; i++) c.lineTo(X(i), mid - prof.r[i] * k);
  for (let i = N - 1; i >= 0; i--) c.lineTo(X(i), mid + prof.r[i] * k);
  c.closePath(); c.fillStyle = 'rgba(234,240,247,.045)'; c.fill(); c.strokeStyle = 'rgba(234,240,247,.12)'; c.stroke();
  // separation
  if (Es.sep) {
    const i0 = sepIndex();
    c.fillStyle = 'rgba(255,107,90,.12)'; c.fillRect(X(i0), t, X(N - 1) - X(i0), ph);
    c.fillStyle = COL.bad; c.textAlign = 'right'; c.fillText('separated', X(N - 1) - 4, t + ph - 8);
  }
  // grid + axes
  c.strokeStyle = COL.line; c.lineWidth = 1; c.fillStyle = COL.dim;
  for (const v of [0, 0.5, 1]) {
    c.beginPath(); c.moveTo(l, Y(v)); c.lineTo(l + pw, Y(v)); c.stroke();
    c.textAlign = 'right'; c.fillText(`${v * 100}%`, l - 5, Y(v));
    c.textAlign = 'left'; c.fillText(String(+(v * prof.Mmax).toFixed(1)), l + pw + 5, Y(v));
  }
  c.textAlign = 'left'; c.fillText('injector', l, H - 8);
  c.textAlign = 'right'; c.fillText('exit', l + pw, H - 8);
  c.textAlign = 'center'; c.fillText(`${f2(YI - G.ye)} m`, l + pw / 2, H - 8);
  // throat
  const iT = pIdx(0);
  c.setLineDash([3, 3]); c.strokeStyle = 'rgba(234,240,247,.35)'; c.beginPath(); c.moveTo(X(iT), t); c.lineTo(X(iT), t + ph); c.stroke(); c.setLineDash([]);
  c.fillStyle = COL.ink; c.textAlign = 'left'; c.fillText('throat · M 1', X(iT) + 4, t + 6);
  // curves
  const ve = prof.v[N - 1];
  const curve = (f, col, w = 1.6) => { c.strokeStyle = col; c.lineWidth = w; c.beginPath(); for (let i = 0; i < N; i++) c.lineTo(X(i), Y(f(i))); c.stroke(); };
  curve(i => prof.p[i], COL.cyan);
  curve(i => prof.T[i], COL.amber);
  curve(i => prof.v[i] / ve, COL.violet);
  curve(i => prof.M[i] / prof.Mmax, COL.ink, 1.3);
  if (hi != null) {
    c.strokeStyle = 'rgba(234,240,247,.6)'; c.lineWidth = 1; c.beginPath(); c.moveTo(X(hi), t); c.lineTo(X(hi), t + ph); c.stroke();
    for (const [v, col] of [[prof.p[hi], COL.cyan], [prof.T[hi], COL.amber], [prof.v[hi] / ve, COL.violet], [prof.M[hi] / prof.Mmax, COL.ink]]) {
      c.fillStyle = col; c.beginPath(); c.arc(X(hi), Y(v), 3, 0, TAU); c.fill();
    }
  }
}
function probeAt(clientX) {
  const rc = cvP.getBoundingClientRect();
  const i = clamp(Math.round((clientX - rc.left - PAD.l) / (rc.width - PAD.l - PAD.r) * (NPROF - 1)), 0, NPROF - 1);
  hoverI = i; drawProfile(i);
  const tip = $('tipP'); tip.hidden = false;
  tip.style.left = `${clamp(PAD.l + (rc.width - PAD.l - PAD.r) * i / (NPROF - 1), 90, rc.width - 90)}px`;
  tip.innerHTML = `${f2(YI - prof.y[i])} m from injector · Aₓ/Aₜ ${f2((prof.r[i] / RT) ** 2)}<br>Mach <b>${f2(prof.M[i])}</b> · ${f0(prof.v[i])} m/s<br>${f1(prof.p[i] * Es.Pc / 1e5)} bar · ${f0(prof.T[i] * Es.Tc)} K`;
  probe.visible = true; probe.position.y = prof.y[i]; probe.scale.set(prof.r[i] * 0.99, 1, prof.r[i] * 0.99);
}
cvP.addEventListener('pointermove', e => probeAt(e.clientX));
cvP.addEventListener('pointerdown', e => probeAt(e.clientX));
cvP.addEventListener('pointerleave', () => { hoverI = null; $('tipP').hidden = true; probe.visible = false; drawProfile(null); });

function drawAlt() {
  const F = fit(cvA); if (!F) return;
  const [c, W, H] = F, l = 38, r = 12, t = 12, b = 22, pw = W - l - r, ph = H - t - b, K = 101;
  const cur = [], ada = [], sep = [];
  for (let k = 0; k < K; k++) {
    const e = solve(P, S.of, S.thr, S.eps, k);
    cur.push(e.Isp); sep.push(e.sep);
    ada.push(solve(P, S.of, S.thr, clamp(matchedEps(P, S.of, S.thr, k), 1.2, 400), k).Isp);
  }
  const all = cur.concat(ada), y0 = Math.floor((Math.min(...all) - 5) / 25) * 25, y1 = Math.ceil((Math.max(...all) + 5) / 25) * 25;
  const X = km => l + pw * km / 100, Y = v => t + ph * (1 - (v - y0) / (y1 - y0));
  c.fillStyle = 'rgba(255,107,90,.12)';
  for (let k = 0; k < K; k++) if (sep[k]) c.fillRect(X(k) - pw / 200, t, pw / 100, ph);
  c.strokeStyle = COL.line; c.fillStyle = COL.dim; c.lineWidth = 1;
  const step = y1 - y0 > 150 ? 50 : 25;
  for (let v = y0; v <= y1; v += step) { c.beginPath(); c.moveTo(l, Y(v)); c.lineTo(l + pw, Y(v)); c.stroke(); c.textAlign = 'right'; c.fillText(`${v} s`, l - 5, Y(v)); }
  c.textAlign = 'center';
  for (const km of [0, 25, 50, 75, 100]) c.fillText(`${km} km`, clamp(X(km), l + 14, l + pw - 16), H - 8);
  c.setLineDash([4, 3]); c.strokeStyle = COL.ink; c.lineWidth = 1.2; c.beginPath(); ada.forEach((v, k) => c.lineTo(X(k), Y(v))); c.stroke(); c.setLineDash([]);
  c.strokeStyle = COL.amber; c.lineWidth = 2; c.beginPath(); cur.forEach((v, k) => c.lineTo(X(k), Y(v))); c.stroke();
  const e = Es;
  c.fillStyle = COL.amber; c.beginPath(); c.arc(X(S.alt), Y(e.Isp), 4.5, 0, TAU); c.fill();
  c.fillStyle = COL.ink; c.textAlign = S.alt > 70 ? 'right' : 'left';
  c.fillText(`${f0(e.Isp)} s`, X(S.alt) + (S.alt > 70 ? -9 : 9), Y(e.Isp) + (e.Isp > (y0 + y1) / 2 ? 12 : -12));
}

// =====================================================================
// Sound: filtered brown-noise roar + turbopump whine
// =====================================================================
let ac = null, nGain, nLP, wOsc, wF, wGain;
function initAudio() {
  if (ac) { ac.resume(); return; }
  try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  const len = ac.sampleRate * 2, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
  let last = 0; for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
  const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
  nLP = ac.createBiquadFilter(); nLP.type = 'lowpass'; nLP.frequency.value = 200;
  nGain = ac.createGain(); nGain.gain.value = 0;
  src.connect(nLP).connect(nGain).connect(ac.destination); src.start();
  wOsc = ac.createOscillator(); wOsc.type = 'sawtooth';
  wF = ac.createBiquadFilter(); wF.type = 'bandpass'; wF.Q.value = 9;
  wGain = ac.createGain(); wGain.gain.value = 0;
  wOsc.connect(wF).connect(wGain).connect(ac.destination); wOsc.start();
}
function updateAudio() {
  if (!ac) return;
  const t = ac.currentTime, on = S.sound ? 1 : 0, hz = 180 + 1500 * seq.spin * Math.sqrt(S.thr);
  nGain.gain.setTargetAtTime(on * (0.6 * seq.run * (0.6 + 0.4 * S.thr) + 0.12 * seq.gg), t, 0.08);
  nLP.frequency.setTargetAtTime(120 + 800 * seq.run * S.thr + 150 * seq.gg, t, 0.1);
  wOsc.frequency.setTargetAtTime(hz, t, 0.1); wF.frequency.setTargetAtTime(hz, t, 0.1);
  wGain.gain.setTargetAtTime(on * 0.045 * seq.spin, t, 0.1);
}

// =====================================================================
// Resize + frame loop
// =====================================================================
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false); composer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  ptsU.uScale.value = h * Q.pr / (2 * Math.tan(camera.fov * DEG / 2));
  grade.uniforms.uRes.value.set(w, h);
  drawProfile(hoverI); drawAlt();
}
new ResizeObserver(resize).observe(stage);

const pv = new V3();
let last = performance.now(), time = 0, flowT = 0, spinA = 0, frameN = 0;
function frame(now) {
  const raw = (now - last) / 1000, dtR = Math.min(0.05, raw); last = now;
  // adaptive quality: judge each ~1 s window; under ~40 fps, render fewer pixels, then drop bloom as a last resort
  if (document.hidden) Q.t = Q.n = 0;
  else if (Q.warm > 0) Q.warm -= raw;
  else if ((Q.t += raw, ++Q.n, Q.t > 1)) {
    if (Q.t / Q.n > 1 / 40) {
      if (Q.pr > Q.min) { Q.pr = Math.max(Q.min, Q.pr * 0.75); renderer.setPixelRatio(Q.pr); composer.setPixelRatio(Q.pr); resize(); }
      else bloom.enabled = false;
      Q.warm = 0.4;
    }
    Q.t = Q.n = 0;
  }
  const sm = S.slow ? 0.22 : 1, dt = dtR * sm;
  time += dtR; frameN++;
  const wasPhase = seq.phase;
  stepSeq(dtR);

  spinA += dt * 7 * seq.spin * Math.sqrt(S.thr);
  for (const r of rotors) r.rotation.y = spinA;
  flowT += dt;
  updateParticles(dtR, sm);
  updateSmoke(dtR, sm);

  const run = seq.run, fl = 0.9 + 0.1 * Math.sin(time * 53) * Math.sin(time * 31);
  coreMat.uniforms.uFlowT.value = flowT; coreMat.uniforms.uGain.value = run * 0.2 * (0.5 + 0.5 * S.thr);
  plumeU.uTime.value = time; plumeU.uGain.value = run * P.gain * 0.22 * (0.55 + 0.45 * S.thr) * fl; plumeU.uFlash.value = seq.flash;
  plume.visible = run > 0.005;
  MAT.liner.emissiveIntensity = 0.1 * run;
  MAT.ext.emissiveIntensity = 0.07 * run * (0.5 + 0.5 * S.thr);
  MAT.inj.emissiveIntensity = 0.5 * seq.spin;
  chamberLight.color.setRGB(...(seq.flash > 0 ? [0.3, 1, 0.4] : [1, 0.5, 0.2]));
  chamberLight.intensity = (run * 0.9 + seq.flash * 2) * fl;
  exitLight.position.set(0, G.ye - 0.35, 0.2); exitLight.color.setRGB(P.flame[0] / 1.7, P.flame[1] / 1.7, P.flame[2] / 1.7);
  exitLight.intensity = run * 0.8 * P.gain * fl;
  ggLight.intensity = seq.gg * 1.4 * fl;
  if (ggGlow) ggGlow.material.color.setRGB(3 * seq.gg * fl, 0.9 * seq.gg * fl, 0.2 * seq.gg);
  grade.uniforms.uTime.value = time;

  if (tw) {
    tw.k = Math.min(1, tw.k + dtR / 1.4);
    const e = tw.k < 0.5 ? 4 * tw.k ** 3 : 1 - Math.pow(-2 * tw.k + 2, 3) / 2;
    camera.position.lerpVectors(tw.p0, tw.p1, e); controls.target.lerpVectors(tw.t0, tw.t1, e);
    if (tw.k >= 1) tw = null;
  }
  controls.update();

  if (S.labels) {
    const w = stage.clientWidth, h = stage.clientHeight;
    for (const k in hotEls) {
      pv.set(...HOT[k][1]()).project(camera);
      const el = hotEls[k], vis = pv.z < 1 && Math.abs(pv.x) < 1.05 && Math.abs(pv.y) < 1.05;
      el.style.visibility = vis ? 'visible' : 'hidden';
      if (vis) el.style.transform = `translate(${((pv.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-pv.y * 0.5 + 0.5) * h).toFixed(1)}px) translateY(-50%)`;
    }
  }
  if (capTimer > 0 && (capTimer -= dtR) <= 0) $('cap').classList.remove('on');
  if (dirty || seq.phase === 'start' || seq.phase === 'stop' || seq.phase !== wasPhase || frameN % 30 === 0) { updateReadouts(); dirty = false; }
  updateAudio();
  composer.render();
  requestAnimationFrame(frame);
}

// ---------- boot ----------
setGeom(S.eps);
buildProfile();
buildEngine();
setProp('rp1');
for (let i = 0; i < NC; i++) spawnC(i, true);
if (matchMedia('(max-width: 900px)').matches) $('tMin').click();
resize();
goStep(0, true);
requestAnimationFrame(frame);
})();
