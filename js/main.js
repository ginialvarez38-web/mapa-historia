import { feature } from 'topojson-client';
import { Globe } from './globe.js';
import { DATA, INITIAL_VIEW } from './config.js';
import { buildPhysicalMap, buildReliefCanvas } from './physicalMap.js';

const $ = (id) => document.getElementById(id);
const loader = $('loader');
const loaderText = $('loader-text');
const coords = $('coords');
const toast = $('toast');

const globe = new Globe($('globe'));
globe.setView(INITIAL_VIEW.lat, INITIAL_VIEW.lon);

let elevationImage = null;
let satellitePromise = null;

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

// Deja que el navegador pinte el mensaje de carga antes de un cálculo largo.
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

function setLoading(text) {
  loaderText.textContent = text;
}

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (toast.hidden = true), 5000);
}

async function init() {
  try {
    setLoading('Cargando líneas de costa y relieve…');
    const [land, elevation] = await Promise.all([
      loadLand(),
      loadImage(DATA.elevation).catch((err) => {
        console.warn(err);
        return null;
      }),
    ]);
    elevationImage = elevation;

    setLoading('Dibujando el mapa físico…');
    await nextPaint();
    // En pantallas táctiles (móviles) se limita la textura para ahorrar memoria.
    const preferred = matchMedia('(pointer: coarse)').matches ? 4096 : 8192;
    const width = Math.min(preferred, globe.maxTextureSize);
    const relief = elevation ? buildReliefCanvas(elevation, Math.min(width, 4096)) : null;
    globe.setPhysicalMap(buildPhysicalMap({ land, relief, width }));

    loader.classList.add('hidden');
    if (!elevation) showToast('No se pudo cargar el relieve; se muestra solo la silueta de los continentes.');
  } catch (err) {
    console.error(err);
    loader.classList.add('error');
    setLoading('No se pudieron cargar los datos del mapa. Comprueba tu conexión y recarga la página.');
  }
}

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

function formatCoord(value, positive, negative) {
  return `${Math.abs(value).toFixed(1)}° ${value >= 0 ? positive : negative}`;
}

globe.onHover = (point) => {
  coords.textContent = point
    ? `${formatCoord(point.lat, 'N', 'S')} · ${formatCoord(point.lon, 'E', 'O')}`
    : '';
  coords.classList.toggle('visible', Boolean(point));
};

document.querySelectorAll('[data-style]').forEach((button) =>
  button.addEventListener('click', () => selectStyle(button)),
);
$('graticule').addEventListener('change', (e) => (globe.graticuleVisible = e.target.checked));
$('rotate').addEventListener('change', (e) => (globe.autoRotate = e.target.checked));
$('reset').addEventListener('click', () =>
  globe.flyTo(INITIAL_VIEW.lat, INITIAL_VIEW.lon, globe.fitDistance()),
);

init();
