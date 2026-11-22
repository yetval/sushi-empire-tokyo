// Recipe geometry is shared by the prep station, counters and carried orders.
import * as THREE from 'three';
import { RECIPES } from '../core/data';
import { VC_MAT, at, merge, paint, shade } from '../engine/geo';

const cache = new Map<string, THREE.BufferGeometry>();
const RICE = '#f4e8ce';
const NORI = '#23382b';
const PLATE = '#e9dfc7';

const grain = new THREE.SphereGeometry(1, 6, 4);
const bead = new THREE.SphereGeometry(1, 8, 6);

function oval(
  color: string, x: number, y: number, z: number, sx: number, sy: number, sz: number,
  yaw = 0, base = bead,
): THREE.BufferGeometry {
  return paint(at(base.clone(), x, y, z, 0, yaw, 0, sx, sy, sz), color);
}

function turnedProfile(profile: number[][], color: string, xScale = 1, zScale = 1): THREE.BufferGeometry {
  const points = profile.map(([radius, height]) => new THREE.Vector2(radius, height));
  return paint(at(new THREE.LatheGeometry(points, 32), 0, 0, 0, 0, 0, 0, xScale, 1, zScale), color);
}

function surface(
  columns: number, rows: number, point: (u: number, v: number) => number[], color: string,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= columns; col++) positions.push(...point(col / columns, row / rows));
  }
  const stride = columns + 1;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const a = row * stride + col;
      const b = a + stride;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return paint(geometry, color);
}

function riceBed(): THREE.BufferGeometry[] {
  const bed = new THREE.CapsuleGeometry(0.044, 0.071, 4, 12);
  const parts = [paint(at(bed, 0, 0.035, 0, 0, 0, Math.PI / 2, 0.89, 0.97, 0.99), RICE)];
  for (let i = 0; i < 23; i++) {
    const angle = i * 2.39996;
    const fraction = ((i * 7) % 13) / 13;
    const x = Math.sin(angle) * 0.063;
    const edge = 1 - 0.46 * (x / 0.075) ** 2;
    const y = 0.014 + fraction * 0.052;
    const z = (i % 2 ? -1 : 1) * edge * Math.sqrt(1 - ((y - 0.035) / 0.048) ** 2) * 0.039;
    parts.push(oval(i % 3 ? '#fff3d9' : '#e5d5b7', x, y, z, 0.010, 0.005, 0.0055, angle, grain));
  }
  return parts;
}

function fishPoint(x: number, angle: number, raise = 0): number[] {
  const breadth = Math.pow(Math.max(0, 1 - Math.abs(x) ** 5), 0.48);
  return [
    x * 0.105,
    0.080 + 0.012 * (1 - x * x) + 0.004 * x + Math.cos(angle) * (0.020 * breadth + raise),
    0.006 * x + Math.sin(angle) * (0.053 * breadth * (1 - 0.13 * x) + raise),
  ];
}

function nigiri(id: string, color: string): THREE.BufferGeometry[] {
  const parts = riceBed();
  const shrimp = id === 'shrimp_nigiri';
  const eel = id === 'eel_nigiri';
  parts.push(surface(24, 20, (u, v) => fishPoint(u * 2 - 1, v * Math.PI * 2), color));

  const bands = id === 'salmon_nigiri' ? 5 : id === 'toro_nigiri' || shrimp ? 6 : 0;
  for (let i = 0; i < bands; i++) {
    const center = -0.69 + i * (1.36 / Math.max(1, bands - 1));
    const width = shrimp ? 0.085 : 0.026 + (i % 3) * 0.012;
    const bandColor = shrimp ? '#dd7353' : id === 'toro_nigiri' ? '#f9c2be' : '#ffd1aa';
    parts.push(surface(2, 14, (u, v) => {
      const angle = (v - 0.5) * 2.75;
      const curve = 0.12 * Math.sin(angle * 1.3 + i * 0.32) + 0.048 * angle * angle;
      return fishPoint(center + curve + (u - 0.5) * width, angle, 0.0016);
    }, bandColor));
  }

  if (id === 'tuna_nigiri') {
    parts.push(surface(10, 2, (u, v) => fishPoint(-0.79 + u * 1.54, -1.3 + (v - 0.5) * 0.07, 0.0013), '#e37374'));
  }
  if (eel) {
    for (const angle of [-0.68, 0, 0.6]) {
      parts.push(surface(8, 2, (u, v) => fishPoint(-0.88 + u * 1.76, angle + (v - 0.5) * 0.18, 0.002), '#9e6237'));
    }
    parts.push(turnedProfile([[0.043, 0.007], [0.052, 0.030], [0.056, 0.079], [0.046, 0.111]], NORI, 0.32, 1.12).scale(0.77, 1, 1));
  }
  if (shrimp) {
    for (const side of [-1, 1]) {
      parts.push(oval(side > 0 ? '#eb765b' : '#ce5843', 0.114, 0.097, side * 0.019, 0.027, 0.008, 0.013, side * -0.47));
    }
  }
  return parts;
}

function cutRoll(id: string, insideOut: boolean, color: string): THREE.BufferGeometry[] {
  const r = insideOut ? 0.065 : 0.057;
  const parts = [
    turnedProfile([[0, 0], [r * 0.89, 0], [r, 0.009], [r * 1.015, 0.059], [r * 0.92, 0.071], [0, 0.071]], insideOut ? RICE : NORI),
    turnedProfile([[0, 0.069], [r * 0.88, 0.069], [r * 0.80, 0.074], [0, 0.074]], RICE),
  ];

  for (let i = 0; i < 20; i++) {
    const angle = i * 2.39996;
    const radius = r * (0.52 + (i % 6) * 0.074);
    parts.push(oval(
      i % 3 ? '#fff2d9' : '#e5d5b8', Math.cos(angle) * radius, 0.073, Math.sin(angle) * radius,
      0.007, 0.003, 0.0045, angle, grain,
    ));
    if (insideOut && i % 2 === 0) {
      parts.push(oval(RICE, Math.cos(angle) * r, 0.023 + (i % 7) * 0.005, Math.sin(angle) * r, 0.007, 0.006, 0.004, angle, grain));
    }
  }

  if (!insideOut) {
    parts.push(oval(color, 0, 0.075, 0, 0.021, 0.004, 0.018, 0.32));
    if (id === 'cucumber_maki') parts.push(oval('#bcce7a', -0.004, 0.078, 0.001, 0.011, 0.002, 0.009, 0.32, grain));
    return parts;
  }

  parts.push(turnedProfile([[0, 0.074], [0.032, 0.074], [0.026, 0.079], [0, 0.079]], NORI));
  const filling: [string, string, string] = id === 'spicy_tuna_roll'
    ? ['#b74446', '#dc6344', '#ffbc70']
    : id === 'dragon_roll' ? ['#9e5d38', '#a5b95c', '#e0926f']
      : ['#e78066', '#b9c879', '#ead7a8'];
  filling.forEach((ingredient, i) => {
    const angle = i * Math.PI * 2 / filling.length;
    parts.push(oval(ingredient, Math.sin(angle) * 0.012, 0.079, Math.cos(angle) * 0.012, 0.013, 0.005, 0.010, angle));
  });
  if (id === 'rainbow_roll' || id === 'dragon_roll') {
    const toppings = id === 'rainbow_roll' ? ['#f48e6d', '#d84c58', '#b2be68'] : ['#9fa955', '#bac36d', '#d0c681'];
    toppings.forEach((topping, i) => {
      parts.push(oval(topping, (i - 1) * 0.025, 0.085 + (i % 2) * 0.004, -0.018, 0.022, 0.008, 0.035, -0.35));
    });
  } else {
    for (let i = 0; i < 7; i++) {
      const angle = i * 2.39996;
      parts.push(oval('#b58751', Math.cos(angle) * 0.047, 0.077, Math.sin(angle) * 0.041, 0.0045, 0.0018, 0.0024, angle, grain));
    }
  }
  return parts;
}

function gunkan(color: string): THREE.BufferGeometry[] {
  const parts = [
    turnedProfile([[0, 0], [0.048, 0], [0.053, 0.01], [0.055, 0.084], [0.051, 0.087], [0.048, 0.072], [0, 0.066]], NORI, 1.28),
    oval(RICE, 0, 0.061, 0, 0.061, 0.018, 0.043),
  ];
  for (let i = 0; i < 20; i++) {
    const angle = i * 2.39996;
    const spread = Math.sqrt((i + 0.5) / 20);
    const size = 0.010 + (i % 4) * 0.0011;
    const x = Math.cos(angle) * spread * 0.055;
    const z = Math.sin(angle) * spread * 0.035;
    const y = 0.095 - spread * 0.018 + (i % 3) * 0.002;
    parts.push(oval(shade(color, 0.80 + (i % 5) * 0.095), x, y, z, size, size, size, angle, grain));
  }
  return parts;
}

function pieceGeo(recipeId: string): THREE.BufferGeometry {
  const cached = cache.get(recipeId);
  if (cached) return cached;
  const recipe = RECIPES[recipeId];
  let parts: THREE.BufferGeometry[];
  switch (recipe.kind) {
    case 'nigiri': parts = nigiri(recipeId, recipe.topColor); break;
    case 'maki': parts = cutRoll(recipeId, false, recipe.topColor); break;
    case 'roll': parts = cutRoll(recipeId, true, recipe.topColor); break;
    case 'gunkan': parts = gunkan(recipe.topColor); break;
    case 'platter': {
      parts = [turnedProfile([[0, 0], [0.145, 0], [0.154, 0.008], [0.184, 0.023], [0.181, 0.026], [0.146, 0.015], [0, 0.015]], '#40564a', 1.2, 0.72)];
      ['salmon_nigiri', 'tuna_nigiri', 'toro_nigiri', 'roe_gunkan'].forEach((id, i) => {
        parts.push(at(pieceGeo(id).clone(), (i - 1.5) * 0.094, 0.018, 0, 0, Math.PI / 2 + (i - 1.5) * 0.11, 0, 0.66, 0.66, 0.66));
      });
      break;
    }
  }
  const geometry = merge(parts);
  cache.set(recipeId, geometry);
  return geometry;
}

/** A single sushi piece (roughly 20 cm wide at world scale). */
export function makeSushi(recipeId: string): THREE.Mesh {
  const mesh = new THREE.Mesh(pieceGeo(recipeId), VC_MAT);
  mesh.castShadow = true;
  return mesh;
}

const plateGeo = merge([
  turnedProfile([[0, 0.006], [0.131, 0.006], [0.139, 0.010], [0.149, 0.012], [0.176, 0.025], [0.192, 0.039],
    [0.195, 0.044], [0.189, 0.046], [0.178, 0.040], [0.162, 0.031], [0.133, 0.024], [0, 0.024]], PLATE, 1.26, 0.91),
  turnedProfile([[0.179, 0.0415], [0.173, 0.0375]], '#334f53', 1.26, 0.91),
  turnedProfile([[0.177, 0.0403], [0.176, 0.0395]], '#658281', 1.26, 0.91),
]);

/** Plate with up to eight pieces, spaced by their actual footprint. */
export function makePlate(recipeId: string, pieces: number): THREE.Group {
  const group = new THREE.Group();
  const plate = new THREE.Mesh(plateGeo, VC_MAT);
  plate.receiveShadow = true;
  group.add(plate);
  const platter = RECIPES[recipeId].kind === 'platter';
  const count = platter ? 1 : Math.min(pieces, 8);
  for (let i = 0; i < count; i++) {
    const piece = makeSushi(recipeId);
    const row = Math.floor(i / 4);
    const inRow = Math.min(4, count - row * 4);
    const col = i % 4;
    piece.position.set((col - (inRow - 1) / 2) * 0.106, 0.026, (row - (count > 4 ? 0.5 : 0)) * 0.138);
    piece.rotation.y = platter ? 0.03 : Math.PI / 2 + (col - (inRow - 1) / 2) * 0.075;
    piece.scale.setScalar(platter ? 0.86 : count > 4 ? 0.70 : 0.75);
    group.add(piece);
  }
  return group;
}
