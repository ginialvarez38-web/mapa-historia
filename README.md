# Atlas Histórico 3D

Mapa interactivo de la historia del mundo sobre un globo terráqueo en 3D.
El objetivo es mostrar la distribución política del mundo en distintos siglos.

**Fase actual:** globo físico, sin capa política.

## Funciones

- Globo 3D con [Three.js](https://threejs.org/): girar, acercar y doble clic para volar a un punto.
- **Mapa físico** generado en el navegador: costas de Natural Earth, relieve sombreado y
  tintas hipsométricas a partir de un modelo de elevación.
- **Vista satélite** (NASA Blue Marble) con relieve y brillo del agua.
- Atmósfera, estrellas, cuadrícula de meridianos y paralelos cada 15°.
- Coordenadas bajo el cursor.

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
| `js/config.js`       | URLs de datos y vista inicial                               |

La textura se dibuja en proyección equirectangular a partir de GeoJSON
(`geoToPath` en `js/physicalMap.js`); las futuras capas políticas por siglo podrán
dibujarse del mismo modo sobre el globo.

## Datos

- Costas: [Natural Earth](https://www.naturalearthdata.com/) vía `world-atlas` (dominio público).
- Relieve e imagen satelital: [NASA Visible Earth](https://visibleearth.nasa.gov/) vía `three-globe`.
