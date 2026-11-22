import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import { OfficeEmployee } from "./office-employee.js";

const home = new THREE.Vector3(8, 10.2, 13);
const target = new THREE.Vector3(0, 1.52, 0);
type Desk = {
  group: THREE.Group;
  person: OfficeEmployee;
  id?: string;
};

function disposeModels(models: THREE.Object3D[]) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  for (const model of models) {
    model.traverse(node => {
      if (!(node instanceof THREE.Mesh)) return;
      geometries.add(node.geometry);
      for (const material of [node.material].flat()) materials.add(material);
    });
  }
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

export class OfficeScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly world = new THREE.Scene();
  private readonly furniture = new THREE.Group();
  private readonly camera = new THREE.OrthographicCamera(-9, 9, 6, -6, 0.1, 100);
  private readonly controls: OrbitControls;
  private readonly ray = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  private readonly resizeObserver: ResizeObserver;
  private readonly visibility: IntersectionObserver;
  private readonly models: THREE.Object3D[] = [];
  private readonly desks: Desk[] = [];
  private readonly light = new THREE.DirectionalLight(0xffffff, 1.75);
  private readonly selection = new THREE.Mesh(
    new THREE.RingGeometry(1.02, 1.07, 64),
    new THREE.MeshBasicMaterial({color: 0x7453bc, side: THREE.DoubleSide, transparent: true, opacity: 0.9}),
  );
  private readonly events = new AbortController();
  private room = 0;
  private timer = 0;
  private lastShadow = 0;
  private seats: (string | undefined)[] = [];
  private pressed?: {x: number; y: number; dragged: boolean};
  private onscreen = false;
  private disposed = false;
  private frame = 0;
  private lastFrame = 0;

  constructor(
    private viewport: HTMLElement,
    private openTask: (id: string) => void,
    private hoverTask: (id?: string, x?: number, y?: number) => void,
    onContextLost: () => void,
  ) {
    const renderer = new THREE.WebGLRenderer({alpha: true, antialias: true, powerPreference: "low-power"});
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.VSMShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0x000000, 0);
    const canvas = renderer.domElement;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Interactive office. Open a task by selecting its desk in the list.");
    this.viewport.append(canvas);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.minPolarAngle = Math.PI * 0.19;
    this.controls.maxPolarAngle = Math.PI * 0.43;
    this.controls.minAzimuthAngle = -0.12;
    this.controls.maxAzimuthAngle = Math.PI / 2 + 0.12;
    this.controls.minZoom = 0.8;
    this.controls.maxZoom = 2.75;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.8;
    this.controls.addEventListener("change", this.invalidate);
    this.reset();

    this.light.position.set(-3, 10, 7);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(1024, 1024);
    this.light.shadow.radius = 4;
    this.light.shadow.blurSamples = 8;
    Object.assign(this.light.shadow.camera, {left: -10, right: 10, top: 10, bottom: -10, near: 0.2, far: 30});
    this.light.shadow.bias = -0.00025;
    this.light.shadow.normalBias = 0.016;
    const fill = new THREE.DirectionalLight(0xfff5e8, 0.45);
    fill.position.set(6, 5, -3);
    this.selection.rotation.x = -Math.PI / 2;
    this.selection.visible = false;
    this.world.add(this.light, new THREE.HemisphereLight(0xffffff, 0xd1c8b8, 1.72), fill, this.furniture, this.selection);

    const { signal } = this.events;
    canvas.addEventListener("webglcontextlost", onContextLost, {signal});
    canvas.addEventListener("pointerdown", event => {
      this.pressed = {x: event.clientX, y: event.clientY, dragged: !event.isPrimary || event.button !== 0};
      this.clearHover();
    }, {signal});
    canvas.addEventListener("pointermove", event => {
      if (this.pressed) {
        if (Math.hypot(event.clientX - this.pressed.x, event.clientY - this.pressed.y) > 5) this.pressed.dragged = true;
        return;
      }
      if (event.pointerType !== "mouse") return;
      const id = this.hit(event);
      this.select(id);
      const rect = canvas.getBoundingClientRect();
      this.hoverTask(id, event.clientX - rect.left, event.clientY - rect.top);
    }, {signal});
    canvas.addEventListener("pointerup", event => {
      const isClick = this.pressed && !this.pressed.dragged && event.isPrimary && event.button === 0;
      this.pressed = undefined;
      if (isClick) {
        const id = this.hit(event);
        if (id) this.openTask(id);
      }
    }, {signal});
    canvas.addEventListener("pointercancel", () => { this.pressed = undefined; }, {signal});
    canvas.addEventListener("pointerleave", () => this.clearHover(), {signal});
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.viewport);
    this.visibility = new IntersectionObserver(entries => {
      this.onscreen = entries[0].isIntersecting;
      this.invalidate();
    });
    this.visibility.observe(this.viewport);
    document.addEventListener("visibilitychange", this.invalidate, {signal});
    this.reducedMotion.addEventListener("change", this.invalidate, {signal});
    this.resize();
  }

  async load(signal: AbortSignal) {
    const loader = new GLTFLoader();
    const names = ["room", "station", "employee-0", "employee-1", "employee-2"];
    const [room, station, ...employees] = await Promise.all(names.map(async name => {
      const response = await fetch("/office/" + name + ".glb", {signal});
      if (!response.ok) throw new Error("Office asset unavailable.");
      const {scene} = await loader.parseAsync(await response.arrayBuffer(), "/office/");
      if (signal.aborted) {
        disposeModels([scene]);
        throw new DOMException("Aborted", "AbortError");
      }
      this.models.push(scene);
      scene.traverse(node => {
        if (node instanceof THREE.Mesh) {
          node.castShadow = true;
          node.receiveShadow = true;
        }
      });
      return scene;
    }));
    if (signal.aborted) return;
    this.furniture.add(room);
    const baseY = new THREE.Box3().setFromObject(room).min.y;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(75, 75),
      new THREE.ShadowMaterial({color: 0x493e32, opacity: 0.15}),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = baseY - 0.03;
    ground.receiveShadow = true;
    this.world.add(ground);
    // The room GLB carries the desk transforms from the editable Blender layout.
    const anchors = room.children.filter(node => /^DeskAnchor_\d{2}$/.test(node.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (anchors.length !== employees.length) throw new Error("Incomplete office layout.");
    for (const [slot, anchor] of anchors.entries()) {
      const cafe = room.getObjectByName(anchor.name.replace("DeskAnchor", "CafeAnchor"));
      if (!cafe) throw new Error("Missing cafe seat.");
      const group = new THREE.Group();
      group.position.copy(anchor.position);
      group.quaternion.copy(anchor.quaternion);
      group.add(station.clone(true));
      const person = new OfficeEmployee(employees[slot], cafe.position, group.position, group.getObjectByName("Chair")!, slot);
      this.furniture.add(group, person.root, person.cup);
      this.desks.push({group, person});
    }
    this.setSeats(this.seats, this.room);
    this.renderer.shadowMap.needsUpdate = true;
    this.invalidate();
  }

  setSeats(ids: (string | undefined)[], room: number) {
    const changedRoom = this.room !== room;
    this.seats = ids;
    this.room = room;
    for (const [i, desk] of this.desks.entries()) {
      const id = ids[i];
      if (!changedRoom && id === desk.id) continue;
      desk.id = id;
      desk.group.userData.taskId = id;
      desk.person.root.userData.taskId = id;
      if (changedRoom || this.reducedMotion.matches) {
        desk.person.pose(0, i * 2.1, !!id, this.reducedMotion.matches, true);
        this.renderer.shadowMap.needsUpdate = true;
      }
    }
    this.select();
  }

  private hit(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - rect.left) * 2 / rect.width - 1, 1 - (event.clientY - rect.top) * 2 / rect.height);
    this.ray.setFromCamera(this.pointer, this.camera);
    const hit = this.ray.intersectObjects(this.furniture.children.filter(node => node.visible), true)[0];
    for (let node = hit?.object; node; node = node.parent!) {
      if (node.userData.taskId) return node.userData.taskId as string;
    }
    return undefined;
  }

  select(id?: string) {
    const desk = id ? this.desks.find(d => d.id === id) : undefined;
    if (desk) {
      this.selection.position.copy(desk.group.position);
      this.selection.position.y = 0.026;
    }
    this.selection.visible = !!desk;
    this.viewport.classList.toggle("has-task", !!desk);
    this.invalidate();
  }

  private clearHover() {
    this.select();
    this.hoverTask();
  }

  reset() {
    this.camera.position.copy(home);
    this.controls.target.copy(target);
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  zoomBy(factor: number) {
    this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * factor, this.controls.minZoom, this.controls.maxZoom);
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  private resize() {
    const {clientWidth: width, clientHeight: height} = this.viewport;
    if (!width || !height) return;
    const aspect = width / height;
    const halfHeight = Math.max(5.36, 8.12 / aspect);
    this.camera.left = -halfHeight * aspect;
    this.camera.right = halfHeight * aspect;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.invalidate();
  }

  private invalidate = () => {
    window.clearTimeout(this.timer);
    if (!this.frame && !this.disposed && this.onscreen && !document.hidden) this.frame = requestAnimationFrame(this.render);
  };

  private render = (now: number) => {
    this.frame = 0;
    if (this.disposed || !this.onscreen || document.hidden) return;
    const reduced = this.reducedMotion.matches;
    const delta = Math.min((now - this.lastFrame) / 1000, 0.25);
    let moving = false;
    for (const [i, desk] of this.desks.entries()) {
      if (desk.person.pose(delta, now / 1000 + i * 2.1, !!desk.id, reduced)) moving = true;
    }
    if (moving && (reduced || now - this.lastShadow > 150)) {
      this.renderer.shadowMap.needsUpdate = true;
      this.lastShadow = now;
    }
    this.renderer.render(this.world, this.camera);
    this.lastFrame = now;
    if (this.desks.length && !reduced) {
      // Hold each animation frame between draws, especially during a quiet cafe shift.
      const remaining = (moving ? 42 : 84) - (performance.now() - now);
      this.timer = window.setTimeout(this.invalidate, Math.max(0, remaining));
    }
  };

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.timer);
    this.events.abort();
    this.visibility.disconnect();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.light.shadow.dispose();
    disposeModels([this.world, ...this.models]);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
