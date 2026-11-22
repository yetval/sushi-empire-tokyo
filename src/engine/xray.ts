// Occluder fade: world surfaces between the camera and the player dissolve (ordered dither, soft edge) inside a
// cone around the camera-to-player line, so poles, trees, signs and walls never hide the owner.
// Works by patching MeshStandardMaterials once (composing with any existing onBeforeCompile hook).
// Only fragments that are nearer to the camera than the player AND above the pavement are cut, so the ground
// in front of the player never gets a hole. Shadows are untouched (depth materials aren't patched).
import * as THREE from 'three';

export const xray = {
  player: { value: new THREE.Vector3() }, // player chest in view space
  radius: { value: 0 }, // angular radius of the see-through circle (radians); 0 disables
};

const patched = new WeakSet<THREE.Material>();

function patch(m: THREE.MeshStandardMaterial): void {
  if (patched.has(m) || m.transparent) return;
  patched.add(m);
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    sh.uniforms.uXrP = xray.player; sh.uniforms.uXrR = xray.radius;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uXrP; uniform float uXrR;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
	if ( uXrR > 0.0 && vViewPosition.z < -uXrP.z - 0.9 ) {
		float wy = ( inverse( viewMatrix ) * vec4( -vViewPosition, 1.0 ) ).y;
		float d = acos( clamp( dot( normalize( -vViewPosition ), normalize( uXrP ) ), -1.0, 1.0 ) ) / uXrR;
		if ( wy > 0.25 && d < 1.0 ) {
			// 4x4 Bayer threshold: a clean, stable dissolve that fades out toward the circle's edge
			ivec2 p = ivec2( mod( gl_FragCoord.xy, 4.0 ) );
			int i = p.x + p.y * 4;
			float b = float( i == 0 ? 0 : i == 1 ? 8 : i == 2 ? 2 : i == 3 ? 10 : i == 4 ? 12 : i == 5 ? 4 : i == 6 ? 14 : i == 7 ? 6
				: i == 8 ? 3 : i == 9 ? 11 : i == 10 ? 1 : i == 11 ? 9 : i == 12 ? 15 : i == 13 ? 7 : i == 14 ? 13 : 5 ) / 16.0;
			if ( b < 0.85 * ( 1.0 - smoothstep( 0.55, 1.0, d ) ) ) discard;
		}
	}`);
  };
  const key = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => key() + '|xray';
  m.needsUpdate = true;
}

/** Patch every opaque standard material under root (call after a district is built, before renderer.compile). */
export function applyXray(root: THREE.Object3D, skip?: THREE.Object3D): void {
  root.traverse((o) => {
    if (skip && o === skip) return;
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) patch(m as THREE.MeshStandardMaterial);
    }
  });
}

/** Per frame: aim the circle at the player's chest. Pass enabled = false to switch it off (title, overview). */
export function updateXray(camera: THREE.PerspectiveCamera, player: THREE.Vector3, enabled: boolean): void {
  if (!enabled) { xray.radius.value = 0; return; }
  const p = xray.player.value.set(player.x, player.y + 1.1, player.z).applyMatrix4(camera.matrixWorldInverse);
  xray.radius.value = Math.atan2(1.3, Math.max(0.5, p.length())); // ~1.3 m around the player
}
