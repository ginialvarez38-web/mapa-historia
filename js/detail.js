// Parche de detalle: al acercarse, la zona que se está mirando se vuelve a
// dibujar en un lienzo propio a mucha más resolución que la textura global
// y se coloca sobre el globo como un trozo de esfera con su propio relieve.
// Se pinta primero con los datos globales (inmediato) y luego se afina con
// teselas de elevación de alta resolución cuando llegan.

import * as THREE from 'three';
import { EARTH_RADIUS, vector3ToLatLon } from './globe.js';
import { drawWindow } from './geo.js';

const DEG = Math.PI / 180;
const COARSE = matchMedia('(pointer: coarse)').matches;
const START_ALTITUDE = 1.2; // por debajo de esta altura se activa el detalle
const CANVAS_WIDTH = COARSE ? 1536 : 3072;
const DEM_WIDTH = COARSE ? 768 : 1536; // rejilla de elevación (se amplía suavemente)
const MESH_SEGMENTS = COARSE ? 160 : 256;
const LINE_SCALE = COARSE ? 1.3 : 1.7; // grosor de líneas en píxeles del parche
const SETTLE_MS = 160; // espera a que la cámara se detenga antes de redibujar
// Escalas ligeramente mayores que la Tierra y que la capa política global.
const PHYSICAL_SCALE = 1.0004;
const POLITICAL_SCALE = 1.0016;

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export class DetailView {
  /** PhysicalMap con el que se dibuja el mapa físico. */
  physicalMap = null;
  /** PoliticalLayer actual (o null). */
  politicalLayer = null;
  /** (view, width, height) => Promise<{ land, sea, height }> con elevación de alta resolución. */
  elevationSource = null;
  /** Imagen satelital global (equirectangular) para pintar al instante, o null. */
  satelliteBase = null;
  /** (view, width, height) => Promise<canvas> con fotos satelitales de alta resolución. */
  imagerySource = null;
  worldWidth = 8192;

  #view = null;
  #token = 0;
  #demCache = null; // { key, dem } de la última ventana afinada
  #viewKey = null;
  #size = null;
  #satelliteKey = null; // ventana para la que está pintada la foto satelital
  #satelliteToken = 0;
  #shared = { elevation: null, water: null }; // texturas compartidas por los parches
  #lastCamera = new THREE.Vector3();
  #lastMove = 0;

  constructor(globe) {
    this.globe = globe;
    const geometry = new THREE.BufferGeometry();
    this.physical = new THREE.Mesh(
      geometry,
      new THREE.MeshPhongMaterial({ specular: 0x506070, shininess: 28, bumpScale: 1.5 }),
    );
    this.physical.scale.setScalar(PHYSICAL_SCALE);
    // La malla global es más gruesa y en los valles podría asomar por encima
    // del parche: este se dibuja después de lo opaco y borrando antes la
    // profundidad, de modo que siempre queda delante.
    this.physical.renderOrder = 1;
    this.physical.onBeforeRender = (renderer) => renderer.clearDepth();
    this.political = new THREE.Mesh(
      geometry,
      new THREE.MeshPhongMaterial({ transparent: true, depthWrite: false, specular: 0x111111, shininess: 6 }),
    );
    this.political.scale.setScalar(POLITICAL_SCALE);
    this.satellite = new THREE.Mesh(
      geometry,
      new THREE.MeshPhongMaterial({ specular: 0x4a5a6a, shininess: 24, bumpScale: 1.2 }),
    );
    this.satellite.scale.setScalar(PHYSICAL_SCALE);
    this.satellite.renderOrder = 1;
    this.satellite.onBeforeRender = (renderer) => renderer.clearDepth();
    this.physical.visible = false;
    this.political.visible = false;
    this.satellite.visible = false;
    globe.scene.add(this.physical, this.satellite, this.political);
  }

  /** Vuelve a pintar la foto satelital (p. ej. al mejorar la imagen global). */
  refreshSatellite() {
    this.#satelliteKey = null;
  }

  /** Obliga a redibujar (p. ej. al cambiar de siglo o cargar datos nuevos). */
  invalidate() {
    this.#view = null;
  }

  /** Se llama en cada fotograma. */
  update() {
    const { camera } = this.globe;
    const now = performance.now();
    if (camera.position.distanceToSquared(this.#lastCamera) > 1e-12) {
      this.#lastCamera.copy(camera.position);
      this.#lastMove = now;
    }

    const altitude = this.globe.altitude;
    if (!this.physicalMap || altitude > START_ALTITUDE) {
      this.#setVisible(false);
      return;
    }

    const { lat, lon } = vector3ToLatLon(camera.position);
    const halfSpan = this.#halfSpan(altitude);
    if (!this.#covers(lat, lon, halfSpan) && now - this.#lastMove > SETTLE_MS) {
      this.#paint(this.#windowAround(lat, lon, halfSpan));
    }
    if (this.#view && !this.globe.isPhysicalStyle && this.#satelliteKey !== this.#viewKey) {
      this.#paintSatellite();
    }
    if (this.#view) {
      for (const mesh of [this.physical, this.satellite, this.political]) {
        mesh.material.displacementScale = this.globe.reliefScale;
      }
    }
    this.#setVisible(Boolean(this.#view));
  }

  #setVisible(active) {
    this.physical.visible = active && this.globe.isPhysicalStyle;
    this.satellite.visible =
      active && !this.globe.isPhysicalStyle && Boolean(this.satellite.material.map) && this.#satelliteKey === this.#viewKey;
    const political = active && this.globe.politicalVisible && Boolean(this.political.material.map);
    this.political.visible = political;
    this.globe.politicalDetailActive = political;
  }

  /** Semiamplitud en latitud (grados) de la ventana para una altura dada. */
  #halfSpan(altitude) {
    const { camera } = this.globe;
    const vfov = camera.fov * DEG;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const diagonal = Math.hypot(Math.tan(vfov / 2), Math.tan(hfov / 2));
    const horizon = Math.acos(EARTH_RADIUS / (EARTH_RADIUS + altitude));
    const visible = Math.min(altitude * diagonal, horizon) / DEG;
    return THREE.MathUtils.clamp(visible * 1.4, 0.3, 70);
  }

  #windowAround(lat, lon, latHalf) {
    // Centro redondeado a una rejilla para no redibujar por movimientos mínimos.
    const step = latHalf / 4;
    const cLat = THREE.MathUtils.clamp(Math.round(lat / step) * step, -89, 89);
    const cLon = Math.round(lon / step) * step;
    const lonHalf = Math.min(latHalf / Math.max(Math.cos(cLat * DEG), 0.05), 180);
    return {
      west: cLon - lonHalf,
      east: cLon + lonHalf,
      south: Math.max(cLat - latHalf, -90),
      north: Math.min(cLat + latHalf, 90),
      latHalf,
    };
  }

  /** ¿La ventana actual cubre el centro de la vista con margen y a la escala adecuada? */
  #covers(lat, lon, latHalf) {
    const view = this.#view;
    if (!view) return false;
    const ratio = latHalf / view.latHalf;
    if (ratio < 0.6 || ratio > 1.3) return false;
    const lonMid = (view.west + view.east) / 2;
    const dLon = Math.abs(((((lon - lonMid) % 360) + 540) % 360) - 180);
    const latMid = (view.south + view.north) / 2;
    return (
      dLon < (view.east - view.west) * 0.2 &&
      Math.abs(lat - latMid) < (view.north - view.south) * 0.2
    );
  }

  #paint(view) {
    const token = ++this.#token;
    this.#view = view;
    const lonSpan = view.east - view.west;
    const latSpan = view.north - view.south;
    const width = CANVAS_WIDTH;
    const height = THREE.MathUtils.clamp(Math.round((width * latSpan) / lonSpan), 64, width);
    const size = { width, height };

    this.#setGeometry(view);
    const key = `${view.west},${view.east},${view.south},${view.north}`;
    this.#viewKey = key;
    this.#size = size;
    if (this.#demCache?.key === key) {
      this.#compose(view, size, this.#demCache.dem);
      return;
    }
    this.#compose(view, size, null);

    if (this.elevationSource) {
      const demHeight = Math.max(32, Math.round((DEM_WIDTH * height) / width));
      this.elevationSource(view, DEM_WIDTH, demHeight)
        .then((dem) => {
          this.#demCache = { key, dem };
          if (token === this.#token) this.#compose(view, size, dem);
        })
        .catch((err) => console.warn(err));
    }
  }

  #setGeometry(view) {
    const lonSpan = view.east - view.west;
    const latSpan = view.north - view.south;
    const geometry = new THREE.SphereGeometry(
      EARTH_RADIUS,
      MESH_SEGMENTS,
      Math.max(16, Math.round((MESH_SEGMENTS * latSpan) / lonSpan)),
      (view.west + 180) * DEG,
      lonSpan * DEG,
      (90 - view.north) * DEG,
      latSpan * DEG,
    );
    this.physical.geometry.dispose();
    this.physical.geometry = geometry;
    this.political.geometry = geometry;
    this.satellite.geometry = geometry;
  }

  /** Dibuja las texturas del parche; dem (opcional) aporta relieve y batimetría finos. */
  #compose(view, { width, height }, dem) {
    const map = this.physicalMap;
    const W = this.worldWidth;
    const detail = { detail: true };

    const physical = makeCanvas(width, height);
    const pctx = physical.getContext('2d');
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = 'high';
    if (dem) {
      pctx.drawImage(dem.sea, 0, 0, width, height);
      drawWindow(pctx, view, W, (scale) => {
        map.drawLand(
          pctx,
          (c) => {
            c.save();
            c.setTransform(1, 0, 0, 1, 0, 0); // el recorte se conserva
            c.drawImage(dem.land, 0, 0, width, height);
            c.restore();
          },
          detail,
        );
        map.drawVectors(pctx, scale, LINE_SCALE, detail);
      });
    } else {
      drawWindow(pctx, view, W, (scale) => map.draw(pctx, scale, LINE_SCALE, detail));
    }

    const water = makeCanvas(width / 2, height / 2);
    const wctx = water.getContext('2d');
    drawWindow(wctx, view, W, () => map.drawWater(wctx, detail));

    let elevation = dem?.height;
    if (!elevation) {
      elevation = makeCanvas(width / 2, height / 2);
      const ectx = elevation.getContext('2d');
      drawWindow(ectx, view, W, () => map.drawElevation(ectx));
    }

    let political = null;
    if (this.politicalLayer) {
      political = makeCanvas(width, height);
      const lctx = political.getContext('2d');
      drawWindow(lctx, view, W, (scale) => this.politicalLayer.drawTo(lctx, scale, LINE_SCALE));
    }

    const anisotropy = this.globe.renderer.capabilities.getMaxAnisotropy();
    const texture = (canvas, srgb) => {
      const t = new THREE.CanvasTexture(canvas);
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = anisotropy;
      return t;
    };
    const elevationTexture = texture(elevation, false);

    const waterTexture = texture(water, false);
    this.#shared.elevation?.dispose();
    this.#shared.water?.dispose();
    this.#shared = { elevation: elevationTexture, water: waterTexture };

    const pm = this.physical.material;
    pm.map?.dispose();
    Object.assign(pm, {
      map: texture(physical, true),
      specularMap: waterTexture,
      displacementMap: elevationTexture,
      bumpMap: elevationTexture,
      displacementScale: this.globe.reliefScale,
    });
    pm.needsUpdate = true;

    // La foto satelital comparte relieve y máscara de agua con el parche físico.
    Object.assign(this.satellite.material, {
      specularMap: waterTexture,
      displacementMap: elevationTexture,
      bumpMap: elevationTexture,
    });
    this.satellite.material.needsUpdate = true;

    const lm = this.political.material;
    lm.map?.dispose();
    Object.assign(lm, {
      map: political ? texture(political, true) : null,
      displacementMap: elevationTexture,
      displacementScale: this.globe.reliefScale,
    });
    lm.needsUpdate = true;
  }

  /** Foto satelital del parche: al instante con la imagen global y luego en alta resolución. */
  #paintSatellite() {
    const view = this.#view;
    const key = this.#viewKey;
    const { width, height } = this.#size;
    const token = ++this.#satelliteToken;
    this.#satelliteKey = key;

    const base = makeCanvas(width, height);
    if (this.satelliteBase) {
      const ctx = base.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const image = this.satelliteBase;
      drawWindow(ctx, view, this.worldWidth, () => ctx.drawImage(image, 0, 0, this.worldWidth, this.worldWidth / 2));
    }
    this.#setSatelliteTexture(base);

    this.imagerySource?.(view, width, height)
      .then((photo) => {
        if (token !== this.#satelliteToken) return;
        // Debajo, la imagen global (cubre los polos, fuera de Web Mercator).
        base.getContext('2d').drawImage(photo, 0, 0);
        this.#setSatelliteTexture(base);
      })
      .catch((err) => console.warn(err));
  }

  #setSatelliteTexture(canvas) {
    const material = this.satellite.material;
    material.map?.dispose();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.globe.renderer.capabilities.getMaxAnisotropy();
    material.map = texture;
    material.needsUpdate = true;
  }
}
