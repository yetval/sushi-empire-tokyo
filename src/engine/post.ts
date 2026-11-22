// Post-processing: hand-inked outlines (+ depth AO on high), night bloom, filmic grade, vignette, grain.
// low = plain render (no composer); medium = ink + bloom + grade; high = medium + ambient occlusion.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

type Quality = 'low' | 'medium' | 'high';

const VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// Runs on linear HDR scene color with the scene depth buffer.
const InkShader = {
  defines: { AO_SAMPLES: 0 },
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    cameraNear: { value: 0.1 }, cameraFar: { value: 400 },
    projInv: { value: new THREE.Matrix4() },
    projYY: { value: 1 },
    uThick: { value: 1 },
    uInk: { value: 0.85 },
    uAO: { value: 0.85 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse, tDepth;
    uniform vec2 resolution;
    uniform float cameraNear, cameraFar, projYY, uThick, uInk, uAO;
    uniform mat4 projInv;
    varying vec2 vUv;
    float rawD(vec2 uv) { return texture2D(tDepth, uv).x; }
    float linZ(float d) { return -perspectiveDepthToViewZ(d, cameraNear, cameraFar); }
    vec3 viewPos(vec2 uv, float d) { vec4 p = projInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return p.xyz / p.w; }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      float d = rawD(vUv);
      if (d >= 1.0) { gl_FragColor = vec4(col, 1.0); return; } // sky
      vec2 px = uThick / resolution;
      float z0 = linZ(d);
      float zl = linZ(rawD(vUv - vec2(px.x, 0.0))), zr = linZ(rawD(vUv + vec2(px.x, 0.0)));
      float zd = linZ(rawD(vUv - vec2(0.0, px.y))), zu = linZ(rawD(vUv + vec2(0.0, px.y)));
      // silhouettes: a neighbour noticeably nearer than us -> line on the far side (1px, outside the object)
      float near = max(max(z0 - zl, z0 - zr), max(z0 - zd, z0 - zu)) / z0;
      float sil = smoothstep(0.03, 0.09, near);
      // creases: 1/z is linear across planes in screen space, so its laplacian only fires on folds
      float w0 = 1.0 / z0;
      float lap = (abs(1.0 / zl + 1.0 / zr - 2.0 * w0) + abs(1.0 / zd + 1.0 / zu - 2.0 * w0)) * z0;
      float crease = smoothstep(0.016, 0.05, lap) * 0.45;
      float fade = 1.0 - smoothstep(28.0, 85.0, z0);
      float edge = max(sil, crease) * fade * uInk;
      // colored ink: a warm, deep version of the surface beneath (reads hand-drawn, not black CAD lines)
      col = mix(col, col * vec3(0.30, 0.22, 0.20) + vec3(0.012, 0.006, 0.004), edge);
    #if AO_SAMPLES > 0
      vec3 P = viewPos(vUv, d);
      vec3 N = normalize(cross(dFdx(P), dFdy(P)));
      if (dot(N, P) > 0.0) N = -N;
      float rpx = clamp(0.55 * projYY * 0.5 * resolution.y / z0, 3.0, 48.0);
      float occ = 0.0, ang = hash(gl_FragCoord.xy) * 6.2831;
      for (int i = 0; i < AO_SAMPLES; i++) {
        float t = (float(i) + 0.5) / float(AO_SAMPLES);
        ang += 2.39996;
        vec2 suv = vUv + vec2(cos(ang), sin(ang)) * t * rpx / resolution;
        vec3 v = viewPos(suv, rawD(suv)) - P;
        occ += max(0.0, dot(v, N) - 0.015 * z0) / (dot(v, v) + 0.02);
      }
      float ao = clamp(1.0 - 1.6 * occ / float(AO_SAMPLES), 0.0, 1.0);
      ao = mix(1.0, ao, uAO * (1.0 - smoothstep(30.0, 70.0, z0)));
      col *= mix(vec3(0.62, 0.56, 0.68), vec3(1.0), ao); // cool violet contact shadows, painter style
    #endif
      gl_FragColor = vec4(col, 1.0);
    }`,
};

// Final pass: samples linear HDR, tone maps + sRGB-encodes each tap (replaces OutputPass), then grades in display space.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 }, uNight: { value: 0 }, uGrain: { value: 0.03 }, uVig: { value: 0.3 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float uTime, uNight, uGrain, uVig;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    // OutputPass folded in: tone map (renderer.toneMapping, injected by three when drawing to screen) + sRGB encode
    vec3 tex(vec2 uv) {
      vec3 c = texture2D(tDiffuse, uv).rgb;
    #ifdef TONE_MAPPING
      c = toneMapping(c);
    #endif
      return linearToOutputTexel(vec4(c, 1.0)).rgb;
    }
    void main() {
      vec3 c = tex(vUv);
      { // FXAA-lite: blend along the edge where local contrast is high
        vec2 t = 1.0 / resolution;
        float lN = luma(tex(vUv + vec2(0.0, t.y))), lS = luma(tex(vUv - vec2(0.0, t.y)));
        float lE = luma(tex(vUv + vec2(t.x, 0.0))), lW = luma(tex(vUv - vec2(t.x, 0.0)));
        float lM = luma(c);
        float range = max(max(max(lN, lS), max(lE, lW)), lM) - min(min(min(lN, lS), min(lE, lW)), lM);
        if (range > max(0.05, 0.12 * max(max(lN, lS), max(lE, lW)))) {
          vec2 dir = vec2(lS - lN, lE - lW);
          dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + 0.06), -2.0, 2.0) * t;
          vec3 a = 0.5 * (tex(vUv - dir * 0.17) + tex(vUv + dir * 0.17));
          vec3 b = 0.5 * a + 0.25 * (tex(vUv - dir * 0.5) + tex(vUv + dir * 0.5));
          float lb = luma(b);
          c = (lb < min(min(lN, lS), min(lE, lW)) || lb > max(max(lN, lS), max(lE, lW))) ? a : b;
        }
      }
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // teal-orange split tone, cooler shadows at night
      vec3 shadowT = mix(vec3(0.94, 1.0, 1.05), vec3(0.86, 0.95, 1.12), uNight);
      vec3 highT = mix(vec3(1.03, 1.0, 0.95), vec3(1.06, 0.99, 0.91), uNight);
      c *= mix(shadowT, highT, smoothstep(0.12, 0.8, l));
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.22); // gentle S-curve
      c = mix(vec3(l), c, 1.05);                   // a touch more saturation
      c += vec3(0.012, 0.008, 0.0) * (1.0 - l);    // warm paper lift in the blacks
      vec2 q = (vUv - 0.5) * vec2(resolution.x / resolution.y, 1.0);
      c *= 1.0 - uVig * smoothstep(0.35, 1.05, length(q));
      c += (hash(vUv * resolution + fract(uTime) * 917.0) - 0.5) * uGrain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

export interface Post {
  render(): void;
  setSize(w: number, h: number): void;
  setQuality(q: Quality): void;
  setNight(n: number): void;
}

export function createPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): Post {
  let quality: Quality = 'high';
  let w = innerWidth, h = innerHeight;
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0 });
  rt.depthTexture = new THREE.DepthTexture(1, 1);
  const composer = new EffectComposer(renderer, rt);
  // both ping-pong targets need their own depth texture (RenderPass draws into whichever is readBuffer)
  composer.renderTarget2.depthTexture ??= new THREE.DepthTexture(1, 1);
  const ink = new ShaderPass(InkShader);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.15, 0.55, 0.95);
  const grade = new ShaderPass(GradeShader);
  // bloom is soft by nature: its mip chain starts at half res on high, quarter res on medium
  const bloomSize = bloom.setSize.bind(bloom);
  bloom.setSize = (bw: number, bh: number) => { const d = quality === 'high' ? 2 : 4; bloomSize(Math.max(1, Math.round(bw / d)), Math.max(1, Math.round(bh / d))); };
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(ink);
  composer.addPass(bloom);
  composer.addPass(grade);
  const start = performance.now();

  function resize(): void {
    // post runs at ≤1.5x DPR (retina 2x would quadruple every fullscreen pass). No MSAA: it cost ~6ms here;
    // the grade pass does FXAA-lite instead.
    const pr = Math.min(renderer.getPixelRatio(), 1.5);
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    ink.uniforms.resolution.value.set(w * pr, h * pr);
    grade.uniforms.resolution.value.set(w * pr, h * pr);
    ink.uniforms.uThick.value = Math.max(1, (h * pr) / 900);
  }

  const post: Post = {
    render() {
      if (quality === 'low') { renderer.render(scene, camera); return; }
      const u = ink.uniforms;
      u.tDepth.value = composer.readBuffer.depthTexture; // RenderPass draws into readBuffer this frame
      u.cameraNear.value = camera.near; u.cameraFar.value = camera.far;
      u.projInv.value.copy(camera.projectionMatrixInverse);
      u.projYY.value = camera.projectionMatrix.elements[5];
      grade.uniforms.uTime.value = (performance.now() - start) / 1000;
      composer.render();
    },
    setSize(nw, nh) { w = nw; h = nh; resize(); },
    setQuality(q) {
      quality = q;
      (ink.material as THREE.ShaderMaterial).defines.AO_SAMPLES = q === 'high' ? 4 : 0;
      ink.material.needsUpdate = true;
      resize();
    },
    setNight(n) {
      // day: only truly emissive pixels (sunlit white shirts reach ~2) bloom; night: lanterns and neon glow
      bloom.enabled = n > 0.12; // daytime threshold would reject everything anyway: skip the cost
      bloom.strength = 0.18 + 0.62 * n;
      bloom.threshold = 2.2 - 1.1 * n; // stays above 1.0 at night so interiors/bubbles don't milk out
      grade.uniforms.uNight.value = n;
      grade.uniforms.uVig.value = 0.28 + 0.12 * n;
    },
  };
  resize();
  return post;
}
