// Parche de detalle: al acercarse, la zona que se está mirando se vuelve a
// dibujar en un lienzo propio a mucha más resolución que la textura global
// (costas, ríos, lagos y fronteras nítidos) y se coloca sobre el globo como
// un trozo de esfera con el mismo relieve.

import * as THREE from 'three';
import { EARTH_RADIUS, vector3ToLatLon } from './globe.js';
import { drawWindow } from './geo.js';

const DEG = Math.PI / 180;
const START_ALTITUDE = 0.6; // por debajo de esta altura se activa el detalle
const CANVAS_WIDTH = matchMedia('(pointer: coarse)').matches ? 1024 : 2048;
const MESH_SEGMENTS = 192;
const SETTLE_MS = 160; // espera a que la cámara se detenga antes de redibujar
// Escalas ligeramente mayores que la Tierra y que la capa política global.
const PHYSICAL_SCALE = 1.0004;
const POLITICAL_SCALE = 1.0016;

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export class DetailView {
  /**
   * painters: funciones que dibujan en coordenadas de mundo (ancho worldWidth):
   *   physical(ctx, scale), water(ctx), elevation(ctx), political(ctx, scale) | null
   */
  painters = { physical: null, water: null, elevation: null, political: null };
  worldWidth = 8192;

  #view = null;
  #lastCamera = new THREE.Vector3();
  #lastMove = 0;

  constructor(globe) {
    this.globe = globe;
    const geometry = new THREE.BufferGeometry();
    this.physical = new THREE.Mesh(
      geometry,
      new THREE.MeshPhongMaterial({ specular: 0x506070, shininess: 28, bumpScale: 2 }),
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
    this.physical.visible = false;
    this.political.visible = false;
    globe.scene.add(this.physical, this.political);
  }

  /** Obliga a redibujar (p. ej. al cambiar de siglo). */
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
    const ready = this.painters.physical && altitude < START_ALTITUDE;
    if (!ready) {
      this.#setVisible(false);
      return;
    }

    const { lat, lon } = vector3ToLatLon(camera.position);
    const halfSpan = this.#halfSpan(altitude);
    if (!this.#covers(lat, lon, halfSpan) && now - this.#lastMove > SETTLE_MS) {
      this.#paint(this.#windowAround(lat, lon, halfSpan));
    }
    if (this.#view) {
      this.physical.material.displacementScale = this.globe.reliefScale;
      this.political.material.displacementScale = this.globe.reliefScale;
    }
    this.#setVisible(Boolean(this.#view));
  }

  #setVisible(active) {
    this.physical.visible = active && this.globe.isPhysicalStyle;
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
    return THREE.MathUtils.clamp(visible * 1.5, 0.4, 60);
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
    const lonSpan = view.east - view.west;
    const latSpan = view.north - view.south;
    const width = CANVAS_WIDTH;
    const height = THREE.MathUtils.clamp(Math.round((width * latSpan) / lonSpan), 64, width);

    const physical = makeCanvas(width, height);
    const pctx = physical.getContext('2d');
    drawWindow(pctx, view, this.worldWidth, (scale) => this.painters.physical(pctx, scale));

    const water = makeCanvas(width / 2, Math.max(height / 2, 32));
    const wctx = water.getContext('2d');
    drawWindow(wctx, view, this.worldWidth, () => this.painters.water(wctx));

    const elevation = makeCanvas(width / 2, Math.max(height / 2, 32));
    const ectx = elevation.getContext('2d');
    drawWindow(ectx, view, this.worldWidth, () => this.painters.elevation(ectx));

    let political = null;
    if (this.painters.political) {
      political = makeCanvas(width, height);
      const lctx = political.getContext('2d');
      drawWindow(lctx, view, this.worldWidth, (scale) => this.painters.political(lctx, scale));
    }

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

    const anisotropy = this.globe.renderer.capabilities.getMaxAnisotropy();
    const texture = (canvas, srgb) => {
      const t = new THREE.CanvasTexture(canvas);
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = anisotropy;
      return t;
    };
    const elevationTexture = texture(elevation, false);

    const pm = this.physical.material;
    for (const old of [pm.map, pm.specularMap, pm.displacementMap]) old?.dispose();
    Object.assign(pm, {
      map: texture(physical, true),
      specularMap: texture(water, false),
      displacementMap: elevationTexture,
      bumpMap: elevationTexture,
      displacementScale: this.globe.reliefScale,
    });
    pm.needsUpdate = true;

    const lm = this.political.material;
    lm.map?.dispose();
    Object.assign(lm, {
      map: political ? texture(political, true) : null,
      displacementMap: elevationTexture,
      displacementScale: this.globe.reliefScale,
    });
    lm.needsUpdate = true;

    this.#view = view;
  }
}
