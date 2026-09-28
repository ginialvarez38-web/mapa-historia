import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const EARTH_RADIUS = 1;
const MIN_DISTANCE = 1.15;
const MAX_DISTANCE = 8;

/** Coordenadas geográficas (grados) -> punto en la esfera. */
export function latLonToVector3(lat, lon, radius = EARTH_RADIUS) {
  const phi = THREE.MathUtils.degToRad(lon + 180);
  const theta = THREE.MathUtils.degToRad(lat);
  return new THREE.Vector3(
    -radius * Math.cos(phi) * Math.cos(theta),
    radius * Math.sin(theta),
    radius * Math.sin(phi) * Math.cos(theta),
  );
}

/** Punto en la esfera -> coordenadas geográficas (grados). */
export function vector3ToLatLon(v) {
  const n = v.clone().normalize();
  const lat = THREE.MathUtils.radToDeg(Math.asin(n.y));
  let lon = THREE.MathUtils.radToDeg(Math.atan2(n.z, -n.x)) - 180;
  if (lon < -180) lon += 360;
  return { lat, lon };
}

const ATMOSPHERE_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

// Halo exterior: se dibuja la cara trasera de una esfera algo mayor.
const HALO_FRAGMENT = /* glsl */ `
  uniform vec3 glowColor;
  uniform float limb;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    float facing = dot(normalize(vNormal), normalize(vViewPosition));
    float intensity = pow(clamp(-facing / limb, 0.0, 1.0), 3.0);
    gl_FragColor = vec4(glowColor, intensity * 0.85);
  }
`;

// Bruma sobre el borde del disco terrestre (efecto Fresnel).
const HAZE_FRAGMENT = /* glsl */ `
  uniform vec3 glowColor;
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  void main() {
    float facing = dot(normalize(vNormal), normalize(vViewPosition));
    float intensity = pow(1.0 - clamp(facing, 0.0, 1.0), 3.5);
    gl_FragColor = vec4(glowColor, intensity * 0.75);
  }
`;

export class Globe {
  /** Se invoca con ({lat, lon} | null, {x, y}) al mover el ratón. */
  onHover = null;
  /** Se invoca con ({lat, lon} | null, {x, y}) al hacer clic o tocar sin arrastrar. */
  onSelect = null;
  /** Se invoca en cada fotograma, tras actualizar la cámara. */
  onFrame = null;

  #flight = null;
  #politicalEnabled = true;
  #raycaster = new THREE.Raycaster();
  #pointer = new THREE.Vector2();

  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x04060c);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 300);
    this.scene.add(this.camera);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, {
      enableDamping: true,
      dampingFactor: 0.08,
      enablePan: false,
      minDistance: MIN_DISTANCE,
      maxDistance: MAX_DISTANCE,
      autoRotateSpeed: 0.4,
    });
    this.controls.addEventListener('start', () => {
      this.#flight = null;
    });

    this.#createLights();
    this.#createEarth();
    this.#createPoliticalOverlay();
    this.#createAtmosphere();
    this.#createGraticule();
    this.#createStars();
    this.#bindPointer();

    this.#resize();
    new ResizeObserver(() => this.#resize()).observe(container);
    this.renderer.setAnimationLoop(() => this.#tick());
  }

  get maxTextureSize() {
    return this.renderer.capabilities.maxTextureSize;
  }

  /** Distancia de cámara a la que el globo entero cabe en pantalla. */
  fitDistance() {
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const fov = Math.min(vfov, hfov);
    const distance = (EARTH_RADIUS * 1.18) / Math.sin(fov / 2);
    return THREE.MathUtils.clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
  }

  setView(lat, lon, distance = this.fitDistance()) {
    this.#flight = null;
    this.camera.position.copy(latLonToVector3(lat, lon, distance));
    this.controls.update();
  }

  /** Vuela suavemente hasta situar (lat, lon) en el centro de la vista. */
  flyTo(lat, lon, distance = this.camera.position.length(), duration = 1400) {
    this.#flight = {
      from: this.camera.position.clone(),
      to: latLonToVector3(lat, lon, distance),
      start: performance.now(),
      duration,
    };
  }

  setPhysicalMap(canvas) {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const material = this.materials.physical;
    material.map = texture;
    material.color.set(0xffffff);
    material.needsUpdate = true;
  }

  setSatelliteMaps({ color, bump, specular }) {
    const toTexture = (image, srgb = false) => {
      if (!image) return null;
      const texture = new THREE.Texture(image);
      if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      texture.needsUpdate = true;
      return texture;
    };
    this.materials.satellite = new THREE.MeshPhongMaterial({
      map: toTexture(color, true),
      bumpMap: toTexture(bump),
      bumpScale: 6,
      specularMap: toTexture(specular),
      specular: new THREE.Color(0x3a4a5a),
      shininess: 18,
    });
  }

  /** Sustituye la textura de fronteras (lienzo equirectangular transparente). */
  setPoliticalMap(canvas) {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const material = this.political.material;
    material.map?.dispose();
    material.map = texture;
    material.needsUpdate = true;
    this.political.visible = this.#politicalEnabled;
  }

  set politicalVisible(visible) {
    this.#politicalEnabled = visible;
    this.political.visible = visible && Boolean(this.political.material.map);
    this.highlightGroup.visible = visible;
  }

  /** Resalta el contorno de unos polígonos GeoJSON, o lo quita con null. */
  highlight(polygons) {
    for (const child of this.highlightGroup.children) child.geometry.dispose();
    this.highlightGroup.clear();
    if (!polygons) return;
    const radius = EARTH_RADIUS * 1.002;
    const points = [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        for (let i = 1; i < ring.length; i++) {
          const [lon0, lat0] = ring[i - 1];
          const [lon1, lat1] = ring[i];
          points.push(latLonToVector3(lat0, lon0, radius), latLonToVector3(lat1, lon1, radius));
        }
      }
    }
    this.highlightGroup.add(
      new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), this.highlightMaterial),
    );
  }

  setStyle(name) {
    const material = this.materials[name];
    if (material) this.earth.material = material;
  }

  set graticuleVisible(visible) {
    this.graticule.visible = visible;
  }

  set autoRotate(enabled) {
    this.controls.autoRotate = enabled;
  }

  /** Coordenadas geográficas bajo un punto de la pantalla, o null. */
  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.#pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.#raycaster.setFromCamera(this.#pointer, this.camera);
    const hit = this.#raycaster.intersectObject(this.earth, false)[0];
    return hit ? vector3ToLatLon(hit.point) : null;
  }

  #createLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.1));
    // Luz ligada a la cámara: el hemisferio visible siempre está iluminado.
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(-1.2, 1.4, 0.4);
    this.camera.add(sun);
  }

  #createEarth() {
    this.materials = {
      physical: new THREE.MeshPhongMaterial({
        color: 0x2a4f6e,
        specular: 0x111111,
        shininess: 6,
      }),
    };
    const geometry = new THREE.SphereGeometry(EARTH_RADIUS, 192, 96);
    this.earth = new THREE.Mesh(geometry, this.materials.physical);
    this.scene.add(this.earth);
  }

  #createPoliticalOverlay() {
    // Esfera apenas mayor que la Tierra con la textura de fronteras; así la
    // capa política sirve igual sobre el mapa físico y sobre el satélite.
    this.political = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS * 1.0008, 192, 96),
      new THREE.MeshPhongMaterial({
        transparent: true,
        depthWrite: false,
        specular: 0x111111,
        shininess: 6,
      }),
    );
    this.political.visible = false;
    this.highlightGroup = new THREE.Group();
    this.highlightMaterial = new THREE.LineBasicMaterial({ color: 0xffe3a3, depthWrite: false });
    this.scene.add(this.political, this.highlightGroup);
  }

  #createAtmosphere() {
    const glowColor = new THREE.Color(0x6fb4ff);
    const haloRadius = EARTH_RADIUS * 1.14;
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(haloRadius, 96, 48),
      new THREE.ShaderMaterial({
        vertexShader: ATMOSPHERE_VERTEX,
        fragmentShader: HALO_FRAGMENT,
        uniforms: {
          glowColor: { value: glowColor },
          limb: { value: Math.sqrt(1 - (EARTH_RADIUS / haloRadius) ** 2) },
        },
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    const haze = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS * 1.004, 96, 48),
      new THREE.ShaderMaterial({
        vertexShader: ATMOSPHERE_VERTEX,
        fragmentShader: HAZE_FRAGMENT,
        uniforms: { glowColor: { value: glowColor } },
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.scene.add(halo, haze);
  }

  #createGraticule() {
    const radius = EARTH_RADIUS * 1.0015;
    const step = 15;
    const seg = 2;
    const points = [];
    for (let lon = -180; lon < 180; lon += step) {
      for (let lat = -90; lat < 90; lat += seg) {
        points.push(latLonToVector3(lat, lon, radius), latLonToVector3(lat + seg, lon, radius));
      }
    }
    for (let lat = -75; lat <= 75; lat += step) {
      for (let lon = -180; lon < 180; lon += seg) {
        points.push(latLonToVector3(lat, lon, radius), latLonToVector3(lat, lon + seg, radius));
      }
    }
    this.graticule = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      }),
    );
    this.scene.add(this.graticule);
  }

  #createStars() {
    const count = 4000;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.randomDirection().multiplyScalar(120 + Math.random() * 60);
      v.toArray(positions, i * 3);
      const b = 0.25 + 0.75 * Math.random() ** 3;
      colors.set([b, b, b * (0.9 + Math.random() * 0.2)], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.scene.add(
      new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          size: 1.6,
          sizeAttenuation: false,
          vertexColors: true,
          depthWrite: false,
        }),
      ),
    );
  }

  #bindPointer() {
    const canvas = this.renderer.domElement;
    const screen = (e) => ({ x: e.clientX, y: e.clientY });
    let down = null;
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.onHover?.(this.pick(e.clientX, e.clientY), screen(e));
    });
    canvas.addEventListener('pointerleave', (e) => this.onHover?.(null, screen(e)));
    canvas.addEventListener('pointerdown', (e) => {
      down = screen(e);
    });
    canvas.addEventListener('pointerup', (e) => {
      // Solo cuenta como selección si el puntero apenas se movió (no es un giro).
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) {
        this.onSelect?.(this.pick(e.clientX, e.clientY), screen(e));
      }
      down = null;
    });
    canvas.addEventListener('dblclick', (e) => {
      const target = this.pick(e.clientX, e.clientY);
      if (!target) return;
      const distance = Math.max(this.camera.position.length() * 0.65, MIN_DISTANCE + 0.25);
      this.flyTo(target.lat, target.lon, Math.min(distance, this.camera.position.length()));
    });
  }

  #resize() {
    const { clientWidth: width, clientHeight: height } = this.container;
    if (!width || !height) return;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  #updateFlight() {
    const { from, to, start, duration } = this.#flight;
    const t = Math.min((performance.now() - start) / duration, 1);
    const k = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    const fromDir = from.clone().normalize();
    const rotation = new THREE.Quaternion().setFromUnitVectors(fromDir, to.clone().normalize());
    const partial = new THREE.Quaternion().slerp(rotation, k);
    const distance = THREE.MathUtils.lerp(from.length(), to.length(), k);
    this.camera.position.copy(fromDir.applyQuaternion(partial).multiplyScalar(distance));
    if (t === 1) this.#flight = null;
  }

  #tick() {
    if (this.#flight) this.#updateFlight();

    // Girar más despacio cuanto más cerca de la superficie.
    const altitude = this.camera.position.length() - EARTH_RADIUS;
    this.controls.rotateSpeed = THREE.MathUtils.clamp(altitude * 0.3, 0.04, 0.8);
    this.controls.zoomSpeed = THREE.MathUtils.clamp(altitude * 0.5, 0.3, 1);

    this.controls.update();
    this.onFrame?.();
    this.renderer.render(this.scene, this.camera);
  }
}
