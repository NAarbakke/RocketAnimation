// Canonical motor frame (metres): axis = +Y pointing forward, throat centre at the origin, nozzle exit at -Y.

export interface Preset {
  type: 'bates' | 'star' | 'finocyl' | 'endburner';
  R: number; L: number; y0: number;           // grain outer radius, length, aft face position
  segs: number; gap: number; core: number;    // bates / finocyl
  starN: number; starRi: number; starRo: number;
  fins: number; finR: number; finW: number; finFrac: number;
}

interface JobBase { bounds: [number, number, number, number, number, number]; voxels: number; inhibitFwd: boolean; inhibitAft: boolean; }
export type BurnJob = (JobBase & { kind: 'preset'; preset: Preset }) | (JobBase & { kind: 'mesh'; tris: Float32Array });

export interface BurnResult {
  h: number; ox: number; oy: number; oz: number; nx: number; ny: number; nz: number;
  wmax: number; dw: number; ab: Float32Array; volume: number;          // web thickness, Ab per web bin (m²), propellant volume
  tex: Uint8Array; tdims: [number, number, number]; texBox: [number, number, number, number, number, number];
  portR: Float32Array; yMin: number; yMax: number;                      // initial port radius per slice, grain axial extent
  minD: Float32Array; maxD: Float32Array;                               // per slice: web when it first opens up / is fully burned (-1: no propellant)
}

/** Everything the scene/physics needs about the hardware, from a preset or from a CAD model. */
export interface MotorGeom {
  source: 'preset' | 'cad';
  caseR: number; caseY0: number; caseY1: number;                        // case inner radius and axial extent
  nozzle: { y: Float32Array; r: Float32Array };                          // inner contour from entrance (top) to exit
  rt: number; re: number; ye: number;                                   // throat radius, exit radius, exit plane
  meop: number;                                                         // case max operating pressure, Pa
}
