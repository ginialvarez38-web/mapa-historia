// Genera la textura equirectangular del mapa físico: océano, relieve
// sombreado con tintas hipsométricas y líneas de costa.

import { collectPolygons, polygonsToPath } from './geo.js';

const OCEAN = '#9ec3dc';
const SHELF = [200, 226, 240];
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

/** Compone la textura final del mapa físico. */
export function buildPhysicalMap({ land, relief, width }) {
  const height = width / 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const scale = width / 4096;

  ctx.fillStyle = OCEAN;
  ctx.fillRect(0, 0, width, height);

  const { path: coast } = polygonsToPath(collectPolygons(land), width, height);

  // Halo claro alrededor de las costas que sugiere la plataforma continental.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const [lineWidth, alpha] of [[14, 0.14], [8, 0.2], [4, 0.3]]) {
    ctx.strokeStyle = `rgba(${SHELF.join(',')}, ${alpha})`;
    ctx.lineWidth = lineWidth * scale;
    ctx.stroke(coast);
  }

  ctx.save();
  ctx.clip(coast, 'evenodd');
  if (relief) {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(relief, 0, 0, width, height);
  } else {
    ctx.fillStyle = LAND_FLAT;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();

  ctx.strokeStyle = COAST;
  ctx.lineWidth = 0.9 * scale;
  ctx.stroke(coast);

  return canvas;
}
