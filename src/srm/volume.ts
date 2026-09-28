// Grain renderer: raymarches the burn-distance texture. Propellant is wherever distance > web burned,
// so advancing one uniform regresses the whole grain. Writes real depth so case/nozzle meshes composite.
import * as THREE from 'three';
import type { BurnResult } from './types';

export function createGrainVolume(res: BurnResult) {
  const [tx, ty, tz] = res.tdims, b = res.texBox;
  const tex = new THREE.Data3DTexture(res.tex as unknown as BufferSource, tx, ty, tz);
  tex.format = THREE.RGFormat; tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.unpackAlignment = 1; tex.needsUpdate = true;
  const size = new THREE.Vector3(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
  const U = {
    uTex: { value: tex }, uDims: { value: new THREE.Vector3(tx, ty, tz) }, uScale: { value: size.clone() },
    uCam: { value: new THREE.Vector3() }, uThr: { value: 1 / 255 }, uCutU: { value: (0 - b[0]) / size.x }, uCut: { value: 1 },
    uGlow: { value: 0 }, uFront: { value: 0 }, uIso: { value: 8 }, uTime: { value: 0 },
    uAlb: { value: new THREE.Color() }, uFlame: { value: new THREE.Vector3(2.4, 1.3, 0.5) }, uMVP: { value: new THREE.Matrix4() },
  };
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms: U, side: THREE.BackSide, depthTest: true, depthFunc: THREE.AlwaysDepth, depthWrite: true, // depth test must stay on or GL skips depth writes
    vertexShader: `out vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      precision highp sampler3D;
      uniform sampler3D uTex; uniform vec3 uDims, uScale, uCam, uAlb, uFlame; uniform mat4 uMVP;
      uniform float uThr, uCutU, uCut, uGlow, uFront, uIso, uTime;
      in vec3 vPos;
      out vec4 fragOut;
      vec2 S(vec3 p){ return textureLod(uTex, p, 0.0).rg; } // explicit LOD: implicit derivatives break inside loops on ANGLE/D3D
      void main(){
        vec3 ro = uCam + 0.5, rd = normalize(vPos + 0.5 - ro);
        vec3 inv = 1.0/rd, t0 = -ro*inv, t1 = (1.0 - ro)*inv, mn = min(t0, t1), mx = max(t0, t1);
        float ta = max(max(max(mn.x, mn.y), mn.z), 0.0), tb = min(min(mx.x, mx.y), mx.z);
        bool cutEntry = false;
        if (uCut > 0.5) {                       // keep the u <= uCutU half (x <= 0 in the world)
          float tc = (uCutU - ro.x)/rd.x;
          if (ro.x + rd.x*ta > uCutU) { if (rd.x >= 0.0) discard; if (tc > ta) { ta = tc; cutEntry = true; } }
          else if (rd.x > 0.0) tb = min(tb, tc);
        }
        if (ta >= tb) discard;
        float dt = 0.7/length(rd*uDims), wl = length(rd*uScale)*dt;
        float t = ta; vec3 glow = vec3(0.0); float prevG = 0.0; bool hit = false;
        for (int i = 0; i < 700; i++) {
          vec2 s = S(ro + rd*t);
          if (s.r > uThr) { hit = true; break; }
          float g = max(s.g, step(0.5/255.0, s.r));  // gas: port space, or propellant that has already burned
          glow += g*wl; prevG = g;
          t += dt; if (t > tb) break;
        }
        if (!hit) discard;
        float lo = max(ta, t - dt), hi = t;             // refine the surface crossing
        for (int k = 0; k < 5; k++) { float m = 0.5*(lo + hi); if (S(ro + rd*m).r > uThr) hi = m; else lo = m; }
        vec3 p = ro + rd*hi;
        vec3 e = 1.0/uDims, n;
        bool face = cutEntry && hi - ta < dt*1.5;
        if (face) n = vec3(1.0, 0.0, 0.0);
        else n = -normalize(vec3(S(p+vec3(e.x,0,0)).r - S(p-vec3(e.x,0,0)).r, S(p+vec3(0,e.y,0)).r - S(p-vec3(0,e.y,0)).r, S(p+vec3(0,0,e.z)).r - S(p-vec3(0,0,e.z)).r)/uScale);
        vec3 L = normalize(vec3(0.6, 0.7, 0.4)), V = -normalize(rd*uScale);
        float dif = max(dot(n, L), 0.0), hl = max(dot(n, V), 0.0);
        vec3 col = uAlb*(0.18 + 0.55*dif + 0.35*hl);
        if (face) {                                  // cut face: contours of where the flame front will be
          float web = (S(p).r*255.0 - 1.0)/254.0;
          float c = abs(fract(web*uIso) - 0.5);
          col *= 0.85 + 0.15*smoothstep(0.0, 0.08, c);
        }
        float front = prevG > 0.5 && !face ? 1.0 : 0.0;
        float flick = 0.85 + 0.15*sin(uTime*40.0 + p.y*80.0);
        col += uFlame*front*uFront*flick;
        col += uFlame*glow*uGlow*0.6;
        fragOut = vec4(col, 1.0);
        vec4 clip = uMVP*vec4(p - 0.5, 1.0);
        gl_FragDepth = clamp(clip.z/clip.w*0.5 + 0.5, 0.0, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  mesh.scale.copy(size);
  mesh.position.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
  mesh.renderOrder = -1; mesh.frustumCulled = false;
  const inv = new THREE.Matrix4();
  mesh.onBeforeRender = (_r, _s, cam) => {
    mesh.updateMatrixWorld();
    inv.copy(mesh.matrixWorld).invert();
    U.uCam.value.copy(cam.position).applyMatrix4(inv);
    U.uMVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).multiply(mesh.matrixWorld);
  };
  return {
    mesh, uniforms: U,
    setWeb(w: number) { U.uThr.value = (1 + (254 * Math.min(w, res.wmax * 1.01)) / res.wmax) / 255; },
    dispose() { tex.dispose(); mesh.geometry.dispose(); mat.dispose(); },
  };
}
