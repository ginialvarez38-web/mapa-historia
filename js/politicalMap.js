// Capa política: convierte un GeoJSON histórico en entidades con color,
// dibuja la textura de fronteras y localiza la entidad bajo un punto.

import { collectPolygons, polygonStats, polygonsToPath } from './geo.js';

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

function describe(feature, index) {
  const p = feature.properties ?? {};
  const name = p.NAME?.trim();
  if (!name || !feature.geometry) return null;
  const polygons = collectPolygons(feature.geometry);
  const stats = polygonStats(polygons);
  if (!stats) return null;
  const other = (value) => (value && value.trim() !== name ? value.trim() : null);
  const subjectOf = other(p.SUBJECTO);
  return {
    id: index,
    name,
    subjectOf,
    partOf: other(p.PARTOF),
    polygons,
    area: stats.area,
    anchor: { lat: stats.lat, lon: stats.lon },
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
    this.drawTo(canvas.getContext('2d'));
    return canvas;
  }

  /**
   * Dibuja en coordenadas de mundo. scale: píxeles de salida por píxel de
   * mundo; lineScale: multiplica el grosor base de las fronteras.
   */
  drawTo(ctx, scale = 1, lineScale = this.width / 4096) {
    ctx.globalAlpha = FILL_ALPHA;
    for (const { path, color } of this.polities) {
      ctx.fillStyle = color;
      ctx.fill(path, 'evenodd');
    }
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = (1.1 * lineScale) / scale;
    for (const { path } of this.polities) ctx.stroke(path);
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
