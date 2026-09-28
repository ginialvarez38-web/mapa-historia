// Fotos satelitales en alta resolución a partir de teselas Web Mercator,
// reproyectadas a equirectangular para colocarlas sobre el globo.

const TILE = 256;
const MAX_LAT = 85.0511; // límite de Web Mercator
const DEG = Math.PI / 180;
const MAX_CACHED_TILES = 400;

// Proveedores por orden de preferencia; si uno falla se pasa al siguiente.
export const PROVIDERS = [
  {
    name: 'Esri World Imagery',
    attribution: 'Esri, Maxar, Earthstar Geographics',
    maxZoom: 17,
    url: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  },
  {
    name: 'Sentinel-2 cloudless (EOX)',
    attribution: 'Sentinel-2 cloudless de EOX IT Services (datos Copernicus Sentinel)',
    maxZoom: 14,
    url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`,
  },
];

let providerIndex = 0;
const tiles = new Map(); // "proveedor/z/x/y" -> Promise<HTMLImageElement>

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`No se pudo cargar ${url}`));
    img.src = url;
  });
}

async function loadTile(z, x, y) {
  while (providerIndex < PROVIDERS.length) {
    const index = providerIndex;
    const provider = PROVIDERS[index];
    const zoom = Math.min(z, provider.maxZoom);
    const shift = z - zoom;
    const key = `${index}/${zoom}/${x >> shift}/${y >> shift}`;
    let promise = tiles.get(key);
    if (!promise) {
      promise = loadImage(provider.url(zoom, x >> shift, y >> shift));
      tiles.set(key, promise);
      if (tiles.size > MAX_CACHED_TILES) tiles.delete(tiles.keys().next().value);
    }
    try {
      const img = await promise;
      // Si el proveedor no llega a este zoom, se recorta la parte de la tesela padre.
      if (!shift) return { img, sx: 0, sy: 0, size: TILE };
      const size = TILE >> shift;
      const mask = (1 << shift) - 1;
      return { img, sx: (x & mask) * size, sy: (y & mask) * size, size };
    } catch (err) {
      tiles.delete(key);
      // Un fallo de red o de CORS: se prueba con el siguiente proveedor.
      if (providerIndex === index) providerIndex++;
      if (providerIndex >= PROVIDERS.length) throw err;
    }
  }
  throw new Error('No hay proveedores de imágenes satelitales disponibles');
}

const mercatorY = (lat) => {
  const phi = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * DEG;
  return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
};

function tileRange(view, z) {
  const n = 2 ** z;
  const tx0 = Math.floor(((view.west + 180) / 360) * n);
  const tx1 = Math.floor(((view.east + 180) / 360) * n - 1e-9);
  const ty0 = Math.max(0, Math.floor(mercatorY(view.north) * n));
  const ty1 = Math.min(n - 1, Math.floor(mercatorY(view.south) * n - 1e-9));
  return { tx0, tx1, ty0, ty1, count: (tx1 - tx0 + 1) * (ty1 - ty0 + 1) };
}

/** Nombre del proveedor que se está usando (para los créditos). */
export function currentProvider() {
  return PROVIDERS[Math.min(providerIndex, PROVIDERS.length - 1)];
}

/**
 * Foto satelital de la ventana { west, east, south, north } como lienzo
 * equirectangular de width × height. Las latitudes que Web Mercator no
 * cubre (más allá de ±85°) quedan transparentes para ver lo que haya debajo.
 */
export async function fetchImagery(view, width, height, { maxTiles = 96, maxZoom = 17 } = {}) {
  const pxPerDeg = width / (view.east - view.west);
  let z = Math.min(maxZoom, Math.max(0, Math.ceil(Math.log2((pxPerDeg * 360) / TILE))));
  let range = tileRange(view, z);
  while (z > 0 && range.count > maxTiles) range = tileRange(view, --z);

  const n = 2 ** z;
  const { tx0, tx1, ty0, ty1 } = range;
  const mosaic = document.createElement('canvas');
  mosaic.width = (tx1 - tx0 + 1) * TILE;
  mosaic.height = (ty1 - ty0 + 1) * TILE;
  const mctx = mosaic.getContext('2d');

  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        loadTile(z, ((tx % n) + n) % n, ty).then(({ img, sx, sy, size }) => {
          mctx.drawImage(img, sx, sy, size, size, (tx - tx0) * TILE, (ty - ty0) * TILE, TILE, TILE);
        }),
      );
    }
  }
  const results = await Promise.allSettled(jobs);
  if (results.every((r) => r.status === 'rejected')) throw results[0].reason;

  // Reproyección por filas: en Mercator la x es lineal con la longitud, así
  // que cada fila de salida es un trozo horizontal de una fila del mosaico.
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const worldPx = n * TILE;
  const srcX = ((view.west + 180) / 360) * worldPx - tx0 * TILE;
  const srcW = ((view.east - view.west) / 360) * worldPx;
  for (let y = 0; y < height; y++) {
    const lat = view.north - ((y + 0.5) / height) * (view.north - view.south);
    if (Math.abs(lat) > MAX_LAT) continue;
    const my = mercatorY(lat) * worldPx - ty0 * TILE;
    const sy = Math.min(Math.max(my - 0.5, 0), mosaic.height - 1);
    ctx.drawImage(mosaic, srcX, sy, srcW, 1, 0, y, width, 1);
  }
  return out;
}
