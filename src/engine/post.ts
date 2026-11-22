// Post-processing for the "architect's model" look: soft studio ambient occlusion (GTAO, high only), night-only bloom
// for neon, tilt-shift depth of field on high overview cameras, then one final pass that tone maps, FXAAs, grades and
// vignettes. No ink outlines: the model reads through AO, soft shadows and bevel highlights.
//   low    = plain render, no post
//   medium = scene -> [bloom at night] -> [tilt-shift when high up] -> grade
//   high   = medium + half-res GTAO (depth-only: normals reconstructed, no extra scene render)
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';

type Quality = 'low' | 'medium' | 'high';

const VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Half-res separable blur for the tilt-shift layer. Applies AO on the first (horizontal) pass so blurred areas keep it.
const BlurShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null }, tAO: { value: null as THREE.Texture | null },
    uAO: { value: 0 }, uDir: { value: new THREE.Vector2(1, 0) },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse, tAO; uniform float uAO; uniform vec2 uDir; varying vec2 vUv;
    vec3 s(vec2 uv) { return texture2D(tDiffuse, uv).rgb * mix(1.0, texture2D(tAO, uv).r, uAO); }
    void main() {
      // 9-tap gaussian, taps spaced 1.5 texels: ~7px radius at half res (~14px on screen)
      vec3 c = s(vUv) * 0.2270;
      c += (s(vUv + uDir * 1.5) + s(vUv - uDir * 1.5)) * 0.1946;
      c += (s(vUv + uDir * 3.0) + s(vUv - uDir * 3.0)) * 0.1216;
      c += (s(vUv + uDir * 4.5) + s(vUv - uDir * 4.5)) * 0.0541;
      c += (s(vUv + uDir * 6.0) + s(vUv - uDir * 6.0)) * 0.0162;
      gl_FragColor = vec4(c / 0.8354, 1.0);
    }`,
};

// Final pass: linear HDR in -> AO multiply -> tone map + sRGB (renderer.toneMapping) -> FXAA-lite -> tilt-shift mix -> grade.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null }, tAO: { value: null as THREE.Texture | null },
    tBlur: { value: null as THREE.Texture | null }, tDepth: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) }, cameraNear: { value: 0.1 }, cameraFar: { value: 400 },
    uAO: { value: 0 }, uTilt: { value: 0 }, uTime: { value: 0 }, uNight: { value: 0 }, uVig: { value: 0.18 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */ `
    #include <packing>
    uniform sampler2D tDiffuse, tAO, tBlur, tDepth;
    uniform vec2 resolution;
    uniform float cameraNear, cameraFar, uAO, uTilt, uTime, uNight, uVig;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    vec3 display(vec3 c) {
    #ifdef TONE_MAPPING
      c = toneMapping(c);
    #endif
      return linearToOutputTexel(vec4(c, 1.0)).rgb;
    }
    vec3 tex(vec2 uv) { return display(texture2D(tDiffuse, uv).rgb * mix(1.0, texture2D(tAO, uv).r, uAO)); }
    float linZ(vec2 uv) { float d = texture2D(tDepth, uv).x; return d >= 1.0 ? cameraFar : -perspectiveDepthToViewZ(d, cameraNear, cameraFar); }
    void main() {
      vec3 c = tex(vUv);
      { // FXAA-lite: blend along the edge where local contrast is high
        vec2 t = 1.0 / resolution;
        float lN = luma(tex(vUv + vec2(0.0, t.y))), lS = luma(tex(vUv - vec2(0.0, t.y)));
        float lE = luma(tex(vUv + vec2(t.x, 0.0))), lW = luma(tex(vUv - vec2(t.x, 0.0)));
        float lM = luma(c);
        float range = max(max(max(lN, lS), max(lE, lW)), lM) - min(min(min(lN, lS), min(lE, lW)), lM);
        if (range > max(0.04, 0.1 * max(max(lN, lS), max(lE, lW)))) {
          vec2 dir = vec2(lS - lN, lE - lW);
          dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + 0.06), -2.0, 2.0) * t;
          vec3 a = 0.5 * (tex(vUv - dir * 0.17) + tex(vUv + dir * 0.17));
          vec3 b = 0.5 * a + 0.25 * (tex(vUv - dir * 0.5) + tex(vUv + dir * 0.5));
          float lb = luma(b);
          c = (lb < min(min(lN, lS), min(lE, lW)) || lb > max(max(lN, lS), max(lE, lW))) ? a : b;
        }
      }
      if (uTilt > 0.001) {
        // miniature-lens depth of field: autofocus on what the screen centre looks at (the player / look target)
        float zf = 0.2 * (linZ(vec2(0.5)) + linZ(vec2(0.47, 0.5)) + linZ(vec2(0.53, 0.5)) + linZ(vec2(0.5, 0.46)) + linZ(vec2(0.5, 0.54)));
        float z = linZ(vUv);
        float coc = smoothstep(0.18, 0.75, abs(z - zf) / zf);
        coc = max(coc, smoothstep(0.36, 0.5, abs(vUv.y - 0.5)) * 0.7); // classic tilt-shift band: frame edges always soften
        c = mix(c, display(texture2D(tBlur, vUv).rgb), coc * uTilt * 0.7);
      }
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // restrained warm grade: sunlit warm-white highlights, near-neutral shadows; night keeps cool shadows under
      // warm lamp/window highlights. A touch of contrast so the model reads crisp, not washed out.
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.1);
      vec3 shadowT = mix(vec3(0.99, 1.0, 1.01), vec3(0.95, 0.98, 1.05), uNight);
      vec3 highT = mix(vec3(1.025, 1.0, 0.965), vec3(1.05, 1.0, 0.92), uNight);
      c *= mix(shadowT, highT, smoothstep(0.1, 0.8, l));
      vec2 q = (vUv - 0.5) * vec2(resolution.x / resolution.y, 1.0);
      c *= 1.0 - uVig * smoothstep(0.45, 1.15, length(q));
      c += (hash(vUv * resolution + fract(uTime) * 917.0) - 0.5) / 255.0; // dither: no banding in the sky gradient
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
  const hdr = { type: THREE.HalfFloatType };
  const sceneRT = new THREE.WebGLRenderTarget(1, 1, hdr);
  sceneRT.depthTexture = new THREE.DepthTexture(1, 1);
  const aoRT = new THREE.WebGLRenderTarget(1, 1);
  const blurA = new THREE.WebGLRenderTarget(1, 1, hdr), blurB = new THREE.WebGLRenderTarget(1, 1, hdr);
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;

  // GTAO from the scene depth only (normals reconstructed): no second scene render. Soft and wide like studio light
  // on a physical model; the Poisson denoise does the softening.
  const gtao = new GTAOPass(scene, camera, 1, 1, { depthTexture: sceneRT.depthTexture });
  gtao.output = GTAOPass.OUTPUT.Denoise;
  gtao.updateGtaoMaterial({ radius: 1.4, distanceExponent: 1.6, thickness: 2.5, scale: 1.0, samples: 8, distanceFallOff: 1.0, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 6 });

  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.3, 0.5, 1.2);
  const blurQ = new FullScreenQuad(new THREE.ShaderMaterial({ ...BlurShader, uniforms: THREE.UniformsUtils.clone(BlurShader.uniforms), depthTest: false, depthWrite: false }));
  const gradeMat = new THREE.ShaderMaterial({ ...GradeShader, uniforms: THREE.UniformsUtils.clone(GradeShader.uniforms), depthTest: false, depthWrite: false });
  const gradeQ = new FullScreenQuad(gradeMat);
  const bu = (blurQ.material as THREE.ShaderMaterial).uniforms, gu = gradeMat.uniforms;
  gu.tDiffuse.value = sceneRT.texture; gu.tDepth.value = sceneRT.depthTexture; gu.tBlur.value = blurB.texture;
  const start = performance.now();
  let night = 0;

  function resize(): void {
    // post runs at <=1.5x DPR (retina 2x would quadruple every fullscreen pass). No MSAA (~6 ms here): FXAA-lite instead.
    const pr = Math.min(renderer.getPixelRatio(), 1.5);
    const W = Math.max(1, Math.round(w * pr)), H = Math.max(1, Math.round(h * pr));
    const hw = Math.max(1, W >> 1), hh = Math.max(1, H >> 1);
    sceneRT.setSize(W, H);
    aoRT.setSize(hw, hh); gtao.setSize(hw, hh);
    blurA.setSize(hw, hh); blurB.setSize(hw, hh);
    bloom.setSize(Math.max(1, W >> 2), Math.max(1, H >> 2)); // night glow is soft by nature: mip chain from quarter res
    gu.resolution.value.set(W, H);
  }

  const post: Post = {
    render() {
      if (quality === 'low') { renderer.setRenderTarget(null); renderer.render(scene, camera); return; }
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);
      const ao = quality === 'high';
      if (ao) gtao.render(renderer, aoRT, sceneRT, 0, false);
      if (bloom.enabled) bloom.render(renderer, null as unknown as THREE.WebGLRenderTarget, sceneRT, 0, false);
      // tilt-shift fades in as the camera rises above rooftop height (overview / manage shots), off at street level
      const tilt = THREE.MathUtils.smoothstep(camera.position.y, 11, 22);
      bu.tAO.value = gu.tAO.value = ao ? aoRT.texture : white;
      bu.uAO.value = gu.uAO.value = ao ? 0.85 - 0.3 * night : 0;
      if (tilt > 0.001) {
        bu.tDiffuse.value = sceneRT.texture; bu.uDir.value.set(1 / blurA.width, 0);
        renderer.setRenderTarget(blurA); blurQ.render(renderer);
        bu.tDiffuse.value = blurA.texture; bu.uAO.value = 0; bu.uDir.value.set(0, 1 / blurA.height);
        renderer.setRenderTarget(blurB); blurQ.render(renderer);
      }
      gu.uTilt.value = tilt;
      gu.cameraNear.value = camera.near; gu.cameraFar.value = camera.far;
      gu.uTime.value = (performance.now() - start) / 1000;
      renderer.setRenderTarget(null);
      gradeQ.render(renderer);
    },
    setSize(nw, nh) { w = nw; h = nh; resize(); },
    setQuality(q) { quality = q; resize(); },
    setNight(n) {
      night = n;
      // only real emitters (neon, lanterns, lit windows: emissive > ~1.2 linear) bloom, and only after dark
      bloom.enabled = n > 0.15;
      bloom.strength = 0.12 + 0.38 * n;
      bloom.radius = 0.45;
      bloom.threshold = 1.6 - 0.45 * n;
      gu.uNight.value = n;
      gu.uVig.value = 0.16 + 0.1 * n;
    },
  };
  resize();
  return post;
}
