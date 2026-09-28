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
