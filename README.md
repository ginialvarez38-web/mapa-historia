# Atlas Histórico 3D

Mapa interactivo de la historia del mundo sobre un globo terráqueo en 3D.
El objetivo es mostrar la distribución política del mundo en distintos siglos.

**Fase actual:** globo físico con capa política y selector de siglo.

## Funciones

- Globo 3D con [Three.js](https://threejs.org/): girar, acercar y doble clic para volar a un punto.
- **Mapa físico** generado en el navegador: costas de Natural Earth, relieve sombreado y
  tintas hipsométricas a partir de un modelo de elevación.
- **Vista satélite** (NASA Blue Marble) con relieve y brillo del agua.
- Atmósfera, estrellas, cuadrícula de meridianos y paralelos cada 15°.
- **Capa política por siglo** (del siglo XXX a.C. al XXI): deslizador de siglos, botones
  ‹ › y, cuando un siglo tiene varios mapas, botones para cada año (p. ej. 1914, 1938, 1945…).
- Cada estado tiene su color; los territorios dependientes toman el color de su metrópoli.
- Nombres sobre el globo, que aparecen o desaparecen según el zoom sin solaparse.
- Al pasar el ratón (o tocar en el móvil) se resalta el estado y se muestra su nombre,
  de quién depende y las coordenadas.

## Ejecutar en local

Es una web estática sin paso de compilación, pero los módulos ES necesitan un servidor
(no funciona abriendo `index.html` con doble clic):

```bash
python3 -m http.server 8000
# o bien: npx http-server -p 8000
```

y abre <http://localhost:8000>. Hace falta conexión a internet: Three.js y los datos
se descargan de jsDelivr.

## Estructura

| Archivo              | Contenido                                                   |
| -------------------- | ----------------------------------------------------------- |
| `index.html`         | Página, controles e *import map* de dependencias            |
| `css/style.css`      | Estilos de la interfaz                                      |
| `js/main.js`         | Carga de datos y conexión de la interfaz con el globo       |
| `js/globe.js`        | Escena 3D: Tierra, atmósfera, cámara, controles, animaciones |
| `js/physicalMap.js`  | Genera la textura del mapa físico en un `<canvas>`          |
| `js/politicalMap.js` | Capa política: colores, textura de fronteras y detección bajo el cursor |
| `js/labels.js`       | Nombres de los estados sobre el globo                       |
| `js/history.js`      | Catálogo de años/siglos disponibles y descarga de los mapas |
| `js/geo.js`          | Proyección de GeoJSON a lienzo (incluido el antimeridiano)  |
| `js/config.js`       | URLs de datos y vista inicial                               |

Las texturas se dibujan en proyección equirectangular a partir de GeoJSON
(`polygonsToPath` en `js/geo.js`). La capa política va en una esfera algo mayor que la
Tierra, por lo que funciona igual sobre el mapa físico y sobre el satélite.

Para añadir o quitar años, edita `SNAPSHOT_YEARS` en `js/history.js`.

## Datos

- Fronteras históricas: [historical-basemaps](https://github.com/aourednik/historical-basemaps)
  de André Ourednik (consulta su licencia en el repositorio). Es un trabajo en curso: las fronteras son aproximadas y los
  nombres están en inglés.
- Costas: [Natural Earth](https://www.naturalearthdata.com/) vía `world-atlas` (dominio público).
- Relieve e imagen satelital: [NASA Visible Earth](https://visibleearth.nasa.gov/) vía `three-globe`.
