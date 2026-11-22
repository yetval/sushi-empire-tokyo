// Geometry helpers: bake transforms and flat vertex colors so many parts merge into one draw call.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Shared painterly-lighting knobs (rim strength). */
export const paintFx = { rim: { value: 0.28 } };

/**
 * Painterly look on top of MeshStandardMaterial (keeps shadows, fog, vertex colors):
 * wrapped + softly banded sun light (two gentle cel steps) and a warm rim light.
 * Composes with an existing onBeforeCompile hook.
 */
export function painterly<T extends THREE.MeshStandardMaterial>(mat: T): T {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.uniforms.uRim = paintFx.rim;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <lights_physical_pars_fragment>', THREE.ShaderChunk.lights_physical_pars_fragment
        // diffuse only: wrapped + two soft cel steps. Specular keeps the true N·L (a wrapped term there
        // explodes the GGX visibility term at silhouettes).
        .replace('float dotNL = saturate( dot( geometryNormal, directLight.direction ) );',
          `float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
	float wrapNL = saturate( ( dot( geometryNormal, directLight.direction ) + 0.3 ) / 1.3 );
	float toonNL = mix( wrapNL, 0.12 + 0.5 * smoothstep( 0.26, 0.34, wrapNL ) + 0.38 * smoothstep( 0.62, 0.72, wrapNL ), 0.6 );`)
        .replace('reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );',
          'reflectedLight.directDiffuse += toonNL * directLight.color * diffuseBRDF * ( 1.0 - F );'))
      .replace('#include <common>', '#include <common>\nuniform float uRim;')
      .replace('#include <opaque_fragment>', `{
	float rimF = pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 3.0 );
	outgoingLight += diffuseColor.rgb * vec3( 1.0, 0.97, 0.92 ) * rimF * uRim;
}
#include <opaque_fragment>`);
  };
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => key() + '|painterly';
  return mat;
}

/** Shared material for all vertex-colored merged meshes. */
export const VC_MAT = painterly(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 }));

/** Flat vertex color for one part. Keeps the geometry indexed (no vertex tripling). */
export function paint(g: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (g.attributes.uv1) g.deleteAttribute('uv1');
  if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]); // merge needs all-or-none indexed
  const c = new THREE.Color(color); // already converted to linear working space by ColorManagement
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

export function at(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  return g.applyMatrix4(m);
}

export const merge = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts)!;

export function shade(hex: string, f: number): string {
  const c = new THREE.Color(hex); c.multiplyScalar(f); return '#' + c.getHexString();
}
