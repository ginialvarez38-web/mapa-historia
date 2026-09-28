// Accidentes geográficos de Natural Earth: ríos, lagos, cordilleras,
// desiertos, penínsulas, océanos, mares, golfos, estrechos y picos.

import { collectLines, collectPolygons, lineStats, polygonStats } from './geo.js';

const SOURCES = [
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson',
  'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson',
];

export const LAYERS = {
  lakes: 'ne_50m_lakes',
  rivers: 'ne_50m_rivers_lake_centerlines',
  regions: 'ne_50m_geography_regions_polys',
  marine: 'ne_50m_geography_marine_polys',
  peaks: 'ne_50m_geography_regions_elevation_points',
};

const DEG = Math.PI / 180;
const SMALL_WORDS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'of', 'the', 'and']);
const numberFormat = new Intl.NumberFormat('es-ES');

export async function fetchLayer(name) {
  let lastError;
  for (const base of SOURCES) {
    try {
      const res = await fetch(`${base}/${name}.geojson`);
      if (!res.ok) throw new Error(`${res.status} al cargar ${name}`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

// Natural Earth usa mayúsculas o minúsculas en los campos según la capa.
function props(feature) {
  const out = {};
  for (const [key, value] of Object.entries(feature.properties ?? {})) out[key.toLowerCase()] = value;
  return out;
}

// Algunos nombres vienen en mayúsculas ("SAHARA"): se pasan a formato título.
function tidy(name) {
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .split(' ')
    .map((word, i) => (i > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

function nameOf(p) {
  const name = String(p.name_es || p.name || '').trim();
  return name ? tidy(name) : null;
}

const kind = (p) => String(p.featurecla ?? '').toLowerCase();

/** Lagos: polígonos para el mapa y nombres de los mayores. */
export function lakeFeatures(geojson) {
  const polygons = [];
  const labels = [];
  for (const feature of geojson.features ?? []) {
    const shape = collectPolygons(feature.geometry);
    polygons.push(...shape);
    const name = nameOf(props(feature));
    const stats = name && polygonStats(shape);
    if (stats) labels.push({ text: name, lat: stats.lat, lon: stats.lon, size: Math.sqrt(stats.area) * DEG * 1.6, className: 'water' });
  }
  return { polygons, labels };
}

/** Ríos: líneas con grosor según su importancia y nombre de cada río. */
export function riverFeatures(geojson) {
  const rivers = [];
  const byName = new Map();
  for (const feature of geojson.features ?? []) {
    const p = props(feature);
    const lines = collectLines(feature.geometry);
    if (!lines.length) continue;
    const rank = Number(p.scalerank ?? 6);
    const weight = rank <= 2 ? 1.4 : rank <= 4 ? 1.05 : rank <= 6 ? 0.8 : 0.6;
    rivers.push({ lines, weight });
    const name = kind(p).includes('lake') ? null : nameOf(p);
    if (name) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(...lines);
    }
  }
  const labels = [];
  for (const [name, lines] of byName) {
    const stats = lineStats(lines);
    if (stats) labels.push({ text: name, lat: stats.lat, lon: stats.lon, size: stats.length * DEG * 0.45, className: 'river' });
  }
  return { rivers, labels };
}

function regionClass(featureClass) {
  if (/range|mtn|mount|foothill|plateau|hill|massif/.test(featureClass)) return 'relief';
  if (/desert/.test(featureClass)) return 'desert';
  if (/continent/.test(featureClass)) return 'continent';
  return 'region';
}

/** Regiones físicas: cordilleras, mesetas, desiertos, llanuras, penínsulas… */
export function regionLabels(geojson) {
  return (geojson.features ?? []).flatMap((feature) => {
    const p = props(feature);
    const name = nameOf(p);
    const stats = name && polygonStats(collectPolygons(feature.geometry));
    if (!stats) return [];
    const className = regionClass(kind(p));
    const boost = className === 'continent' ? 4 : 1.3;
    return [{ text: name, lat: stats.lat, lon: stats.lon, size: Math.sqrt(stats.area) * DEG * boost, className }];
  });
}

/** Océanos, mares, golfos, bahías y estrechos. */
export function marineLabels(geojson) {
  return (geojson.features ?? []).flatMap((feature) => {
    const p = props(feature);
    const name = nameOf(p);
    const stats = name && polygonStats(collectPolygons(feature.geometry));
    if (!stats) return [];
    const ocean = kind(p) === 'ocean';
    // Los estrechos son polígonos diminutos: se les da algo más de peso.
    const boost = ocean ? 2 : /strait|channel|passage/.test(kind(p)) ? 3 : 1.4;
    return [{ text: name, lat: stats.lat, lon: stats.lon, size: Math.sqrt(stats.area) * DEG * boost, className: ocean ? 'ocean' : 'sea' }];
  });
}

/** Picos y volcanes con su altitud. */
export function peakLabels(geojson) {
  return (geojson.features ?? []).flatMap((feature) => {
    const p = props(feature);
    const name = nameOf(p);
    const geometry = feature.geometry;
    if (!name || geometry?.type !== 'Point') return [];
    const [lon, lat] = geometry.coordinates;
    const elevation = Number(p.elevation);
    const hasElevation = Number.isFinite(elevation) && elevation > 0;
    return [
      {
        text: `▲ ${name}`,
        sub: hasElevation ? `${numberFormat.format(Math.round(elevation))} m` : null,
        lat,
        lon,
        size: (2 + (hasElevation ? (elevation / 8848) * 8 : 0)) * DEG,
        className: 'peak',
      },
    ];
  });
}
