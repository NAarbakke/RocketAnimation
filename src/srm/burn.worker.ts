// Grain burn-back: voxelize the propellant, find the gas-exposed surfaces, and take a 3-D Euclidean
// distance transform from them. Distance = web burned when the flame front reaches that point
// (propellant regresses normal to its surface at one rate everywhere), so:
//   burning area Ab(w) = dV/dw from a histogram of distances, and the render texture is the same field.
import type { BurnJob, BurnResult, Preset } from './types';

const INF = 1e20;

function edt1d(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array) {
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}

/** Squared distance (voxel units) to the nearest zero, Felzenszwalb & Huttenlocher, separable over x, y, z. */
function edt3d(g: Float32Array, nx: number, ny: number, nz: number) {
  const m = Math.max(nx, ny, nz), f = new Float32Array(m), d = new Float32Array(m), v = new Int32Array(m), z = new Float32Array(m + 1);
  const pass = (n: number, stride: number, starts: number[]) => {
    for (const s0 of starts) {
      for (let q = 0; q < n; q++) f[q] = g[s0 + q * stride];
      edt1d(f, n, d, v, z);
      for (let q = 0; q < n; q++) g[s0 + q * stride] = d[q];
    }
  };
  const sx: number[] = [], sy: number[] = [], sz: number[] = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) sx.push(nx * (j + ny * k));
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) sy.push(i + nx * ny * k);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sz.push(i + nx * j);
  pass(nx, 1, sx); pass(ny, nx, sy); pass(nz, nx * ny, sz);
}

// ---------- analytic presets ----------
function starRadius(x: number, z: number, n: number, ri: number, ro: number) {
  const th = (Math.atan2(z, x) + 2 * Math.PI) % (2 * Math.PI), seg = Math.PI / n, k = Math.floor(th / seg);
  const r1 = k % 2 === 0 ? ro : ri, r2 = k % 2 === 0 ? ri : ro, a1 = k * seg, a2 = a1 + seg;
  const p1x = r1 * Math.cos(a1), p1z = r1 * Math.sin(a1), ex = r2 * Math.cos(a2) - p1x, ez = r2 * Math.sin(a2) - p1z;
  const dx = Math.cos(th), dz = Math.sin(th);
  return (p1x * ez - p1z * ex) / (dx * ez - dz * ex); // where the ray at angle th meets the star edge
}
function presetInside(p: Preset, x: number, y: number, z: number) {
  const r = Math.hypot(x, z), yy = y - p.y0;
  if (r >= p.R || yy < 0 || yy > p.L) return false;
  switch (p.type) {
    case 'bates': {
      const seg = (p.L - (p.segs - 1) * p.gap) / p.segs, m = yy % (seg + p.gap);
      return m <= seg && r >= p.core;
    }
    case 'star': return r >= starRadius(x, z, p.starN, p.starRi, p.starRo);
    case 'finocyl': {
      if (r < p.core) return false;
      if (yy < p.finFrac * p.L) for (let k = 0; k < p.fins; k++) {
        const a = (k / p.fins) * 2 * Math.PI, u = x * Math.cos(a) + z * Math.sin(a), v = -x * Math.sin(a) + z * Math.cos(a);
        if (u > 0 && u < p.finR && Math.abs(v) < p.finW / 2) return false;
      }
      return true;
    }
    default: return true; // end-burner
  }
}

// ---------- mesh voxelization: parity of crossings along y for every (x, z) column ----------
function voxelizeMesh(tris: Float32Array, P: Uint8Array, nx: number, ny: number, nz: number, h: number, ox: number, oy: number, oz: number) {
  const cols: number[][] = Array.from({ length: nx * nz }, () => []);
  const jx = 1.3e-4 * h, jz = 2.7e-4 * h; // nudge off exact edges/vertices
  for (let t = 0; t < tris.length; t += 9) {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2], bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5], cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8];
    const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(den) < 1e-14) continue; // edge-on in projection: no crossing
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - ox) / h - 0.5)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - ox) / h - 0.5));
    const k0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - oz) / h - 0.5)), k1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) - oz) / h - 0.5));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const px = ox + (i + 0.5) * h + jx, pz = oz + (k + 0.5) * h + jz;
      const w1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den, w2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den, w3 = 1 - w1 - w2;
      if (w1 < 0 || w2 < 0 || w3 < 0) continue;
      cols[i + nx * k].push(w1 * ay + w2 * by + w3 * cy);
    }
  }
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const c = cols[i + nx * k];
    if (c.length < 2) continue;
    c.sort((a, b) => a - b);
    for (let e = 0; e + 1 < c.length; e += 2) {
      const j0 = Math.max(0, Math.ceil((c[e] - oy) / h - 0.5)), j1 = Math.min(ny - 1, Math.floor((c[e + 1] - oy) / h - 0.5));
      for (let j = j0; j <= j1; j++) P[i + nx * (j + ny * k)] = 1;
    }
  }
}

function run(job: BurnJob): BurnResult {
  const b = job.bounds, pad = 3;
  const vol = (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]);
  const h = Math.max(0.0015, Math.cbrt(vol / job.voxels));
  const ox = b[0] - pad * h, oy = b[1] - pad * h, oz = b[2] - pad * h;
  const nx = Math.ceil((b[3] - b[0]) / h) + 2 * pad, ny = Math.ceil((b[4] - b[1]) / h) + 2 * pad, nz = Math.ceil((b[5] - b[2]) / h) + 2 * pad;
  const N = nx * ny * nz, P = new Uint8Array(N);
  if (job.kind === 'preset') {
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
      if (presetInside(job.preset, ox + (i + 0.5) * h, oy + (j + 0.5) * h, oz + (k + 0.5) * h)) P[i + nx * (j + ny * k)] = 1;
  } else voxelizeMesh(job.tris, P, nx, ny, nz, h, ox, oy, oz);

  // per-slice port (min) and bond (max) radius of the propellant
  const portR = new Float32Array(ny).fill(-1), outR = new Float32Array(ny).fill(-1);
  let jMin = ny, jMax = -1, count = 0;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!P[i + nx * (j + ny * k)]) continue;
    const r = Math.hypot(ox + (i + 0.5) * h, oz + (k + 0.5) * h);
    if (portR[j] < 0 || r < portR[j]) portR[j] = r;
    if (r > outR[j]) outR[j] = r;
    jMin = Math.min(jMin, j); jMax = Math.max(jMax, j); count++;
  }
  if (!count) throw new Error('No propellant found: check the grain mesh is a closed solid inside the motor.');
  let last = outR[jMin];
  for (let j = jMin; j <= jMax; j++) { if (outR[j] > 0) last = outR[j]; else outR[j] = last; } // gaps between segments
  // gas: empty space inside the bonded radius, within the grain's length (plus exposed end faces)
  const g = new Float32Array(N), gas = new Uint8Array(N);
  const jLo = job.inhibitAft ? jMin : 0, jHi = job.inhibitFwd ? jMax : ny - 1;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
    const rb = (outR[Math.min(jMax, Math.max(jMin, j))] || 0) - 1.5 * h;
    for (let i = 0; i < nx; i++) {
      const id = i + nx * (j + ny * k);
      const isGas = !P[id] && j >= jLo && j <= jHi && Math.hypot(ox + (i + 0.5) * h, oz + (k + 0.5) * h) < rb;
      gas[id] = isGas ? 1 : 0;
      g[id] = isGas ? 0 : INF;
    }
  }
  edt3d(g, nx, ny, nz);

  let wmax = 0;
  for (let id = 0; id < N; id++) if (P[id]) { const d = Math.max(0, Math.sqrt(g[id]) - 0.5) * h; g[id] = d; if (d > wmax) wmax = d; }
  const minD = new Float32Array(ny).fill(-1), maxD = new Float32Array(ny).fill(-1);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const id = i + nx * (j + ny * k);
    if (!P[id]) continue;
    if (minD[j] < 0 || g[id] < minD[j]) minD[j] = g[id];
    if (g[id] > maxD[j]) maxD[j] = g[id];
  }
  // Ab(w) = dV/dw. Voxel distances are discrete (√integers), so difference the burned volume over ±1 voxel
  const nb = 160, dw = wmax / nb, fine = 4000, fdw = wmax / fine, cum = new Float64Array(fine + 2);
  for (let id = 0; id < N; id++) if (P[id]) cum[Math.min(fine, Math.floor(g[id] / fdw)) + 1]++;
  for (let i = 1; i < cum.length; i++) cum[i] += cum[i - 1];
  const V = (w: number) => cum[Math.min(fine + 1, Math.max(0, Math.floor(w / fdw)))] * h * h * h; // volume burned when web = w
  const ab = new Float32Array(nb);
  const raw = new Float32Array(nb);
  for (let k = 0; k < nb; k++) { const w = (k + 0.5) * dw, lo = Math.max(0, w - 1.5 * h), hi = Math.min(wmax + fdw, w + 1.5 * h); raw[k] = (V(hi) - V(lo)) / (hi - lo); }
  for (let k = 0; k < nb; k++) { let s = 0, n = 0; for (let q = Math.max(0, k - 3); q <= Math.min(nb - 1, k + 3); q++) { s += raw[q]; n++; } ab[k] = s / n; }

  // render texture (RG8): R = 1 + 254·d/wmax inside propellant (0 outside), G = initially gas
  const s = Math.max(1, Math.ceil(Math.max(nx, ny, nz) / 200));
  const tx = Math.ceil(nx / s), ty = Math.ceil(ny / s), tz = Math.ceil(nz / s), tex = new Uint8Array(tx * ty * tz * 2);
  for (let k = 0; k < tz; k++) for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
    let r = 0, gg = 0, n = 0;
    for (let c = 0; c < s; c++) for (let bj = 0; bj < s; bj++) for (let a = 0; a < s; a++) {
      const ii = i * s + a, jj = j * s + bj, kk = k * s + c;
      if (ii >= nx || jj >= ny || kk >= nz) continue;
      const id = ii + nx * (jj + ny * kk); n++;
      if (P[id]) r += 1 + 254 * Math.min(1, g[id] / wmax); else if (gas[id]) gg += 255;
    }
    const o = (i + tx * (j + ty * k)) * 2; tex[o] = Math.round(r / n); tex[o + 1] = Math.round(gg / n);
  }
  return {
    h, ox, oy, oz, nx, ny, nz, wmax, dw, ab, volume: count * h * h * h, tex, tdims: [tx, ty, tz], texBox: [ox, oy, oz, ox + tx * s * h, oy + ty * s * h, oz + tz * s * h],
    portR, minD, maxD, yMin: oy + jMin * h, yMax: oy + (jMax + 1) * h,
  };
}

self.onmessage = (e: MessageEvent<BurnJob & { id: number }>) => {
  try {
    const r = run(e.data);
    (self as unknown as Worker).postMessage({ id: e.data.id, ok: true, r }, [r.ab.buffer, r.tex.buffer, r.portR.buffer, r.minD.buffer, r.maxD.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: e.data.id, ok: false, error: String((err as Error).message || err) });
  }
};
