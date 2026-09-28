// Utilidades geográficas compartidas: recorrer GeoJSON y proyectarlo en
// coordenadas equirectangulares de un lienzo (x: longitud, y: latitud).

/** Devuelve la lista de polígonos (arrays de anillos) de cualquier GeoJSON. */
export function collectPolygons(geojson, out = []) {
  if (!geojson) return out;
  switch (geojson.type) {
    case 'FeatureCollection':
      geojson.features.forEach((f) => collectPolygons(f, out));
      break;
    case 'Feature':
      collectPolygons(geojson.geometry, out);
      break;
    case 'GeometryCollection':
      geojson.geometries.forEach((g) => collectPolygons(g, out));
      break;
    case 'Polygon':
      out.push(geojson.coordinates);
      break;
    case 'MultiPolygon':
      out.push(...geojson.coordinates);
      break;
  }
  return out;
}

/**
 * Hace continua la longitud de un anillo que cruza el antimeridiano
 * (puede quedar fuera de [-180, 180]). Si el anillo rodea un polo, como la
 * Antártida, se cierra pasando por ese polo para que el relleno sea correcto.
 */
export function unwrapRing(ring) {
  const out = [];
  let offset = 0;
  let latSum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lon, lat] = ring[i];
    if (i > 0) {
      const delta = lon - ring[i - 1][0];
      if (delta > 180) offset -= 360;
      else if (delta < -180) offset += 360;
    }
    out.push([lon + offset, lat]);
    latSum += lat;
  }
  const drift = out[out.length - 1][0] - out[0][0];
  if (Math.abs(drift) > 180) {
    const pole = latSum < 0 ? -90 : 90;
    out.push([out[out.length - 1][0], pole], [out[0][0], pole]);
  }
  return out;
}

/**
 * Construye un Path2D equirectangular para una lista de polígonos. Los
 * anillos que se salen de [-180, 180] se dibujan también desplazados 360°
 * para que aparezcan por el otro borde del mapa. Devuelve además la caja
 * envolvente en píxeles.
 */
export function polygonsToPath(polygons, width, height) {
  const path = new Path2D();
  const px = (lon) => ((lon + 180) / 360) * width;
  const py = (lat) => ((90 - lat) / 180) * height;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const polygon of polygons) {
    for (const ring of polygon) {
      if (ring.length < 3) continue;
      const points = unwrapRing(ring);
      let minLon = Infinity;
      let maxLon = -Infinity;
      for (const [lon, lat] of points) {
        minLon = Math.min(minLon, lon);
        maxLon = Math.max(maxLon, lon);
        minY = Math.min(minY, py(lat));
        maxY = Math.max(maxY, py(lat));
      }
      for (const shift of [-360, 0, 360]) {
        if (minLon + shift >= 180 || maxLon + shift <= -180) continue;
        points.forEach(([lon, lat], i) => {
          if (i === 0) path.moveTo(px(lon + shift), py(lat));
          else path.lineTo(px(lon + shift), py(lat));
        });
        path.closePath();
        minX = Math.min(minX, Math.max(px(minLon + shift), 0));
        maxX = Math.max(maxX, Math.min(px(maxLon + shift), width));
      }
    }
  }
  return { path, bbox: [minX, minY, maxX, maxY] };
}

/** Longitud normalizada a [-180, 180). */
export function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Área (grados² corregidos por latitud) y centroide de un anillo. */
export function ringStats(ring) {
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
  if (Math.abs(area) < 1e-9) return { area: 0, lon: wrapLon(pts[0][0]), lat: pts[0][1] };
  return { area: Math.abs(area / 2) * k, lon: wrapLon(cx / (3 * area)), lat: cy / (3 * area) };
}

/**
 * Área total de unos polígonos y punto de anclaje para su nombre (centroide
 * del polígono mayor).
 */
export function polygonStats(polygons) {
  let area = 0;
  let largest = null;
  for (const polygon of polygons) {
    if (!polygon[0] || polygon[0].length < 3) continue;
    const stats = ringStats(polygon[0]);
    area += stats.area;
    if (!largest || stats.area > largest.area) largest = stats;
  }
  return largest ? { area, lat: largest.lat, lon: largest.lon } : null;
}

/** Líneas (arrays de [lon, lat]) de un GeoJSON LineString o MultiLineString. */
export function collectLines(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

/** Longitud (grados corregidos) de unas líneas y el punto medio de la más larga. */
export function lineStats(lines) {
  let total = 0;
  let best = null;
  for (const line of lines) {
    let length = 0;
    for (let i = 1; i < line.length; i++) {
      const [lon0, lat0] = line[i - 1];
      const [lon1, lat1] = line[i];
      const k = Math.cos(((lat0 + lat1) / 2) * (Math.PI / 180));
      length += Math.hypot(wrapLon(lon1 - lon0) * k, lat1 - lat0);
    }
    total += length;
    if (!best || length > best.length) best = { length, line };
  }
  if (!best || !best.line.length) return null;
  const [lon, lat] = best.line[Math.floor(best.line.length / 2)];
  return { length: total, lat, lon };
}

/** Path2D equirectangular de unas líneas (sin cerrar), con copias a ±360°. */
export function linesToPath(lines, width, height) {
  const path = new Path2D();
  const px = (lon) => ((lon + 180) / 360) * width;
  const py = (lat) => ((90 - lat) / 180) * height;
  for (const line of lines) {
    if (line.length < 2) continue;
    // Mismo desenrollado que los anillos, pero sin cerrar por el polo.
    let offset = 0;
    const points = line.map(([lon, lat], i) => {
      if (i > 0) {
        const delta = lon - line[i - 1][0];
        if (delta > 180) offset -= 360;
        else if (delta < -180) offset += 360;
      }
      return [lon + offset, lat];
    });
    const lons = points.map((p) => p[0]);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    for (const shift of [-360, 0, 360]) {
      if (minLon + shift >= 180 || maxLon + shift <= -180) continue;
      points.forEach(([lon, lat], i) => {
        if (i === 0) path.moveTo(px(lon + shift), py(lat));
        else path.lineTo(px(lon + shift), py(lat));
      });
    }
  }
  return path;
}

/**
 * Prepara un contexto 2D para dibujar en «píxeles de mundo» (mapa
 * equirectangular de ancho worldWidth) solo la ventana geográfica indicada,
 * que ocupa todo el lienzo. Llama a draw(scale) una vez por cada copia del
 * mundo necesaria si la ventana cruza el antimeridiano; scale son píxeles de
 * lienzo por píxel de mundo.
 */
export function drawWindow(ctx, view, worldWidth, draw) {
  const { west, east, south, north } = view;
  const { width, height } = ctx.canvas;
  const worldHeight = worldWidth / 2;
  const scale = width / (((east - west) / 360) * worldWidth);
  const x0 = ((west + 180) / 360) * worldWidth;
  const y0 = ((90 - north) / 180) * worldHeight;
  for (const k of [-1, 0, 1]) {
    if (west >= 180 + 360 * k || east <= -180 + 360 * k) continue;
    ctx.save();
    ctx.setTransform(scale, 0, 0, height / (((north - south) / 180) * worldHeight), 0, 0);
    ctx.translate(-x0 + k * worldWidth, -y0);
    // Cada copia dibuja solo su propio dominio [-180, 180]; lo que sobresale
    // lo pinta la copia vecina (así nada se dibuja dos veces).
    ctx.beginPath();
    ctx.rect(0, 0, worldWidth, worldHeight);
    ctx.clip();
    draw(scale);
    ctx.restore();
  }
}
