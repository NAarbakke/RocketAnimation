// Exhaust plume: an additive shell whose radius follows the expansion state (pe/pa), with shock diamonds.
import * as THREE from 'three';
import { NOISE } from './stage';

export interface PlumeLook { core: number[]; flame: number[]; disk: number[]; }

export function createPlume() {
  const U = {
    uTime: { value: 0 }, uLen: { value: 3 }, uRe: { value: 0.5 }, uA1: { value: 0 }, uA2: { value: 0 }, uAmp: { value: 0 }, uCell: { value: 3 },
    uWob: { value: 0 }, uGain: { value: 0 }, uFlash: { value: 0 }, uCore: { value: new THREE.Vector3() }, uFlame: { value: new THREE.Vector3() }, uDisk: { value: new THREE.Vector3() },
  };
  const R = `uniform float uRe, uA1, uA2, uAmp, uCell;
    float plumeR(float x){ return uRe*max(0.2, (1.0 + uA1*(1.0-exp(-x/1.5)) + uA2*x)*(1.0 + uAmp*sin(6.2832*x/uCell)*exp(-x/(uCell*3.0)))); }`;
  const geo = new THREE.CylinderGeometry(1, 1, 1, 40, 90, true); geo.translate(0, -0.5, 0);
  const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms: U, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: NOISE + R + `
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
        col = mix(col, vec3(2.0, 1.9, 1.6)*body*fall*2.0, uFlash);
        gl_FragColor = vec4(min(col*uGain, vec3(3.0)), 1.0);
      }`,
  }));
  mesh.frustumCulled = false;
  const S = { len: 3, re: 0.5, a1: 0, a2: 0, amp: 0, cell: 3 };
  return {
    mesh, uniforms: U, shape: S,
    /** Plume radius at x exit-radii downstream (mirrors the shader, for particles). */
    radiusAt: (x: number) => S.re * Math.max(0.2, (1 + S.a1 * (1 - Math.exp(-x / 1.5)) + S.a2 * x) * (1 + S.amp * Math.sin((2 * Math.PI * x) / S.cell) * Math.exp(-x / (S.cell * 3)))),
    /** Shape from the expansion state: re = jet radius where it leaves the wall, Me = exit Mach, len = visible length. */
    set(o: { pe: number; pa: number; re: number; Me: number; len: number; sep: boolean; look: PlumeLook }) {
      const lk = o.pa < 1 ? 3 : Math.min(3, Math.max(-1, Math.log10(o.pe / o.pa)));
      S.re = o.re; S.a1 = lk > 0 ? 0.45 * lk : 0.35 * lk; S.a2 = 0.04 + 0.1 * Math.max(lk, 0);
      S.amp = (0.08 + 0.14 * Math.min(Math.abs(lk), 1)) * (lk >= 0 ? 1 : -1) * Math.min(1, o.pa / 5000);
      S.cell = 1.1 * Math.sqrt(Math.max(o.Me * o.Me - 1, 0.5)) * (1 + Math.max(lk, 0) * 0.5);
      S.len = o.len * (1 + 0.25 * Math.max(lk, 0));
      U.uRe.value = S.re; U.uA1.value = S.a1; U.uA2.value = S.a2; U.uAmp.value = S.amp; U.uCell.value = S.cell; U.uLen.value = S.len; U.uWob.value = o.sep ? 1 : 0;
      U.uCore.value.set(o.look.core[0], o.look.core[1], o.look.core[2]); U.uFlame.value.set(o.look.flame[0], o.look.flame[1], o.look.flame[2]); U.uDisk.value.set(o.look.disk[0], o.look.disk[1], o.look.disk[2]);
    },
  };
}
