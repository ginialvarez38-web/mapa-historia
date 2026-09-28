// Catálogo de mapas políticos históricos (proyecto historical-basemaps de
// A. Ourednik) y utilidades para expresar años y siglos en español.

const SOURCES = [
  'https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson',
  'https://cdn.jsdelivr.net/gh/aourednik/historical-basemaps@master/geojson',
];

// Años con mapa disponible; los negativos son antes de Cristo.
const SNAPSHOT_YEARS = [
  -3000, -2000, -1500, -1000, -700, -500, -400, -323, -300, -200, -100, -1,
  100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1279, 1300,
  1400, 1492, 1500, 1530, 1600, 1650, 1700, 1715, 1783, 1800, 1815, 1880,
  1900, 1914, 1920, 1930, 1938, 1945, 1960, 1994, 2000, 2010,
];

const ROMAN = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

function toRoman(n) {
  let out = '';
  for (const [value, symbol] of ROMAN) {
    while (n >= value) {
      out += symbol;
      n -= value;
    }
  }
  return out;
}

/** Siglo de un año: 1492 -> 15, -323 -> -4 (no existe el año 0). */
export function centuryOf(year) {
  const n = Math.ceil(Math.abs(year) / 100);
  return year < 0 ? -n : n;
}

export function centuryLabel(century) {
  return `Siglo ${toRoman(Math.abs(century))}${century < 0 ? ' a.C.' : ''}`;
}

export function yearLabel(year) {
  return year < 0 ? `${-year} a.C.` : `${year}`;
}

/**
 * Siglos con mapa, en orden cronológico. Cada uno lleva sus años
 * disponibles y un año por defecto (el más cercano a mitad de siglo).
 */
export const CENTURIES = (() => {
  const byCentury = new Map();
  for (const year of SNAPSHOT_YEARS) {
    const century = centuryOf(year);
    if (!byCentury.has(century)) byCentury.set(century, []);
    byCentury.get(century).push(year);
  }
  return [...byCentury].map(([century, years]) => {
    const middle = century > 0 ? century * 100 - 50 : century * 100 + 50;
    const defaultYear = years.reduce((best, y) =>
      Math.abs(y - middle) < Math.abs(best - middle) ? y : best,
    );
    return { century, label: centuryLabel(century), years, defaultYear };
  });
})();

function fileName(year) {
  return `world_${year < 0 ? `bc${-year}` : year}.geojson`;
}

/** Descarga el GeoJSON de un año, probando cada servidor por orden. */
export async function fetchSnapshot(year, { signal } = {}) {
  let lastError;
  for (const base of SOURCES) {
    try {
      const res = await fetch(`${base}/${fileName(year)}`, { signal });
      if (!res.ok) throw new Error(`${res.status} al cargar el mapa de ${yearLabel(year)}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastError = err;
    }
  }
  throw lastError;
}
