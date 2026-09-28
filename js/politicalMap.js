// Capa política: convierte un GeoJSON histórico en entidades con color,
// dibuja la textura de fronteras y localiza la entidad bajo un punto.

import { collectPolygons, polygonsToPath, unwrapRing, wrapLon } from './geo.js';

const FILL_ALPHA = 0.55;
const BORDER = 'rgba(46, 32, 24, 0.75)';

// Contexto auxiliar solo para isPointInPath (no depende del tamaño).
const hitContext = document.createElement('canvas').getContext('2d');

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Color estable por nombre; las colonias toman el color de su metrópoli. */
function colorFor(key) {
  const h = hash(key);
  const hue = (h * 137.508) % 360;
  const saturation = 38 + (h % 5) * 6;
  const lightness = 56 + ((h >> 3) % 4) * 4;
  return `hsl(${hue.toFixed(1)} ${saturation}% ${lightness}%)`;
}

/** Área (grados² corregidos por latitud) y centroide de un anillo. */
function ringStats(ring) {
  const pts = unwrapRing(ring);
  let area = 0;
  let cx = 0;
  let cy = 0;
  let meanLat = 0;
  for (const [, lat] of pts) meanLat += lat;
  const k = Math.cos((meanLat / pts.length) * (Math.PI / 180));
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [x0, y0] = pts[j];
    const [x1, y1] = pts[i];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-9) return { area: 0, lon: pts[0][0], lat: pts[0][1] };
  return { area: Math.abs(area / 2) * k, lon: wrapLon(cx / (3 * area)), lat: cy / (3 * area) };
}

function describe(feature, index) {
  const p = feature.properties ?? {};
  const name = p.NAME?.trim();
  if (!name || !feature.geometry) return null;
  const polygons = collectPolygons(feature.geometry);
  let area = 0;
  let largest = null;
  for (const polygon of polygons) {
    const stats = ringStats(polygon[0]);
    area += stats.area;
    if (!largest || stats.area > largest.area) largest = stats;
  }
  if (!largest) return null;
  const other = (value) => (value && value.trim() !== name ? value.trim() : null);
  const subjectOf = other(p.SUBJECTO);
  return {
    id: index,
    name,
    subjectOf,
    partOf: other(p.PARTOF),
    polygons,
    area,
    anchor: { lat: largest.lat, lon: largest.lon },
    color: colorFor(subjectOf ?? name),
  };
}

export class PoliticalLayer {
  constructor(geojson, width) {
    this.width = width;
    this.height = width / 2;
    this.polities = (geojson.features ?? []).map(describe).filter(Boolean);
    for (const polity of this.polities) {
      Object.assign(polity, polygonsToPath(polity.polygons, this.width, this.height));
    }
  }

  /** Dibuja rellenos semitransparentes y fronteras en un lienzo nuevo. */
  draw() {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    const scale = this.width / 4096;

    ctx.globalAlpha = FILL_ALPHA;
    for (const { path, color } of this.polities) {
      ctx.fillStyle = color;
      ctx.fill(path, 'evenodd');
    }
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1.1 * scale;
    for (const { path } of this.polities) ctx.stroke(path);
    return canvas;
  }

  /** Entidad bajo unas coordenadas, o null (prefiere la más pequeña). */
  hit(lat, lon) {
    const x = ((lon + 180) / 360) * this.width;
    const y = ((90 - lat) / 180) * this.height;
    let best = null;
    let bestSize = Infinity;
    for (const polity of this.polities) {
      const [x0, y0, x1, y1] = polity.bbox;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const size = (x1 - x0) * (y1 - y0);
      if (size < bestSize && hitContext.isPointInPath(polity.path, x, y, 'evenodd')) {
        best = polity;
        bestSize = size;
      }
    }
    return best;
  }
}
