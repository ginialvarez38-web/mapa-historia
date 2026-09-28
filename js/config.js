// Fuentes de datos externas (servidas por jsDelivr desde paquetes npm).
const CDN = 'https://cdn.jsdelivr.net/npm';

export const DATA = {
  // Masas de tierra de Natural Earth en TopoJSON (sin fronteras políticas).
  land: `${CDN}/world-atlas@2/land-50m.json`,
  landFallback: `${CDN}/world-atlas@2/land-110m.json`,
  // Imágenes equirectangulares incluidas en el paquete three-globe.
  elevation: `${CDN}/three-globe@2/example/img/earth-topology.png`,
  blueMarble: `${CDN}/three-globe@2/example/img/earth-blue-marble.jpg`,
  water: `${CDN}/three-globe@2/example/img/earth-water.png`,
};

// Vista con la que arranca el globo: centrada en el Mediterráneo.
export const INITIAL_VIEW = { lat: 28, lon: 18 };
