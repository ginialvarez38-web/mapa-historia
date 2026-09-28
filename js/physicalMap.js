// Mapa físico equirectangular: océano, relieve sombreado con tintas
// hipsométricas, lagos, ríos y líneas de costa.

import { collectPolygons, linesToPath, polygonsToPath } from './geo.js';

// Océano: más oscuro en alta mar y más claro sobre la plataforma continental.
const OCEAN_DEEP = [58, 104, 150];
const OCEAN_MID = [104, 152, 194];
const OCEAN_SHELF = [178, 214, 232];
const OCEAN_GRID = [1024, 512];
const COAST = 'rgba(52, 70, 78, 0.6)';
const LAND_FLAT = '#b9c79a';
const LAKE = '#8ec0de';
const LAKE_EDGE = 'rgba(52, 90, 120, 0.55)';
const RIVER = '#4f8fc4';

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
 * Mapa físico en proyección equirectangular: océano con profundidad,
 * relieve, lagos, ríos y costas. Puede generar la textura del mundo entero
 * o dibujar solo una ventana a más resolución (parche de detalle).
 */
export class PhysicalMap {
  /**
   * @param land    GeoJSON de tierras emergidas.
   * @param lakes   Polígonos de lagos (arrays de anillos).
   * @param rivers  [{ lines, weight }]: ríos con su grosor base en píxeles.
   * @param relief  Lienzo de relieve coloreado (o null).
   * @param sea     Lienzo del océano con batimetría (o null: se estima por
   *                la distancia a la costa).
   * @param elevation Imagen de elevación en grises (o null).
   * @param width   Ancho en píxeles del «mundo» (el alto es la mitad).
   */
  constructor({ land, lakes = [], rivers = [], relief = null, sea = null, elevation = null, width }) {
    this.width = width;
    this.height = width / 2;
    this.relief = relief;
    this.elevation = elevation;
    const polygons = collectPolygons(land);
    this.ocean = sea ?? buildOceanCanvas(polygons);
    ({ path: this.coast, outline: this.coastline } = polygonsToPath(polygons, this.width, this.height));
    this.detailCoast = null;
    this.detailCoastline = null;
    this.lakes = polygonsToPath(lakes, this.width, this.height).path;

    // Un trazo por grosor: muchos menos cambios de estado al dibujar.
    const byWeight = new Map();
    for (const { lines, weight } of rivers) {
      if (!byWeight.has(weight)) byWeight.set(weight, []);
      byWeight.get(weight).push(...lines);
    }
    this.rivers = [...byWeight]
      .sort(([a], [b]) => a - b)
      .map(([weight, lines]) => ({ weight, path: linesToPath(lines, this.width, this.height) }));
  }

  /** Costas a mayor escala (1:10 millones) para el parche de detalle. */
  setDetailCoast(land) {
    ({ path: this.detailCoast, outline: this.detailCoastline } = polygonsToPath(
      collectPolygons(land),
      this.width,
      this.height,
    ));
  }

  #coastFor(detail) {
    return (detail && this.detailCoast) || this.coast;
  }

  /**
   * Dibuja en coordenadas de mundo. scale: píxeles de salida por píxel de
   * mundo; lineScale: multiplica los grosores base (en píxeles de salida).
   */
  draw(ctx, scale = 1, lineScale = this.width / 4096, { detail = false } = {}) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.ocean, 0, 0, this.width, this.height);
    this.drawLand(ctx, (c) => {
      if (this.relief) {
        c.drawImage(this.relief, 0, 0, this.width, this.height);
      } else {
        c.fillStyle = LAND_FLAT;
        c.fillRect(0, 0, this.width, this.height);
      }
    }, { detail });
    this.drawVectors(ctx, scale, lineScale, { detail });
  }

  /** Recorta a tierra firme y llama a paint(ctx) dentro del recorte. */
  drawLand(ctx, paint, { detail = false } = {}) {
    ctx.save();
    ctx.clip(this.#coastFor(detail), 'evenodd');
    paint(ctx);
    ctx.restore();
  }

  /** Lagos, ríos y costas. */
  drawVectors(ctx, scale = 1, lineScale = this.width / 4096, { detail = false } = {}) {
    const px = (w) => (w * lineScale) / scale;
    const coastline = (detail && this.detailCoastline) || this.coastline;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.fillStyle = LAKE;
    ctx.fill(this.lakes, 'evenodd');
    ctx.strokeStyle = LAKE_EDGE;
    ctx.lineWidth = px(0.5);
    ctx.stroke(this.lakes);

    ctx.strokeStyle = RIVER;
    for (const { weight, path } of this.rivers) {
      ctx.lineWidth = px(weight);
      ctx.stroke(path);
    }

    ctx.strokeStyle = COAST;
    ctx.lineWidth = px(0.9);
    ctx.stroke(coastline);
  }

  /** Máscara del agua (blanco = mar o lago) para los brillos especulares. */
  drawWater(ctx, { detail = false } = {}) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#000';
    ctx.fill(this.#coastFor(detail), 'evenodd');
    ctx.fillStyle = '#fff';
    ctx.fill(this.lakes, 'evenodd');
  }

  /** Elevación en grises (para el relieve 3D del parche de detalle). */
  drawElevation(ctx) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.width, this.height);
    if (this.elevation) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.elevation, 0, 0, this.width, this.height);
    }
  }

  /** Textura del mundo entero. */
  texture() {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    this.draw(canvas.getContext('2d'));
    return canvas;
  }

  waterMask(width = 2048) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = width / 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(width / this.width, width / this.width);
    this.drawWater(ctx);
    return canvas;
  }
}
