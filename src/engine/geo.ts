// Geometry helpers: bake transforms and flat vertex colors so many parts merge into one draw call.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Shared lighting knob: strength of the faint rim light. */
export const paintFx = { rim: { value: 0.06 } };

/**
 * Clean architectural-model shading: plain physically based light (no cel banding), plus a very faint
 * warm rim so figures and props separate from the background. Composes with an existing onBeforeCompile hook.
 */
export function painterly<T extends THREE.MeshStandardMaterial>(mat: T): T {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.uniforms.uRim = paintFx.rim;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uRim;')
      .replace('#include <opaque_fragment>', `{
	float rimF = pow( 1.0 - saturate( dot( normal, normalize( vViewPosition ) ) ), 3.0 );
	outgoingLight += diffuseColor.rgb * vec3( 1.0, 0.97, 0.92 ) * rimF * uRim;
}
#include <opaque_fragment>`);
  };
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => key() + '|rim';
  return mat;
}

/** Shared material for all vertex-colored merged meshes. */
export const VC_MAT = painterly(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }));

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
