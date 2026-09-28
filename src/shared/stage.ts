// Renderer + post stack shared by the labs: HDR target, half-res bloom, ACES grade, adaptive render scale.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export const lin = (hex: number) => new THREE.Color(hex).convertSRGBToLinear();

export interface Stage {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
  bloom: UnrealBloomPass; pr: () => number; size: () => [number, number];
  onResize: (fn: () => void) => void; render: (rawDt: number, time: number) => void;
}

export function createStage(canvas: HTMLCanvasElement, host: HTMLElement): Stage | null {
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }); }
  catch { return null; }
  // render scale starts at ≤1.25× and steps down while frames run slow (integrated GPUs); bloom goes last
  const Q = { pr: Math.min(devicePixelRatio || 1, 1.25), min: 0.5, t: 0, n: 0, warm: 1.5 };
  renderer.setPixelRatio(Q.pr);
  const scene = new THREE.Scene();
  scene.background = lin(0x06080d);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.02, 200);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 0.4; controls.maxDistance = 16; controls.zoomSpeed = 0.7;
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;

  // no MSAA: resolving a multisampled float target cost ~10 ms/frame on Intel UHD; the render scale smooths edges instead
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
  composer.setPixelRatio(Q.pr);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 0.9);
  const setBloom = bloom.setSize.bind(bloom);
  bloom.setSize = (w: number, h: number) => setBloom(Math.ceil(w / 2), Math.ceil(h / 2)); // half-res glow
  composer.addPass(bloom);
  const grade = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) } },
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
      }`,
  });
  composer.addPass(grade);

  const hooks: (() => void)[] = [];
  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false); composer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    grade.uniforms.uRes.value.set(w, h);
    hooks.forEach(f => f());
  };
  new ResizeObserver(resize).observe(host);

  return {
    renderer, scene, camera, controls, bloom,
    pr: () => Q.pr,
    size: () => [host.clientWidth, host.clientHeight],
    onResize: fn => { hooks.push(fn); resize(); },
    render(raw, time) {
      // judge ~1 s windows; under ~40 fps render fewer pixels, then drop bloom
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
      grade.uniforms.uTime.value = time;
      composer.render();
    },
  };
}

export const NOISE = `
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
