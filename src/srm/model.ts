// CAD import: load a GLB, find parts by name, move it into the canonical motor frame and measure it.
// Contract: parts named grain* (closed solids, required) and nozzle* (required); case*, insulation*,
// forward_closure*, igniter* optional. Any axis orientation and mm or m units.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MotorGeom } from './types';

export const ROLES = ['grain', 'nozzle', 'case', 'insulation', 'liner', 'forward_closure', 'closure', 'igniter'] as const;
export type Role = (typeof ROLES)[number] | 'other';

export interface Manifest { units?: 'm' | 'mm'; inhibit?: ('forward' | 'aft')[]; meop_MPa?: number; grain?: string; }
export interface CadMotor {
  root: THREE.Group; parts: { mesh: THREE.Mesh; role: Role }[]; grainTris: Float32Array;
  bounds: [number, number, number, number, number, number]; geom: MotorGeom; manifest: Manifest;
}

const roleOf = (o: THREE.Object3D | null): Role => {
  for (let n = o; n; n = n.parent) {
    const s = (n.name || '').toLowerCase();
    const r = ROLES.find(r => s.startsWith(r));
    if (r) return r;
  }
  return 'other';
};

function trisOf(meshes: THREE.Mesh[], M: THREE.Matrix4): Float32Array {
  const out: number[] = [], v = new THREE.Vector3(), m = new THREE.Matrix4();
  for (const mesh of meshes) {
    m.multiplyMatrices(M, mesh.matrixWorld);
    const g = mesh.geometry, p = g.attributes.position, idx = g.index;
    const n = idx ? idx.count : p.count;
    for (let i = 0; i < n; i++) { v.fromBufferAttribute(p, idx ? idx.getX(i) : i).applyMatrix4(m); out.push(v.x, v.y, v.z); }
  }
  return Float32Array.from(out);
}

/** Smallest distance from the y axis of the surface cut by the plane y = s, for each station s. */
export function innerRadius(tris: Float32Array, ys: Float32Array): Float32Array {
  const r = new Float32Array(ys.length).fill(Infinity);
  const y0 = ys[0], dy = (ys[ys.length - 1] - y0) / (ys.length - 1);
  for (let t = 0; t < tris.length; t += 9) {
    const P = [0, 3, 6].map(o => [tris[t + o], tris[t + o + 1], tris[t + o + 2]]);
    const lo = Math.min(P[0][1], P[1][1], P[2][1]), hi = Math.max(P[0][1], P[1][1], P[2][1]);
    let i0 = Math.ceil((lo - y0) / dy), i1 = Math.floor((hi - y0) / dy);
    if (dy < 0) [i0, i1] = [Math.ceil((hi - y0) / dy), Math.floor((lo - y0) / dy)];
    for (let i = Math.max(0, i0); i <= Math.min(ys.length - 1, i1); i++) {
      const s = ys[i];
      for (let e = 0; e < 3; e++) {
        const a = P[e], b = P[(e + 1) % 3];
        if ((a[1] - s) * (b[1] - s) > 0 || a[1] === b[1]) continue;
        const f = (s - a[1]) / (b[1] - a[1]), x = a[0] + (b[0] - a[0]) * f, z = a[2] + (b[2] - a[2]) * f;
        const d = Math.hypot(x, z); if (d < r[i]) r[i] = d;
      }
    }
  }
  return r;
}

export async function loadCad(url: string, manifestUrl: string): Promise<CadMotor> {
  const [gltf, manifest] = await Promise.all([
    new GLTFLoader().loadAsync(url),
    fetch(manifestUrl, { cache: 'no-store' }).then(r => (r.ok ? r.json() : {})).catch(() => ({})) as Promise<Manifest>,
  ]);
  const scene = gltf.scene; scene.updateMatrixWorld(true);
  const parts: CadMotor['parts'] = [];
  scene.traverse(o => { if ((o as THREE.Mesh).isMesh) parts.push({ mesh: o as THREE.Mesh, role: roleOf(o) }); });
  const grains = parts.filter(p => p.role === 'grain').map(p => p.mesh), nozzles = parts.filter(p => p.role === 'nozzle').map(p => p.mesh);
  if (!grains.length) throw new Error('No part named “grain…” in the model.');
  if (!nozzles.length) throw new Error('No part named “nozzle…” in the model.');

  const box = (ms: THREE.Mesh[]) => ms.reduce((b, m) => b.union(new THREE.Box3().setFromObject(m)), new THREE.Box3());
  const all = box(parts.map(p => p.mesh)), size = all.getSize(new THREE.Vector3());
  const scale = manifest.units === 'mm' || (!manifest.units && Math.max(size.x, size.y, size.z) > 30) ? 0.001 : 1;
  // axis: from nozzle towards grain = forward = +Y
  const cg = box(grains).getCenter(new THREE.Vector3()), cn = box(nozzles).getCenter(new THREE.Vector3());
  const fwd = cg.clone().sub(cn).normalize();
  const M = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(fwd, new THREE.Vector3(0, 1, 0)));
  M.premultiply(new THREE.Matrix4().makeScale(scale, scale, scale));
  // centre the nozzle on the axis, then put the throat at y = 0
  let nt = trisOf(nozzles, M);
  const nb = new THREE.Box3().setFromArray(nt), nc = nb.getCenter(new THREE.Vector3());
  M.premultiply(new THREE.Matrix4().makeTranslation(-nc.x, 0, -nc.z));
  nt = trisOf(nozzles, M);
  const n = 220, ys = new Float32Array(n);
  const top = nb.max.y - 1e-4, bot = nb.min.y + 1e-4;
  for (let i = 0; i < n; i++) ys[i] = top + ((bot - top) * i) / (n - 1);
  const rs = innerRadius(nt, ys);
  let it = 0; for (let i = 0; i < n; i++) if (rs[i] < rs[it]) it = i;
  const yt = ys[it];
  M.premultiply(new THREE.Matrix4().makeTranslation(0, -yt, 0));
  for (let i = 0; i < n; i++) ys[i] -= yt;

  const root = new THREE.Group();
  root.add(scene); root.matrixAutoUpdate = false; root.matrix.copy(M); root.updateMatrixWorld(true);
  const grainTris = trisOf(grains, M), gb = new THREE.Box3().setFromArray(grainTris);
  const casePart = parts.filter(p => p.role === 'case').map(p => p.mesh);
  let caseR = Math.max(gb.max.x, gb.max.z), caseY0 = gb.min.y, caseY1 = gb.max.y;
  if (casePart.length) {
    const ct = trisOf(casePart, M), cb = new THREE.Box3().setFromArray(ct);
    const cr = innerRadius(ct, Float32Array.of((gb.min.y + gb.max.y) / 2, (gb.min.y + gb.max.y) / 2 + 1e-3))[0];
    if (isFinite(cr)) caseR = cr;
    caseY0 = cb.min.y; caseY1 = cb.max.y;
  }
  const valid = Array.from(rs).map((r, i) => [ys[i], r]).filter(([, r]) => isFinite(r));
  return {
    root, parts, grainTris, manifest,
    bounds: [gb.min.x, gb.min.y, gb.min.z, gb.max.x, gb.max.y, gb.max.z],
    geom: {
      source: 'cad', caseR, caseY0, caseY1,
      nozzle: { y: Float32Array.from(valid.map(v => v[0])), r: Float32Array.from(valid.map(v => v[1])) },
      rt: rs[it], re: valid[valid.length - 1][1], ye: valid[valid.length - 1][0],
      meop: (manifest.meop_MPa ?? 10) * 1e6,
    },
  };
}
