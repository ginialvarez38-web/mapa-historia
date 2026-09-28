// Etiquetas HTML con los nombres de las entidades, colocadas sobre el globo.
// Solo se muestran las que caben según el zoom y no se solapan entre sí.

import * as THREE from 'three';
import { EARTH_RADIUS, latLonToVector3 } from './globe.js';

const MAX_LABELS = 150;
const MIN_FACING = 0.3; // oculta las que están cerca del borde del disco
const MIN_SIZE_PX = 46; // tamaño aparente mínimo de la entidad para rotularla

export class Labels {
  #items = [];
  #projected = new THREE.Vector3();
  #cameraDir = new THREE.Vector3();

  constructor(container) {
    this.root = document.createElement('div');
    this.root.className = 'labels';
    this.root.setAttribute('aria-hidden', 'true');
    container.append(this.root);
  }

  set visible(visible) {
    this.root.hidden = !visible;
  }

  setPolities(polities) {
    this.root.replaceChildren();
    this.#items = [...polities]
      .sort((a, b) => b.area - a.area)
      .slice(0, MAX_LABELS)
      .map((polity) => {
        const el = document.createElement('span');
        el.className = 'label';
        el.textContent = polity.name;
        this.root.append(el);
        const position = latLonToVector3(polity.anchor.lat, polity.anchor.lon, EARTH_RADIUS * 1.01);
        return {
          el,
          position,
          normal: position.clone().normalize(),
          // Tamaño angular aproximado de la entidad, en radianes.
          angularSize: Math.sqrt(polity.area) * (Math.PI / 180),
          width: 0,
          height: 0,
          shown: true,
        };
      });
  }

  update(camera, width, height) {
    if (this.root.hidden || !this.#items.length) return;
    const distance = camera.position.length();
    const altitude = Math.max(distance - EARTH_RADIUS, 0.05);
    const pxPerRadian = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * altitude);
    this.#cameraDir.copy(camera.position).normalize();

    const placed = [];
    for (const item of this.#items) {
      const facing = item.normal.dot(this.#cameraDir);
      let show = facing > MIN_FACING && item.angularSize * pxPerRadian > MIN_SIZE_PX;
      let x = 0;
      let y = 0;
      if (show) {
        if (!item.width) {
          item.width = item.el.offsetWidth;
          item.height = item.el.offsetHeight;
        }
        this.#projected.copy(item.position).project(camera);
        x = ((this.#projected.x + 1) / 2) * width;
        y = ((1 - this.#projected.y) / 2) * height;
        const box = [x - item.width / 2 - 4, y - item.height / 2 - 2, x + item.width / 2 + 4, y + item.height / 2 + 2];
        show = !placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
        if (show) placed.push(box);
      }
      if (show) {
        item.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
        item.el.style.opacity = Math.min((facing - MIN_FACING) / 0.2, 1).toFixed(2);
      }
      if (show !== item.shown) {
        item.el.style.visibility = show ? 'visible' : 'hidden';
        item.shown = show;
      }
    }
  }
}
