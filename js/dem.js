// Modelo digital de elevación a partir de las teselas públicas «Terrain
// Tiles» de AWS (formato terrarium, proyección Web Mercator). Incluye la
// batimetría de los océanos. Se reproyecta a equirectangular y se sombrea.

const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE = 256;
const MAX_LAT = 85.0511; // límite de Web Mercator
const MAX_CACHED_TILES = 320;
const DEG = Math.PI / 180;
const METERS_PER_DEG = 111320;

// Teselas decodificadas (Int16: metros, de -32768 a 32767), clave "z/x/y".
const tiles = new Map();
const decodeCanvas = document.createElement('canvas');
decodeCanvas.width = TILE;
decodeCanvas.height = TILE;
const decodeContext = decodeCanvas.getContext('2d', { willReadFrequently: true });

function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tiles.has(key)) {
    const cached = tiles.get(key);
    tiles.delete(key); // se reinserta al final: orden de uso reciente
    tiles.set(key, cached);
    return cached;
  }
  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      decodeContext.clearRect(0, 0, TILE, TILE);
      decodeContext.drawImage(img, 0, 0);
      const px = decodeContext.getImageData(0, 0, TILE, TILE).data;
      const out = new Int16Array(TILE * TILE);
      for (let i = 0; i < out.length; i++) {
        out[i] = Math.round(px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768);
      }
      resolve(out);
    };
    img.onerror = () => reject(new Error(`No se pudo cargar la tesela de elevación ${key}`));
    img.src = `${TERRARIUM}/${key}.png`;
  });
  promise.catch(() => tiles.delete(key));
  tiles.set(key, promise);
  if (tiles.size > MAX_CACHED_TILES) tiles.delete(tiles.keys().next().value);
  return promise;
}

const mercatorY = (lat) => {
  const phi = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * DEG;
  return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
};

function tileRange(view, z) {
  const n = 2 ** z;
  const tx0 = Math.floor(((view.west + 180) / 360) * n);
  const tx1 = Math.floor((((view.east + 180) / 360) * n) - 1e-9);
  const ty0 = Math.max(0, Math.floor(mercatorY(view.north) * n));
  const ty1 = Math.min(n - 1, Math.floor(mercatorY(view.south) * n - 1e-9));
  return { tx0, tx1, ty0, ty1, count: (tx1 - tx0 + 1) * (ty1 - ty0 + 1) };
}

/**
 * Elevación (metros; negativa en el mar) de una ventana geográfica
 * { west, east, south, north } muestreada en una rejilla width × height.
 * Elige el mayor nivel de zoom que no supere maxTiles teselas.
 */
export async function fetchElevation(view, width, height, { maxTiles = 48, maxZoom = 12 } = {}) {
  const pxPerDeg = width / (view.east - view.west);
  let z = Math.min(maxZoom, Math.max(0, Math.ceil(Math.log2((pxPerDeg * 360) / TILE))));
  let range = tileRange(view, z);
  while (z > 0 && range.count > maxTiles) range = tileRange(view, --z);

  const n = 2 ** z;
  const { tx0, tx1, ty0, ty1 } = range;
  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  const mosaicWidth = cols * TILE;
  const mosaicHeight = rows * TILE;
  const mosaic = new Int16Array(mosaicWidth * mosaicHeight);

  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const x = ((tx % n) + n) % n;
      jobs.push(
        loadTile(z, x, ty).then((data) => {
          const ox = (tx - tx0) * TILE;
          const oy = (ty - ty0) * TILE;
          for (let r = 0; r < TILE; r++) {
            mosaic.set(data.subarray(r * TILE, (r + 1) * TILE), (oy + r) * mosaicWidth + ox);
          }
        }),
      );
    }
  }
  const results = await Promise.allSettled(jobs);
  if (results.every((r) => r.status === 'rejected')) throw results[0].reason;

  // Reproyección Web Mercator -> equirectangular con interpolación bilineal.
  const out = new Float32Array(width * height);
  const worldPx = n * TILE;
  const columnX = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const lon = view.west + ((x + 0.5) / width) * (view.east - view.west);
    columnX[x] = Math.min(Math.max(((lon + 180) / 360) * worldPx - tx0 * TILE - 0.5, 0), mosaicWidth - 1.001);
  }
  for (let y = 0; y < height; y++) {
    const lat = view.north - ((y + 0.5) / height) * (view.north - view.south);
    const my = Math.min(Math.max(mercatorY(lat) * worldPx - ty0 * TILE - 0.5, 0), mosaicHeight - 1.001);
    const y0 = Math.floor(my);
    const fy = my - y0;
    const rowA = y0 * mosaicWidth;
    const rowB = Math.min(y0 + 1, mosaicHeight - 1) * mosaicWidth;
    for (let x = 0; x < width; x++) {
      const mx = columnX[x];
      const x0 = Math.floor(mx);
      const fx = mx - x0;
      const top = mosaic[rowA + x0] * (1 - fx) + mosaic[rowA + x0 + 1] * fx;
      const bottom = mosaic[rowB + x0] * (1 - fx) + mosaic[rowB + x0 + 1] * fx;
      out[y * width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return out;
}

/* ---------- Sombreado ---------- */

// Tintas hipsométricas (tierra) y batimétricas (mar), en metros.
const LAND_RAMP = [
  [0, [112, 156, 96]],
  [150, [138, 176, 106]],
  [400, [182, 196, 128]],
  [800, [212, 196, 138]],
  [1500, [198, 162, 112]],
  [2500, [168, 130, 98]],
  [3600, [150, 128, 116]],
  [4500, [214, 208, 202]],
  [6000, [250, 250, 250]],
];
const SEA_RAMP = [
  [0, [190, 226, 240]],
  [-120, [160, 208, 232]],
  [-500, [126, 182, 218]],
  [-1500, [96, 150, 198]],
  [-3500, [70, 120, 176]],
  [-5500, [50, 94, 150]],
  [-9000, [34, 66, 116]],
];
const LIGHT = (() => {
  const v = [-1, -1, 1.5];
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
})();

function lut(ramp, from, to, step) {
  const size = Math.floor(Math.abs(to - from) / step) + 1;
  const out = new Uint8ClampedArray(size * 3);
  const sign = Math.sign(to - from);
  for (let i = 0; i < size; i++) {
    const e = from + sign * i * step;
    let j = 1;
    while (j < ramp.length - 1 && (sign > 0 ? ramp[j][0] < e : ramp[j][0] > e)) j++;
    const [e0, c0] = ramp[j - 1];
    const [e1, c1] = ramp[j];
    const t = Math.min(Math.max((e - e0) / (e1 - e0), 0), 1);
    for (let k = 0; k < 3; k++) out[i * 3 + k] = c0[k] + (c1[k] - c0[k]) * t;
  }
  return { out, size, step };
}
const LAND_LUT = lut(LAND_RAMP, 0, 9000, 10);
const SEA_LUT = lut(SEA_RAMP, 0, -11000, 10);

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Convierte una rejilla de elevación en tres lienzos del mismo tamaño:
 *   land:   tintas hipsométricas con sombreado de laderas,
 *   sea:    tintas batimétricas con un sombreado suave del fondo marino,
 *   height: altura en grises (0 = nivel del mar, 255 = 8848 m) para el relieve 3D.
 */
export function shadeElevation(elevation, width, height, view) {
  const land = makeCanvas(width, height);
  const sea = makeCanvas(width, height);
  const heightMap = makeCanvas(width, height);
  const landCtx = land.getContext('2d');
  const seaCtx = sea.getContext('2d');
  const heightCtx = heightMap.getContext('2d');
  const landImg = landCtx.createImageData(width, height);
  const seaImg = seaCtx.createImageData(width, height);
  const heightImg = heightCtx.createImageData(width, height);
  const L = landImg.data;
  const S = seaImg.data;
  const H = heightImg.data;

  const lonStep = (view.east - view.west) / width;
  const latStep = (view.north - view.south) / height;
  const wraps = view.east - view.west >= 359.9;
  const dy = latStep * METERS_PER_DEG;
  // Exageración vertical del sombreado: mayor cuanto más grande es el píxel.
  const exaggeration = Math.min(Math.max(1.3 + (lonStep * METERS_PER_DEG) / 2200, 1.3), 12);
  const [lx, ly, lz] = LIGHT;

  for (let y = 0; y < height; y++) {
    const lat = view.north - (y + 0.5) * latStep;
    const dx = Math.max(lonStep * METERS_PER_DEG * Math.cos(lat * DEG), 1);
    const row = y * width;
    const up = Math.max(y - 1, 0) * width;
    const down = Math.min(y + 1, height - 1) * width;
    for (let x = 0; x < width; x++) {
      const left = x > 0 ? x - 1 : wraps ? width - 1 : 0;
      const right = x < width - 1 ? x + 1 : wraps ? 0 : width - 1;
      const i = row + x;
      const e = elevation[i];
      const dzdx = ((elevation[row + right] - elevation[row + left]) / (2 * dx)) * exaggeration;
      const dzdy = ((elevation[down + x] - elevation[up + x]) / (2 * dy)) * exaggeration;
      const shade = (-dzdx * lx - dzdy * ly + lz) / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1) / lz;
      const p = i * 4;

      const li = Math.min(Math.max(Math.round(e / 10), 0), LAND_LUT.size - 1) * 3;
      const lf = 1 + (shade - 1) * 0.9;
      L[p] = LAND_LUT.out[li] * lf;
      L[p + 1] = LAND_LUT.out[li + 1] * lf;
      L[p + 2] = LAND_LUT.out[li + 2] * lf;
      L[p + 3] = 255;

      const si = Math.min(Math.max(Math.round(-e / 10), 0), SEA_LUT.size - 1) * 3;
      const sf = 1 + (shade - 1) * 0.4;
      S[p] = SEA_LUT.out[si] * sf;
      S[p + 1] = SEA_LUT.out[si + 1] * sf;
      S[p + 2] = SEA_LUT.out[si + 2] * sf;
      S[p + 3] = 255;

      const g = Math.min(Math.max(e / 8848, 0), 1) * 255;
      H[p] = H[p + 1] = H[p + 2] = g;
      H[p + 3] = 255;
    }
  }
  landCtx.putImageData(landImg, 0, 0);
  seaCtx.putImageData(seaImg, 0, 0);
  heightCtx.putImageData(heightImg, 0, 0);
  return { land, sea, height: heightMap };
}
