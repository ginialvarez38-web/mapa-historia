// Genera la textura equirectangular del mapa físico: océano, relieve
// sombreado con tintas hipsométricas y líneas de costa.

import { collectPolygons, polygonsToPath } from './geo.js';

// Océano: más oscuro en alta mar y más claro sobre la plataforma continental.
const OCEAN_DEEP = [58, 104, 150];
const OCEAN_MID = [104, 152, 194];
const OCEAN_SHELF = [178, 214, 232];
const OCEAN_GRID = [1024, 512];
const COAST = 'rgba(52, 70, 78, 0.6)';
const LAND_FLAT = '#b9c79a';

// Tintas hipsométricas: elevación normalizada (0-1) -> color.
const HYPSOMETRIC_RAMP = [
  [0.0, [128, 168, 104]],
  [0.06, [160, 190, 120]],
  [0.16, [204, 204, 140]],
  [0.3, [214, 186, 128]],
  [0.48, [184, 146, 102]],
  [0.66, [156, 124, 96]],
  [0.82, [206, 196, 186]],
  [1.0, [250, 250, 250]],
];

const RELIEF_EXAGGERATION = 28;
const SHADE_STRENGTH = 0.85;
const LIGHT = normalize([-1, -1, 1.6]); // desde el noroeste

function normalize([x, y, z]) {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

function buildColorLut() {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const e = i / 255;
    let j = 1;
    while (j < HYPSOMETRIC_RAMP.length - 1 && HYPSOMETRIC_RAMP[j][0] < e) j++;
    const [e0, c0] = HYPSOMETRIC_RAMP[j - 1];
    const [e1, c1] = HYPSOMETRIC_RAMP[j];
    const t = Math.min(Math.max((e - e0) / (e1 - e0), 0), 1);
    for (let k = 0; k < 3; k++) lut[i * 3 + k] = c0[k] + (c1[k] - c0[k]) * t;
  }
  return lut;
}

/**
 * Convierte un mapa de elevación en escala de grises en un lienzo con
 * relieve sombreado (hillshade) y colores hipsométricos.
 */
export function buildReliefCanvas(elevationImage, width) {
  const height = width / 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(elevationImage, 0, 0, width, height);

  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  const elevation = new Float32Array(width * height);
  for (let i = 0; i < elevation.length; i++) elevation[i] = px[i * 4] / 255;

  const lut = buildColorLut();
  const [lx, ly, lz] = LIGHT;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    const up = Math.max(y - 1, 0) * width;
    const down = Math.min(y + 1, height - 1) * width;
    for (let x = 0; x < width; x++) {
      const left = (x - 1 + width) % width;
      const right = (x + 1) % width;
      const dzdx = (elevation[row + right] - elevation[row + left]) * RELIEF_EXAGGERATION;
      const dzdy = (elevation[down + x] - elevation[up + x]) * RELIEF_EXAGGERATION;
      // Normal de la superficie (-dz/dx, -dz/dy, 1) sin normalizar.
      const shade = (-dzdx * lx - dzdy * ly + lz) / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
      const factor = 1 + (shade / lz - 1) * SHADE_STRENGTH;

      const i = row + x;
      const c = Math.round(elevation[i] * 255) * 3;
      px[i * 4] = lut[c] * factor;
      px[i * 4 + 1] = lut[c + 1] * factor;
      px[i * 4 + 2] = lut[c + 2] * factor;
      px[i * 4 + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Desenfoque de caja separable; envuelve en horizontal (longitud). */
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + ((k % w) + w) % w];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * norm;
      sum += src[row + ((x + r + 1) % w)] - src[row + ((((x - r) % w) + w) % w)];
    }
  }
  const clampRow = (y) => Math.min(Math.max(y, 0), h - 1) * w;
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[clampRow(k) + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * norm;
      sum += tmp[clampRow(y + r + 1) + x] - tmp[clampRow(y - r) + x];
    }
  }
  return out;
}

/** Tres pasadas de caja se aproximan a un desenfoque gaussiano. */
function blur(src, w, h, r) {
  return boxBlur(boxBlur(boxBlur(src, w, h, r), w, h, r), w, h, r);
}

const mix = (a, b, t) => a + (b - a) * t;

/**
 * Sin datos de batimetría, la profundidad se sugiere por la distancia a la
 * costa: aguas someras claras junto a tierra y azul profundo mar adentro.
 */
function buildOceanCanvas(polygons) {
  const [w, h] = OCEAN_GRID;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  ctx.fill(polygonsToPath(polygons, w, h).path, 'evenodd');

  const image = ctx.getImageData(0, 0, w, h);
  const px = image.data;
  const land = new Float32Array(w * h);
  for (let i = 0; i < land.length; i++) land[i] = px[i * 4] / 255;

  const shelf = blur(land, w, h, 2);
  const basin = blur(land, w, h, 18);

  for (let i = 0; i < land.length; i++) {
    // Se acota a [0, 1]: el redondeo del desenfoque deja valores apenas negativos.
    const nearLand = Math.min(Math.max(basin[i] * 2.4, 0), 1);
    const shallow = Math.min(Math.max(shelf[i] * 2.2, 0), 1) ** 1.3;
    for (let k = 0; k < 3; k++) {
      const open = mix(OCEAN_DEEP[k], OCEAN_MID[k], Math.sqrt(nearLand));
      px[i * 4 + k] = mix(open, OCEAN_SHELF[k], shallow);
    }
    px[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Compone la textura final del mapa físico. Devuelve también una máscara
 * del agua (blanco = mar) para los brillos especulares.
 */
export function buildPhysicalMap({ land, relief, width }) {
  const height = width / 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const scale = width / 4096;
  const polygons = collectPolygons(land);

  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(buildOceanCanvas(polygons), 0, 0, width, height);

  const { path: coast } = polygonsToPath(polygons, width, height);

  ctx.save();
  ctx.clip(coast, 'evenodd');
  if (relief) {
    ctx.drawImage(relief, 0, 0, width, height);
  } else {
    ctx.fillStyle = LAND_FLAT;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();

  ctx.lineJoin = 'round';
  ctx.strokeStyle = COAST;
  ctx.lineWidth = 0.9 * scale;
  ctx.stroke(coast);

  const water = document.createElement('canvas');
  water.width = 2048;
  water.height = 1024;
  const wctx = water.getContext('2d');
  wctx.fillStyle = '#fff';
  wctx.fillRect(0, 0, water.width, water.height);
  wctx.fillStyle = '#000';
  wctx.fill(polygonsToPath(polygons, water.width, water.height).path, 'evenodd');

  return { map: canvas, water };
}
