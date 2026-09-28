// Etiquetas HTML colocadas sobre el globo, organizadas en grupos (estados,
// océanos, relieve, ríos, picos…). Solo se muestran las que caben según el
// zoom, y nunca se solapan: las de más prioridad y tamaño van primero.

import * as THREE from 'three';
import { EARTH_RADIUS, latLonToVector3 } from './globe.js';

const MAX_PER_GROUP = 400;
const MIN_FACING = 0.3; // oculta las que están cerca del borde del disco
const MIN_SIZE_PX = 46; // tamaño aparente mínimo del accidente para rotularlo
const LIFT = EARTH_RADIUS * 0.01;
const DOT_OFFSET = 4; // distancia del borde izquierdo al centro del punto de las ciudades

export class Labels {
  #groups = new Map();
  #ordered = [];
  #radiusAt = () => EARTH_RADIUS;
  #projected = new THREE.Vector3();
  #cameraDir = new THREE.Vector3();

  constructor(container) {
    this.root = document.createElement('div');
    this.root.className = 'labels';
    this.root.setAttribute('aria-hidden', 'true');
    container.append(this.root);
  }

  /** radiusAt(lat, lon) da la altura de la superficie, para no quedar bajo el relieve. */
  set radiusAt(fn) {
    this.#radiusAt = fn;
    this.relocate();
  }

  /**
   * Sustituye las etiquetas de un grupo. Cada entrada es
   * { text, sub?, lat, lon, size (radianes), className, anchor? }.
   * anchor 'dot': el punto del lugar a la izquierda y el texto a su derecha
   * (ciudades); por defecto el texto se centra en el lugar.
   */
  setGroup(key, entries, { priority = 0 } = {}) {
    const previous = this.#groups.get(key);
    previous?.items.forEach((item) => item.el.remove());
    const group = { priority, visible: previous?.visible ?? true, items: [] };
    group.items = [...entries]
      .sort((a, b) => b.size - a.size)
      .slice(0, MAX_PER_GROUP)
      .map((entry) => {
        const el = document.createElement('span');
        el.className = `label ${entry.className ?? ''}`;
        el.textContent = entry.text;
        if (entry.sub) {
          const sub = document.createElement('small');
          sub.textContent = entry.sub;
          el.append(sub);
        }
        el.style.visibility = 'hidden';
        this.root.append(el);
        const position = latLonToVector3(entry.lat, entry.lon, this.#radiusAt(entry.lat, entry.lon) + LIFT);
        return {
          el,
          group,
          lat: entry.lat,
          lon: entry.lon,
          position,
          normal: position.clone().normalize(),
          size: entry.size,
          dot: entry.anchor === 'dot',
          width: 0,
          height: 0,
          shown: false,
        };
      });
    this.#groups.set(key, group);
    this.#ordered = [...this.#groups.values()]
      .flatMap((g) => g.items)
      .sort((a, b) => b.group.priority - a.group.priority || b.size - a.size);
  }

  setGroupVisible(key, visible) {
    const group = this.#groups.get(key);
    if (group) group.visible = visible;
    else this.#groups.set(key, { priority: 0, visible, items: [] });
  }

  /** Recoloca las etiquetas cuando cambia la altura del relieve. */
  relocate() {
    for (const item of this.#ordered) {
      item.position.setLength(this.#radiusAt(item.lat, item.lon) + LIFT);
    }
  }

  update(camera, width, height) {
    const altitude = Math.max(camera.position.length() - EARTH_RADIUS, 0.002);
    const pxPerRadian = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * altitude);
    this.#cameraDir.copy(camera.position).normalize();

    const placed = [];
    for (const item of this.#ordered) {
      const facing = item.normal.dot(this.#cameraDir);
      let show = item.group.visible && facing > MIN_FACING && item.size * pxPerRadian > MIN_SIZE_PX;
      let x = 0;
      let y = 0;
      if (show) {
        this.#projected.copy(item.position).project(camera);
        x = ((this.#projected.x + 1) / 2) * width;
        y = ((1 - this.#projected.y) / 2) * height;
        show = this.#projected.z < 1 && x > -100 && x < width + 100 && y > -40 && y < height + 40;
      }
      if (show) {
        if (!item.width) {
          item.width = item.el.offsetWidth;
          item.height = item.el.offsetHeight;
        }
        const left = item.dot ? x - DOT_OFFSET : x - item.width / 2;
        const box = [left - 4, y - item.height / 2 - 2, left + item.width + 4, y + item.height / 2 + 2];
        show = !placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
        if (show) placed.push(box);
      }
      if (show) {
        item.el.style.transform = item.dot
          ? `translate(${(x - DOT_OFFSET).toFixed(1)}px, ${y.toFixed(1)}px) translateY(-50%)`
          : `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
        item.el.style.opacity = Math.min((facing - MIN_FACING) / 0.2, 1).toFixed(2);
      }
      if (show !== item.shown) {
        item.el.style.visibility = show ? 'visible' : 'hidden';
        item.shown = show;
      }
    }
  }
}
