import { feature } from 'topojson-client';
import { Globe, MAX_RELIEF } from './globe.js';
import { DATA, INITIAL_VIEW } from './config.js';
import { PhysicalMap, buildReliefCanvas } from './physicalMap.js';
import { PoliticalLayer } from './politicalMap.js';
import { Labels } from './labels.js';
import { DetailView } from './detail.js';
import {
  LAYERS,
  fetchLayer,
  lakeFeatures,
  marineLabels,
  peakLabels,
  regionLabels,
  riverFeatures,
} from './features.js';
import { CENTURIES, fetchSnapshot, yearLabel } from './history.js';

const $ = (id) => document.getElementById(id);
const loader = $('loader');
const loaderText = $('loader-text');
const tooltip = $('tooltip');
const toast = $('toast');

const INITIAL_YEAR = 1492;
// En pantallas táctiles (móviles) se limitan las texturas para ahorrar memoria.
const TEXTURE_WIDTH = matchMedia('(pointer: coarse)').matches ? 4096 : 8192;
const SNAPSHOT_CACHE_SIZE = 6;

const globe = new Globe($('globe'));
globe.setView(INITIAL_VIEW.lat, INITIAL_VIEW.lon);
globe.graticuleVisible = $('graticule').checked;
const reliefInput = $('relief');
globe.reliefScale = (reliefInput.value / 100) * MAX_RELIEF;
const labels = new Labels(document.body);
labels.radiusAt = (lat, lon) => globe.surfaceRadius(lat, lon);
const detail = new DetailView(globe);
globe.onFrame = () => {
  detail.update();
  labels.update(globe.camera, innerWidth, innerHeight);
};
globe.onReliefChange = () => labels.relocate();

// Grupos de nombres de accidentes geográficos (se muestran u ocultan juntos).
const FEATURE_GROUPS = ['marine', 'regions', 'rivers', 'lakes', 'peaks'];
// Grosor de las líneas en el parche de detalle, en píxeles del parche.
const DETAIL_LINE_SCALE = 1.6;

let elevationImage = null;
let satellitePromise = null;
let politicalLayer = null;
let politicalEnabled = true;
let selected = null;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`No se pudo cargar ${url}`));
    img.src = url;
  });
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} al cargar ${url}`);
  return res.json();
}

async function loadLand() {
  const topology = await fetchJSON(DATA.land).catch((err) => {
    console.warn(err);
    return fetchJSON(DATA.landFallback);
  });
  return feature(topology, topology.objects.land);
}

// Deja que el navegador pinte los mensajes antes de un cálculo largo.
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

function textureWidth() {
  return Math.min(TEXTURE_WIDTH, globe.maxTextureSize);
}

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (toast.hidden = true), 5000);
}

/* ---------- Mapa físico ---------- */

async function initPhysicalMap() {
  try {
    loaderText.textContent = 'Cargando costas, relieve, ríos y lagos…';
    const optional = (promise) =>
      promise.catch((err) => {
        console.warn(err);
        return null;
      });
    const [land, elevation, lakesJson, riversJson] = await Promise.all([
      loadLand(),
      optional(loadImage(DATA.elevation)),
      optional(fetchLayer(LAYERS.lakes)),
      optional(fetchLayer(LAYERS.rivers)),
    ]);
    elevationImage = elevation;
    if (elevation) globe.setElevation(elevation);
    const lakes = lakesJson ? lakeFeatures(lakesJson) : { polygons: [], labels: [] };
    const rivers = riversJson ? riverFeatures(riversJson) : { rivers: [], labels: [] };

    loaderText.textContent = 'Dibujando el mapa físico…';
    await nextPaint();
    const width = textureWidth();
    const relief = elevation ? buildReliefCanvas(elevation, Math.min(width, 4096)) : null;
    const physical = new PhysicalMap({
      land,
      lakes: lakes.polygons,
      rivers: rivers.rivers,
      relief,
      elevation,
      width,
    });
    globe.setPhysicalMap(physical.texture(), physical.waterMask());

    detail.worldWidth = width;
    Object.assign(detail.painters, {
      physical: (ctx, scale) => physical.draw(ctx, scale, DETAIL_LINE_SCALE),
      water: (ctx) => physical.drawWater(ctx),
      elevation: (ctx) => physical.drawElevation(ctx),
    });
    labels.setGroup('lakes', lakes.labels, { priority: 1 });
    labels.setGroup('rivers', rivers.labels, { priority: 1 });

    loader.classList.add('hidden');
    window.mapReady = true;
    if (!elevation) showToast('No se pudo cargar el relieve; se muestra solo la silueta de los continentes.');
    loadFeatureLabels();
    return true;
  } catch (err) {
    console.error(err);
    window.reportFatal(err.stack || err.message);
    return false;
  }
}

/** Nombres de mares, cordilleras, desiertos, picos…: se cargan sin bloquear. */
async function loadFeatureLabels() {
  const layers = [
    ['marine', LAYERS.marine, marineLabels, 3],
    ['regions', LAYERS.regions, regionLabels, 1],
    ['peaks', LAYERS.peaks, peakLabels, 0],
  ];
  const results = await Promise.allSettled(
    layers.map(async ([key, file, build, priority]) => {
      labels.setGroup(key, build(await fetchLayer(file)), { priority });
    }),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    console.warn(...failed.map((r) => r.reason));
    showToast('No se pudieron cargar algunos nombres de accidentes geográficos.');
  }
}

/* ---------- Capa política ---------- */

const snapshots = new Map(); // año -> Promise<GeoJSON>
let requestId = 0;

function getSnapshot(year) {
  if (!snapshots.has(year)) {
    const promise = fetchSnapshot(year);
    promise.catch(() => snapshots.delete(year));
    snapshots.set(year, promise);
    if (snapshots.size > SNAPSHOT_CACHE_SIZE) snapshots.delete(snapshots.keys().next().value);
  }
  return snapshots.get(year);
}

async function showYear(year) {
  const id = ++requestId;
  timeline.setLoading(true);
  try {
    const geojson = await getSnapshot(year);
    if (id !== requestId) return;
    await nextPaint();
    if (id !== requestId) return;
    const layer = new PoliticalLayer(geojson, textureWidth());
    globe.setPoliticalMap(layer.draw());
    labels.setGroup(
      'polities',
      layer.polities.map((p) => ({
        text: p.name,
        lat: p.anchor.lat,
        lon: p.anchor.lon,
        size: Math.sqrt(p.area) * (Math.PI / 180),
        className: 'polity',
      })),
      { priority: 2 },
    );
    detail.painters.political = (ctx, scale) => layer.drawTo(ctx, scale, DETAIL_LINE_SCALE);
    detail.invalidate();
    politicalLayer = layer;
    select(null);
  } catch (err) {
    if (id !== requestId) return;
    console.error(err);
    showToast(`No se pudo cargar el mapa político de ${yearLabel(year)}. (${err.message})`);
  } finally {
    if (id === requestId) timeline.setLoading(false);
  }
}

function setPoliticalEnabled(enabled) {
  politicalEnabled = enabled;
  globe.politicalVisible = enabled;
  labels.setGroupVisible('polities', enabled);
  if (!enabled) select(null);
}

/* ---------- Información al pasar el ratón o tocar ---------- */

function describePolity(polity) {
  const lines = [];
  if (polity.subjectOf) lines.push(`Bajo dominio de: ${polity.subjectOf}`);
  if (polity.partOf) lines.push(`Parte de: ${polity.partOf}`);
  return lines;
}

function formatCoord(value, positive, negative) {
  return `${Math.abs(value).toFixed(1)}° ${value >= 0 ? positive : negative}`;
}

function renderTooltip(point, screen, polity) {
  if (!point) {
    tooltip.hidden = true;
    return;
  }
  const nodes = [];
  if (polity) {
    const title = document.createElement('strong');
    const swatch = document.createElement('i');
    swatch.style.background = polity.color;
    title.append(swatch, polity.name);
    nodes.push(title);
    for (const line of describePolity(polity)) {
      const p = document.createElement('span');
      p.textContent = line;
      nodes.push(p);
    }
  }
  const coords = document.createElement('small');
  coords.textContent = `${formatCoord(point.lat, 'N', 'S')} · ${formatCoord(point.lon, 'E', 'O')}`;
  nodes.push(coords);
  tooltip.replaceChildren(...nodes);
  tooltip.hidden = false;

  // Coloca la caja junto al puntero sin salirse de la pantalla.
  const margin = 14;
  const { offsetWidth: w, offsetHeight: h } = tooltip;
  const x = screen.x + margin + w > innerWidth ? screen.x - margin - w : screen.x + margin;
  const y = screen.y + margin + h > innerHeight ? screen.y - margin - h : screen.y + margin;
  tooltip.style.transform = `translate(${Math.max(x, 4)}px, ${Math.max(y, 4)}px)`;
}

function polityAt(point) {
  return point && politicalEnabled && politicalLayer ? politicalLayer.hit(point.lat, point.lon) : null;
}

function select(polity) {
  if (polity === selected) return;
  selected = polity;
  globe.highlight(polity?.polygons ?? null);
}

globe.onHover = (point, screen) => {
  const polity = polityAt(point);
  select(polity);
  renderTooltip(point, screen, polity);
};

globe.onSelect = (point, screen) => {
  const polity = polityAt(point);
  select(polity);
  renderTooltip(point, screen, polity);
};

/* ---------- Línea del tiempo ---------- */

const timeline = (() => {
  const slider = $('century');
  const centuryText = $('century-label');
  const yearText = $('year-label');
  const yearButtons = $('years');
  const panel = $('timeline');
  let index = 0;
  let year = null;
  let debounce = null;

  slider.max = CENTURIES.length - 1;
  $('range-start').textContent = yearLabel(CENTURIES[0].years[0]);
  $('range-end').textContent = yearLabel(CENTURIES.at(-1).years.at(-1));

  function render() {
    const century = CENTURIES[index];
    slider.value = index;
    slider.setAttribute('aria-valuetext', century.label);
    centuryText.textContent = century.label;
    yearText.textContent = `Mapa del año ${yearLabel(year)}`;
    $('prev').disabled = index === 0;
    $('next').disabled = index === CENTURIES.length - 1;

    yearButtons.replaceChildren(
      ...century.years.map((y) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = yearLabel(y);
        button.setAttribute('aria-pressed', y === year);
        button.addEventListener('click', () => setYear(y));
        return button;
      }),
    );
    yearButtons.hidden = century.years.length < 2;
  }

  function setYear(y, { immediate = true } = {}) {
    if (y === year) return;
    year = y;
    index = CENTURIES.findIndex((c) => c.years.includes(y));
    render();
    clearTimeout(debounce);
    // Al arrastrar el deslizador se espera un poco antes de descargar.
    if (immediate) showYear(y);
    else debounce = setTimeout(() => showYear(y), 300);
  }

  function setCentury(i, options) {
    const clamped = Math.min(Math.max(i, 0), CENTURIES.length - 1);
    setYear(CENTURIES[clamped].defaultYear, options);
  }

  slider.addEventListener('input', () => setCentury(Number(slider.value), { immediate: false }));
  $('prev').addEventListener('click', () => setCentury(index - 1));
  $('next').addEventListener('click', () => setCentury(index + 1));

  return {
    setYear,
    setLoading(loading) {
      panel.classList.toggle('loading', loading);
    },
  };
})();

/* ---------- Controles ---------- */

function ensureSatellite() {
  satellitePromise ??= Promise.all([
    loadImage(DATA.blueMarble),
    loadImage(DATA.water).catch(() => null),
  ]).then(([color, specular]) => globe.setSatelliteMaps({ color, bump: elevationImage, specular }));
  return satellitePromise;
}

async function selectStyle(button) {
  const style = button.dataset.style;
  document.querySelectorAll('[data-style]').forEach((b) => b.setAttribute('aria-pressed', b === button));
  if (style === 'satellite') {
    button.classList.add('loading');
    try {
      await ensureSatellite();
    } catch (err) {
      console.error(err);
      satellitePromise = null;
      showToast('No se pudo cargar la imagen satelital.');
      button.classList.remove('loading');
      selectStyle(document.querySelector('[data-style="physical"]'));
      return;
    }
    button.classList.remove('loading');
    // El usuario pudo cambiar de estilo mientras se descargaba la imagen.
    if (button.getAttribute('aria-pressed') !== 'true') return;
  }
  globe.setStyle(style);
}

document.querySelectorAll('[data-style]').forEach((button) =>
  button.addEventListener('click', () => selectStyle(button)),
);
$('political').addEventListener('change', (e) => setPoliticalEnabled(e.target.checked));
$('graticule').addEventListener('change', (e) => (globe.graticuleVisible = e.target.checked));
$('features').addEventListener('change', (e) => {
  for (const key of FEATURE_GROUPS) labels.setGroupVisible(key, e.target.checked);
});
$('zoom-in').addEventListener('click', () => globe.zoomBy(0.5));
$('zoom-out').addEventListener('click', () => globe.zoomBy(2));
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, button, textarea, select')) return;
  if (e.key === '+' || e.key === '=') globe.zoomBy(0.6);
  else if (e.key === '-' || e.key === '_') globe.zoomBy(1 / 0.6);
});
reliefInput.addEventListener('input', () => {
  globe.reliefScale = (reliefInput.value / 100) * MAX_RELIEF;
});
$('rotate').addEventListener('change', (e) => (globe.autoRotate = e.target.checked));
$('reset').addEventListener('click', () =>
  globe.flyTo(INITIAL_VIEW.lat, INITIAL_VIEW.lon, globe.fitDistance()),
);

if (await initPhysicalMap()) timeline.setYear(INITIAL_YEAR);
