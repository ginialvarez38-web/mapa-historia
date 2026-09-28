# Atlas Histórico 3D

Mapa interactivo de la historia del mundo sobre un globo terráqueo en 3D.
El objetivo es mostrar la distribución política del mundo en distintos siglos.

**Fase actual:** globo físico con capa política y selector de siglo.

## Funciones

- Globo 3D con [Three.js](https://threejs.org/): girar, acercar y doble clic para volar a un punto.
- **Zoom** suave hacia el cursor (rueda, pellizco, botones + − o teclas + −), hasta unos 50 km
  de altura. Al acercarse, la zona visible se redibuja en alta resolución (parche de detalle).
- **Mapa físico** generado en el navegador a partir de elevación real: tintas hipsométricas,
  sombreado de laderas y batimetría (profundidad real de los océanos). Al acercarse, la zona
  visible se redibuja con teselas de elevación de más resolución y costas 1:10 millones.
- **Vista satélite** en alta resolución (teselas de Esri World Imagery, con Sentinel‑2
  cloudless de EOX como respaldo), más detallada cuanto más te acercas, con relieve y brillo del agua.
- **Relieve 3D** exagerable, océano con degradado de profundidad, ríos y lagos.
- **Accidentes geográficos** rotulados: océanos, mares, golfos, estrechos, cordilleras,
  mesetas, desiertos, penínsulas, ríos, lagos y picos con su altitud.
- Atmósfera, estrellas, cuadrícula de meridianos y paralelos cada 15°.
- **Capa política por siglo** (del siglo XXX a.C. al XXI): deslizador de siglos, botones
  ‹ › y, cuando un siglo tiene varios mapas, botones para cada año (p. ej. 1914, 1938, 1945…).
- Cada estado tiene su color; los territorios dependientes toman el color de su metrópoli.
- **Ciudades históricas** (540): solo aparecen las que existían en el año elegido y con el
  nombre de entonces (Bizancio → Constantinopla → Estambul, Tenochtitlan → Ciudad de México…).
  El tamaño del punto indica su importancia; las menores aparecen al acercarse.
- **Capitales de cada época** marcadas con una estrella roja (unos 420 periodos, incluidas las capitales actuales de casi todos los países: Toledo visigoda,
  Córdoba califal, Constantinopla bizantina y otomana, Cuzco inca…). Al pasar el ratón se indica
  de qué estado eran capital.
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
| `js/labels.js`       | Nombres sobre el globo (estados y accidentes), sin solaparse |
| `js/features.js`     | Accidentes geográficos de Natural Earth                     |
| `js/detail.js`       | Parche de detalle en alta resolución al acercarse           |
| `js/cities.js`       | Ciudades históricas: fundación, abandono, nombres y capitalidad por época |
| `js/history.js`      | Catálogo de años/siglos disponibles y descarga de los mapas |
| `js/dem.js`          | Elevación de alta resolución (teselas terrarium) y sombreado |
| `js/imagery.js`      | Fotos satelitales por teselas, reproyectadas al globo       |
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
- Ciudades históricas: recopilación propia (fechas de fundación y abandono aproximadas, sobre
  todo en la Antigüedad). Para añadir o corregir ciudades, edita la lista de `js/cities.js`.
- Costas: [Natural Earth](https://www.naturalearthdata.com/) vía `world-atlas` (dominio público).
- Ríos, lagos, regiones físicas, mares y picos: [Natural Earth](https://github.com/nvkelso/natural-earth-vector)
  (dominio público), escala 1:50 millones; nombres en español cuando están disponibles.
- Elevación y batimetría: [Terrain Tiles de AWS](https://registry.opendata.aws/terrain-tiles/)
  (Mapzen; fuentes SRTM, GMTED, ETOPO1 y otras). Si no están disponibles, se usa la imagen de
  relieve de `three-globe`.
- Fotos satelitales: [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9)
  (Esri, Maxar, Earthstar Geographics; sujeto a sus condiciones de uso) o, si no está disponible,
  [Sentinel‑2 cloudless](https://s2maps.eu) de EOX (datos Copernicus Sentinel; licencia CC BY-NC-SA).
  Imagen global de respaldo y polos: [NASA Visible Earth](https://visibleearth.nasa.gov/) vía `three-globe`.
