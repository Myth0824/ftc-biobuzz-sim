import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { FIELD, HIVE } from '../sim/config';
import type { RobotConfig } from '../sim/config';
import { flowerHeights, type BallKind, type Sim } from '../sim/world';

const COLOR: Record<BallKind, number> = { pollen: 0xf2c81e, nectar_red: 0xd8261c, nectar_blue: 0x1f4fd8 };
export const CAMERAS = ['chase', 'driver', 'overhead', 'audience'] as const;
export type CameraMode = (typeof CAMERAS)[number];
/** The distance from a drive handle to its heading knob, in meters. */
export const KNOB = 0.3;
/** A position on the simulator's floor axes and a heading in radians. */
export interface Pose2 { x: number; z: number; heading: number }
/** Gets the pose a fraction `f` of the way along a path by length. Headings turn the short way between points. */
function along(p: Pose2[], f: number): Pose2 | null {
  if (!p.length) return null; if (p.length === 1) return p[0];
  const seg = p.slice(1).map((q, i) => Math.hypot(q.x - p[i].x, q.z - p[i].z)), total = seg.reduce((a, b) => a + b, 0) || 1;
  let d = f * total, i = 0; while (i < seg.length - 1 && d > seg[i]) { d -= seg[i]; i++; }
  const u = seg[i] ? Math.min(1, d / seg[i]) : 1, a = p[i], b = p[i + 1], dh = Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading));
  return { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, heading: a.heading + dh * u };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Draws the simulation with three.js. The official field CAD supplies every FIELD element mesh. */
export class View {
  renderer: THREE.WebGLRenderer; scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(58, 1, 0.05, 40);
  /** The camera's parent. It stays at the origin on screen; in a headset it is where the viewer stands. */
  private rig = new THREE.Group();
  private boardMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(Object.assign(document.createElement('canvas'), { width: 1024, height: 256 })) }));
  mode: CameraMode = 'chase';
  /** The number plate text of each robot, in `sim.robots` order. A missing entry shows the alliance letter and the slot. */
  plates: string[] = [];
  /** Pixels at the left edge that a panel covers. The overhead camera centers the FIELD in the rest of the window. */
  insetLeft = 0;
  /** The width in pixels of the panel over the right side of the canvas, such as the field editor's settings. The overhead view centers the FIELD between the two insets. */
  insetRight = 0;
  private ballGeo: Record<'pollen' | 'nectar', THREE.BufferGeometry> = { pollen: new THREE.SphereGeometry(FIELD.pollenRadius, 20, 14), nectar: new THREE.SphereGeometry(FIELD.nectarRadius, 20, 14) };
  private ballMat = new Map<BallKind, THREE.Material>();
  /** The balls on the FIELD and in the FLOWERS, one instanced mesh per kind, so that each kind is one draw call. */
  private balls = new Map<BallKind, THREE.InstancedMesh>();
  private ballXf = { m: new THREE.Matrix4(), p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3(1, 1, 1) };
  private robotGroups: THREE.Group[] = [];
  private hiveNodes: { red?: THREE.Object3D; blue?: THREE.Object3D } = {};
  private pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x3ab7ff }));
  private autoLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffa726, dashSize: 0.08, gapSize: 0.05 }));
  private autoPoses = new THREE.Group(); private autoKey = '';
  private arc: THREE.Line; private arcMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  /**
   * The third-person camera. `yaw` trails the shooter's aim, as a heading in radians. A drag adds `yawOff` and
   * `pitchOff`, which ease back to zero after the release, and the wheel sets `dist`, in meters.
   */
  private chase = { yaw: Number.NaN, yawOff: 0, pitchOff: 0, dist: 1.7, lift: 0, dragging: false, last: 0 };
  /** Whether the shot preview's arc enters the CELL, or null when no preview is drawn. The driver HUD shows it. */
  onTarget: boolean | null = null;
  /** True when the last press on the canvas moved the third-person camera, so its release isn't a click on the FIELD. */
  dragged = false;

  /** In review, the camera orbits a target: `theta` around the vertical, `phi` down from straight up, at `radius`. */
  freeLook = false;
  private fl = { theta: Math.PI * 0.35, phi: Math.PI * 0.28, radius: 5.5, target: new THREE.Vector3(0, 0.3, 0) };
  private _pointer = { x: 0, y: 0, btn: -1 };

  constructor(canvas: HTMLCanvasElement, private onProgress: (msg: string | null) => void) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.xr.enabled = true;
    this.rig.add(this.camera); this.boardMesh.visible = false; this.scene.add(this.rig, this.boardMesh);
    this.renderer.xr.addEventListener('sessionend', () => { this.rig.position.set(0, 0, 0); this.rig.rotation.set(0, 0, 0); this.boardMesh.visible = false; this.boardMesh.userData.key = ''; });
    this.scene.background = new THREE.Color(0x14171c);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.25));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-2, 6, 3); this.scene.add(sun);
    // The balls have holes, so the inside of the far wall shows through: both faces are drawn.
    for (const k of Object.keys(COLOR) as BallKind[]) this.ballMat.set(k, new THREE.MeshStandardMaterial({ color: COLOR[k], roughness: 0.45, side: THREE.DoubleSide }));
    this.buildFloor(); this.buildAxisLabels();
    for (const k of Object.keys(COLOR) as BallKind[]) this.growBalls(k, 64);
    this.arc = new THREE.Line(new THREE.BufferGeometry(), this.arcMat); this.arc.frustumCulled = false; this.pathLine.frustumCulled = false; this.autoLine.frustumCulled = false; this.scene.add(this.arc, this.pathLine, this.autoLine, this.autoPoses);
    this.loadField(); this.loadBalls();
    addEventListener('resize', () => this.resize()); this.resize();
    this.attachFreeLook(canvas);
  }

  /** Replaces kind `k`'s instanced mesh with one that holds `capacity` balls. */
  private growBalls(k: BallKind, capacity: number) {
    const old = this.balls.get(k); if (old) { this.scene.remove(old); old.dispose(); }
    const im = new THREE.InstancedMesh(k === 'pollen' ? this.ballGeo.pollen : this.ballGeo.nectar, this.ballMat.get(k)!, capacity);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.frustumCulled = false; im.count = 0;
    this.balls.set(k, im); this.scene.add(im); return im;
  }

  private resize() { const w = innerWidth, h = innerHeight; this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }

  private buildFloor() {
    const venue = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 1 }));
    venue.rotation.x = -Math.PI / 2; venue.position.y = -0.016; this.scene.add(venue);
    const s = FIELD.half * 2, tiles = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshStandardMaterial({ color: 0x4a4e55, roughness: 0.95 }));
    tiles.rotation.x = -Math.PI / 2; tiles.position.y = -0.0005; this.scene.add(tiles);
    const pts: number[] = [];
    for (let i = 1; i < 6; i++) { const p = -FIELD.half + (i * s) / 6; pts.push(p, 0.0002, -FIELD.half, p, 0.0002, FIELD.half, -FIELD.half, 0.0002, p, FIELD.half, 0.0002, p); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x34383f })));
  }

  private loadField() {
    this.onProgress('Loading the field CAD…');
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).load('/field.glb', gltf => {
      gltf.scene.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals();
          // The CAD perimeter panels are opaque. Real panels are clear polycarbonate.
          const mat = m.material as THREE.MeshStandardMaterial;
          if (o.parent?.name === 'perimeter' || o.name === 'perimeter') { const c = mat.color; if (c.r > 0.4 && c.g > 0.4) { mat.transparent = true; mat.opacity = 0.22; mat.depthWrite = false; } }
        }
      });
      // Each HIVE turns about its pivot. Compression moves the nodes' origins, so each HIVE hangs from a group at its pivot.
      gltf.scene.updateMatrixWorld(true);
      for (const side of ['red', 'blue'] as const) {
        const hive = gltf.scene.getObjectByName(`hive_${side}`); if (!hive) continue;
        const pivot = new THREE.Group(); pivot.position.set(HIVE.pivotX[side], HIVE.pivotY, 0); hive.parent!.add(pivot); pivot.updateMatrixWorld(); pivot.attach(hive); this.hiveNodes[side] = pivot;
      }
      this.scene.add(gltf.scene); this.onProgress(null);
    }, e => { if (e.total) this.onProgress(`Loading the field CAD… ${Math.round((100 * e.loaded) / e.total)}%`); },
    () => this.onProgress('The field CAD did not load. Run: node scripts/convert-step.mjs'));
  }

  /**
   * Loads the real POLLEN and NECTAR models from the field CAD (public/balls.gltf, written by scripts/convert-balls.mjs)
   * and swaps them in for the smooth spheres. If the file is missing, the spheres stay.
   */
  private loadBalls() {
    new GLTFLoader().load('/balls.gltf', gltf => {
      for (const kind of ['pollen', 'nectar'] as const) {
        const mesh = gltf.scene.getObjectByName(kind) as THREE.Mesh | undefined; if (!mesh?.isMesh) continue;
        if (!mesh.geometry.getAttribute('normal')) mesh.geometry.computeVertexNormals();
        const old = this.ballGeo[kind]; this.ballGeo[kind] = mesh.geometry;
        this.scene.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry === old) m.geometry = mesh.geometry; });
      }
    }, undefined, () => { /* The spheres stay. */ });
  }

  private buildRobot(): THREE.Group {
    const group = new THREE.Group();
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.6 })); chassis.name = 'chassis'; group.add(chassis);
    // The intake bar is green while the hopper has room and orange when it is full. A dual-sided intake shows a second bar at the rear.
    const intakeMat = new THREE.MeshStandardMaterial({ color: 0x3ad17a, emissive: 0x0c4022 });
    for (const name of ['intake', 'intakeRear']) { const bar = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), intakeMat); bar.name = name; group.add(bar); }
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 3), new THREE.MeshStandardMaterial({ color: 0xffffff })); arrow.name = 'arrow'; arrow.rotation.z = -Math.PI / 2; group.add(arrow);
    const wheelGeo = new THREE.CylinderGeometry(0.052, 0.052, 0.038, 18), wheelMat = new THREE.MeshStandardMaterial({ color: 0x15171a });
    for (let i = 0; i < 4; i++) { const w = new THREE.Mesh(wheelGeo, wheelMat); w.name = `wheel${i}`; w.rotation.x = Math.PI / 2; group.add(w); }
    const carried = new THREE.Group(); carried.name = 'carried'; group.add(carried);
    // Two number plates on opposite sides of the robot, as the FTC robot rules require. `syncRobot` places them and draws the text.
    const plateMat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(document.createElement('canvas')) });
    for (let i = 0; i < 2; i++) { const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.075), plateMat); pl.name = `plate${i}`; group.add(pl); }
    this.scene.add(group); return group;
  }

  /** Draws the plate text in white on the alliance color. The texture is redrawn only when the text or the alliance changes. */
  private drawPlate(group: THREE.Group, text: string, alliance: string) {
    const key = `${text}|${alliance}`; if (group.userData.plate === key) return; group.userData.plate = key;
    const mat = (group.getObjectByName('plate0') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material, cv = mat.map!.image as HTMLCanvasElement; cv.width = 256; cv.height = 96;
    const g = cv.getContext('2d')!; g.fillStyle = alliance === 'red' ? '#d8261c' : '#1f4fd8'; g.fillRect(0, 0, 256, 96); g.strokeStyle = '#fff'; g.lineWidth = 6; g.strokeRect(3, 3, 250, 90);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; let px = 72; do { g.font = `800 ${px}px ui-sans-serif, system-ui, sans-serif`; px -= 4; } while (g.measureText(text).width > 230 && px > 20);
    g.fillText(text, 128, 52); mat.map!.needsUpdate = true;
  }

  private syncRobot(group: THREE.Group, sim: Sim, plate: string) {
    const c = sim.cfg, p = sim.robot.translation(), th = sim.heading;
    group.position.set(p.x, 0, p.z); group.rotation.y = th;
    const ch = group.getObjectByName('chassis') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    ch.material.color.set(sim.alliance === 'red' ? 0x9c231d : 0x1d3f9c); ch.scale.set(c.length, c.height * 0.55, c.width - 0.09); ch.position.y = 0.03 + c.height * 0.275;
    const it = group.getObjectByName('intake')!; it.scale.set(0.02, 0.05, c.intake.width); it.position.set(c.length / 2 + 0.01, 0.05, 0);
    const rear = group.getObjectByName('intakeRear')!; rear.visible = !!c.intake.dualSided; rear.scale.set(0.02, 0.05, c.intake.width); rear.position.set(-c.length / 2 - 0.01, 0.05, 0);
    (it as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>).material.color.set(sim.carried.length >= c.capacity ? 0xd1833a : 0x3ad17a);
    group.getObjectByName('arrow')!.position.set(c.length / 2 - 0.09, 0.03 + c.height * 0.55 + 0.005, 0);
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([a, b], i) => group.getObjectByName(`wheel${i}`)!.position.set(a * c.halfWheelbase, 0.052, b * c.halfTrack));
    // The plates sit just outside the two side faces. The front has the intake and the rear has the shooter.
    this.drawPlate(group, plate, sim.alliance); const py = 0.03 + c.height * 0.33, hz = (c.width - 0.09) / 2 + 0.002;
    ([[0, hz, 0], [0, -hz, Math.PI]] as const).forEach(([x, z, ry], i) => { const pl = group.getObjectByName(`plate${i}`)!; pl.position.set(x, py, z); pl.rotation.y = ry; });
    const carried = group.getObjectByName('carried') as THREE.Group;
    if (carried.userData.key !== sim.carried.join()) {
      carried.userData.key = sim.carried.join(); carried.clear();
      sim.carried.forEach((k, i) => { const m = new THREE.Mesh(k === 'pollen' ? this.ballGeo.pollen : this.ballGeo.nectar, this.ballMat.get(k)); m.position.set(-0.13 + (i % 2) * 0.1 + 0.02, 0.03 + c.height * 0.55 + (k === 'pollen' ? FIELD.pollenRadius : FIELD.nectarRadius), (i < 2 ? -1 : 1) * 0.06); carried.add(m); });
    }
  }

  /** Projects an AUTO trajectory onto the FIELD: a dashed line, a wedge at each pose, and a dashed circle where the robot shoots. */
  showAutoPlan(plan: { path: { x: number; z: number }[]; poses: { x: number; z: number; heading: number; shoots: boolean }[] } | null, key: string) {
    this.autoLine.visible = this.autoPoses.visible = !!plan; if (!plan || key === this.autoKey) return; this.autoKey = key;
    this.autoLine.geometry.dispose(); this.autoLine.geometry = new THREE.BufferGeometry().setFromPoints(plan.path.map(q => new THREE.Vector3(q.x, 0.008, q.z))); this.autoLine.computeLineDistances();
    this.autoPoses.clear();
    // A launch pose gets a dashed circle in the plan's own orange, like its path, so that it reads as an annotation and
    // not as FIELD tape, which is solid red or blue.
    const mat = new THREE.MeshBasicMaterial({ color: 0xffa726 }), shootMat = new THREE.LineDashedMaterial({ color: 0xffa726, dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: 0.85 });
    for (const q of plan.poses) {
      const w = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.13, 3), mat); w.rotation.set(0, q.heading, -Math.PI / 2, 'YXZ'); w.position.set(q.x, 0.01, q.z); w.scale.y = 1; this.autoPoses.add(w);
      if (q.shoots) {
        const pts = Array.from({ length: 49 }, (_, k) => { const a = (k / 48) * 2 * Math.PI; return new THREE.Vector3(q.x + 0.21 * Math.cos(a), 0.009, q.z + 0.21 * Math.sin(a)); });
        const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), shootMat); ring.computeLineDistances(); this.autoPoses.add(ring);
      }
    }
  }

  private handleGroup = new THREE.Group();
  /**
   * Draws the field editor's handles: a disc at each pose, and for a drive step a line to a knob that sets its heading.
   * A selected handle is white and larger, and an edited one has a green ring. Handles draw over the FIELD elements, so
   * that a pose under a FLOWER stays visible. Handles that can't be dragged, on a plan that isn't being edited, are
   * faint. An empty list clears them.
   */
  showHandles(list: readonly { x: number; z: number; heading?: number; kind: 'drive' | 'waypoint'; selected: boolean; edited: boolean }[], editable = true) {
    if (!this.handleGroup.parent) { this.handleGroup.renderOrder = 10; this.scene.add(this.handleGroup); }
    this.handleGroup.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh || (o as THREE.Line).isLine) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    this.handleGroup.clear();
    const flat = (geo: THREE.BufferGeometry, color: number, x: number, z: number, y: number) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: editable ? 1 : 0.6, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.renderOrder = 10; this.handleGroup.add(m); return m;
    };
    for (const h of list) {
      const color = h.selected ? 0xffffff : h.kind === 'drive' ? 0xffa726 : 0x4dd0e1, r = h.selected ? 0.085 : 0.065;
      if (h.edited) flat(new THREE.RingGeometry(r + 0.012, r + 0.03, 32), 0x41e07f, h.x, h.z, 0.021);
      flat(new THREE.CircleGeometry(r, 32), color, h.x, h.z, 0.022);
      if (h.heading === undefined) continue;
      const kx = h.x + KNOB * Math.cos(h.heading), kz = h.z - KNOB * Math.sin(h.heading);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(h.x, 0.022, h.z), new THREE.Vector3(kx, 0.022, kz)]), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: editable ? 1 : 0.6 }));
      line.renderOrder = 10; line.frustumCulled = false; this.handleGroup.add(line);
      flat(new THREE.CircleGeometry(0.035, 20), color, kx, kz, 0.023);
    }
  }

  /**
   * Gets the handle under a screen point, from the same list as `showHandles`: its index, and whether the point is on
   * its heading knob. A knob wins over a disc at the same distance, and for handles at the same place, the one first in
   * the list wins. Returns null if no handle is within 16 pixels.
   */
  handleAt(clientX: number, clientY: number, list: readonly { x: number; z: number; heading?: number }[]): { index: number; part: 'pose' | 'heading' } | null {
    const px = (x: number, z: number) => { const q = new THREE.Vector3(x, 0.022, z).project(this.camera); return Math.hypot(((q.x + 1) / 2) * innerWidth - clientX, ((1 - q.y) / 2) * innerHeight - clientY); };
    let best: { index: number; part: 'pose' | 'heading' } | null = null, bestPx = 16;
    list.forEach((h, index) => {
      // A knob beats a disc of the same handle at the same distance; an earlier handle beats a later one.
      const knob = h.heading !== undefined ? px(h.x + KNOB * Math.cos(h.heading), h.z - KNOB * Math.sin(h.heading)) : Infinity, disc = px(h.x, h.z);
      if (knob <= disc && knob < bestPx) { bestPx = knob; best = { index, part: 'heading' }; }
      else if (disc < bestPx) { bestPx = disc; best = { index, part: 'pose' }; }
    });
    return best;
  }

  // ---- Reference points, offset lines, and the snap grid of the AUTO editor. ----
  private refGroup = new THREE.Group(); private linkGroup = new THREE.Group(); private gridGroup = new THREE.Group();

  private clearGroup(g: THREE.Group) {
    if (!g.parent) { g.renderOrder = 11; this.scene.add(g); }
    g.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh || (o as THREE.Line).isLine) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    g.clear();
  }

  /**
   * Draws the reference points: small purple discs, over the step handles. A selected one is larger and has a heading
   * knob, an edited one has a green ring, and `lit` has a yellow ring: a dragged pose that will refer to it on release.
   */
  showRefs(list: readonly { x: number; z: number; heading: number; selected: boolean; edited: boolean; lit: boolean }[], editable = true) {
    this.clearGroup(this.refGroup);
    const flat = (geo: THREE.BufferGeometry, color: number, x: number, z: number, y: number) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: editable ? 1 : 0.7, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.renderOrder = 11; this.refGroup.add(m);
    };
    for (const r of list) {
      const rad = r.selected ? 0.05 : 0.035, color = r.selected ? 0xe1bee7 : 0xb388ff;
      if (r.lit) flat(new THREE.RingGeometry(rad + 0.015, rad + 0.04, 32), 0xffee58, r.x, r.z, 0.024);
      else if (r.edited) flat(new THREE.RingGeometry(rad + 0.01, rad + 0.025, 32), 0x41e07f, r.x, r.z, 0.024);
      flat(new THREE.CircleGeometry(rad, 24), color, r.x, r.z, 0.025);
      if (!r.selected) continue;
      const kx = r.x + KNOB * Math.cos(r.heading), kz = r.z - KNOB * Math.sin(r.heading);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(r.x, 0.025, r.z), new THREE.Vector3(kx, 0.025, kz)]), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
      line.renderOrder = 11; this.refGroup.add(line); flat(new THREE.CircleGeometry(0.03, 20), color, kx, kz, 0.026);
    }
  }

  /** Gets the reference point under a screen point: its index, and whether the point is on the selected one's knob. A disc counts within 7 pixels only, so that a step handle around it stays easy to grab. */
  refAt(clientX: number, clientY: number, list: readonly { x: number; z: number; heading: number; selected: boolean }[]): { index: number; part: 'pose' | 'heading' } | null {
    // The selected point's knob first, within 10 pixels; then the nearest disc, within 7.
    const sel = list.findIndex(r => r.selected), r = list[sel];
    if (r && this.screenDist(clientX, clientY, r.x + KNOB * Math.cos(r.heading), r.z - KNOB * Math.sin(r.heading)) < 10) return { index: sel, part: 'heading' };
    let best: number | null = null, bestPx = 7;
    list.forEach((q, i) => { const d = this.screenDist(clientX, clientY, q.x, q.z); if (d < bestPx) { bestPx = d; best = i; } });
    return best === null ? null : { index: best, part: 'pose' };
  }

  /** Checks whether a screen point is within `px` pixels of a point on the floor. */
  nearPoint(clientX: number, clientY: number, p: { x: number; z: number }, px: number) { return this.screenDist(clientX, clientY, p.x, p.z) <= px; }

  private screenDist(clientX: number, clientY: number, x: number, z: number) {
    const q = new THREE.Vector3(x, 0.022, z).project(this.camera); return Math.hypot(((q.x + 1) / 2) * innerWidth - clientX, ((1 - q.y) / 2) * innerHeight - clientY);
  }

  /** Draws dotted white lines from offset poses to their reference points. A selected line is yellow. */
  showLinks(list: readonly { from: { x: number; z: number }; to: { x: number; z: number }; selected: boolean }[]) {
    this.clearGroup(this.linkGroup);
    for (const l of list) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(l.from.x, 0.023, l.from.z), new THREE.Vector3(l.to.x, 0.023, l.to.z)]),
        new THREE.LineDashedMaterial({ color: l.selected ? 0xffee58 : 0xffffff, dashSize: 0.03, gapSize: 0.025, depthTest: false, transparent: true, opacity: l.selected ? 1 : 0.8 }));
      line.computeLineDistances(); line.renderOrder = 11; line.frustumCulled = false; this.linkGroup.add(line);
    }
  }

  /**
   * Gets the line under a screen point, from the same list as `showLinks`, within 6 pixels. A line counts where it
   * shows: outside the step disc at its start, 0.085 m, and the reference point disc at its end, 0.05 m.
   */
  linkAt(clientX: number, clientY: number, list: readonly { from: { x: number; z: number }; to: { x: number; z: number } }[]): number | null {
    const px = (p: { x: number; z: number }) => { const q = new THREE.Vector3(p.x, 0.023, p.z).project(this.camera); return { x: ((q.x + 1) / 2) * innerWidth, y: ((1 - q.y) / 2) * innerHeight }; };
    let best: number | null = null, bestPx = 6;
    list.forEach((l, i) => {
      const len = Math.hypot(l.to.x - l.from.x, l.to.z - l.from.z), a = px(l.from), b = px(l.to), dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      if (len <= 0.135 || l2 < 1) return;
      const t = ((clientX - a.x) * dx + (clientY - a.y) * dy) / l2; if (t < 0.085 / len || t > 1 - 0.05 / len) return;
      const d = Math.hypot(a.x + t * dx - clientX, a.y + t * dy - clientY); if (d < bestPx) { bestPx = d; best = i; }
    });
    return best;
  }

  /** Draws the snap grid, 1 in apart, in a 12 in square around a point, so that it doesn't cover the FIELD. Null hides it. */
  showGrid(at: { x: number; z: number } | null) {
    this.clearGroup(this.gridGroup); if (!at) return;
    const step = 0.0254, n = 6, cx = Math.round(at.x / step) * step, cz = Math.round(at.z / step) * step, pts: number[] = [];
    for (let k = -n; k <= n; k++) {
      pts.push(cx + k * step, 0.021, cz - n * step, cx + k * step, 0.021, cz + n * step);
      pts.push(cx - n * step, 0.021, cz + k * step, cx + n * step, 0.021, cz + k * step);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.18 }));
    lines.renderOrder = 9; lines.frustumCulled = false; this.gridGroup.add(lines);
  }

  // ---- Ghost robots: a see-through robot at the selected pose, and one that runs the path into it and out of it. ----
  private ghost: THREE.Group | null = null; private runner: THREE.Group | null = null; private ghostCfg = '';
  private run: { into: Pose2[]; out: Pose2[]; at: number } | null = null;

  /** Builds a see-through robot: the chassis, the intake bars, and the heading arrow, as `syncRobot` sizes them. */
  private buildGhost(c: RobotConfig): THREE.Group {
    const g = new THREE.Group(), mat = (color: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false });
    const box = (sx: number, sy: number, sz: number, x: number, y: number, color: number) => { const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat(color)); m.position.set(x, y, 0); g.add(m); };
    box(c.length, c.height * 0.55, c.width - 0.09, 0, 0.03 + c.height * 0.275, 0xdde3ea);
    box(0.03, 0.06, c.intake.width, c.length / 2 + 0.015, 0.05, 0x3ad17a);
    if (c.intake.dualSided) box(0.03, 0.06, c.intake.width, -c.length / 2 - 0.015, 0.05, 0x3ad17a);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 3), mat(0xffffff)); arrow.rotation.z = -Math.PI / 2; arrow.position.set(c.length / 2 - 0.09, 0.04 + c.height * 0.55, 0); g.add(arrow);
    g.visible = false; this.scene.add(g); return g;
  }

  private setOpacity(g: THREE.Group, a: number) { g.traverse(o => { const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined; if (m) m.opacity = a; }); g.visible = a > 0.01; }

  /**
   * Shows a see-through robot at a pose, at half opacity, and after a second runs a second one along `into`, the path
   * to the pose, fading in, and then along `out`, the path to the next pose, fading out, again and again. Positions
   * are the simulator's x and z, and headings are in radians. Null hides both.
   */
  showGhost(at: Pose2 | null, cfg: RobotConfig | null, into: Pose2[] = [], out: Pose2[] = []) {
    if (!at || !cfg) { if (this.ghost) this.ghost.visible = false; if (this.runner) this.runner.visible = false; this.run = null; return; }
    const key = `${cfg.length}:${cfg.width}:${cfg.height}:${cfg.intake.width}:${!!cfg.intake.dualSided}`;
    if (key !== this.ghostCfg) { for (const g of [this.ghost, this.runner]) if (g) this.scene.remove(g); this.ghost = this.buildGhost(cfg); this.runner = this.buildGhost(cfg); this.ghostCfg = key; }
    this.ghost!.position.set(at.x, 0, at.z); this.ghost!.rotation.y = at.heading; this.setOpacity(this.ghost!, 0.5);
    // A turn changes only headings, so the check compares them too: an edited pose restarts the run, a second later.
    const eq = (a: Pose2[], b: Pose2[]) => a.length === b.length && a.every((q, i) => q.x === b[i].x && q.z === b[i].z && q.heading === b[i].heading);
    const same = this.run && eq(this.run.into, into) && eq(this.run.out, out);
    if (!same) this.run = into.length > 1 || out.length > 1 ? { into, out, at: performance.now() + 1000 } : null;
  }

  /** Moves the running ghost for this frame. It drives 0.8 m/s, holds 0.3 s at the pose, and rests 0.6 s between runs. */
  private stepGhost(now: number) {
    const r = this.run, g = this.runner; if (!g) return; if (!r || now < r.at) { g.visible = false; return; }
    const len = (p: Pose2[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - p[i].x, q.z - p[i].z), 0);
    const tIn = Math.max(0.6, len(r.into) / 0.8), tOut = Math.max(0.6, len(r.out) / 0.8), cycle = tIn + 0.3 + tOut + 0.6;
    let t = ((now - r.at) / 1000) % cycle, pose: Pose2 | null = null, a = 0;
    if (t < tIn) { pose = along(r.into, t / tIn); a = 0.5 * (t / tIn); }
    else if ((t -= tIn) < 0.3) { pose = r.into[r.into.length - 1] ?? null; a = 0.5; }
    else if ((t -= 0.3) < tOut) { pose = along(r.out, t / tOut); a = 0.5 * (1 - t / tOut); }
    if (!pose) { g.visible = false; return; }
    g.position.set(pose.x, 0, pose.z); g.rotation.y = pose.heading; this.setOpacity(g, a);
  }
  private debugLines = new THREE.Group();
  /** Draws each robot's planned path, for the review mode. An empty list clears them. */
  showDebugPaths(list: { pts: [number, number][]; color: number }[]) {
    if (!this.debugLines.parent) this.scene.add(this.debugLines); this.debugLines.clear();
    for (const l of list) { if (l.pts.length < 2) continue; const g = new THREE.BufferGeometry().setFromPoints(l.pts.map(([x, z]) => new THREE.Vector3(x, 0.014, z))); const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: l.color })); line.frustumCulled = false; this.debugLines.add(line); }
  }

  /**
   * Gets the index of the robot at a screen point, for click-to-annotate. A click that misses every robot mesh selects
   * the robot whose projected center is within `nearPx` pixels, because a robot at the far side of the FIELD is a small
   * target. Default: 70. With 0, only a click on the robot itself counts.
   */
  pickRobot(clientX: number, clientY: number, nearPx = 70): number | null {
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((clientX / innerWidth) * 2 - 1, 1 - (clientY / innerHeight) * 2), this.camera);
    const shown = this.robotGroups.filter(g => g.visible), hit = ray.intersectObjects(shown, true)[0];
    if (hit) { let o: THREE.Object3D = hit.object; while (o.parent && !shown.includes(o as THREE.Group)) o = o.parent; return this.robotGroups.indexOf(o as THREE.Group); }
    let best: number | null = null, bestPx = nearPx;
    shown.forEach(g => { const q = g.position.clone().setY(0.15).project(this.camera), d = Math.hypot(((q.x + 1) / 2) * innerWidth - clientX, ((1 - q.y) / 2) * innerHeight - clientY); if (q.z < 1 && d < bestPx) { bestPx = d; best = this.robotGroups.indexOf(g); } });
    return best;
  }

  /**
   * Gets the FIELD position under a screen point, in field coordinates in meters, or null if the point misses the
   * FIELD floor. Field y is the negative of the simulator's z axis. See `buildAxisLabels`.
   */
  pickFloor(clientX: number, clientY: number): { x: number; y: number } | null {
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((clientX / innerWidth) * 2 - 1, 1 - (clientY / innerHeight) * 2), this.camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    return hit && Math.abs(hit.x) <= FIELD.half && Math.abs(hit.z) <= FIELD.half ? { x: hit.x, y: -hit.z } : null;
  }

  /**
   * Labels the field coordinate system on the floor outside the perimeter. The origin is the FIELD center, x runs from
   * the red wall (negative) to the blue wall, y runs from the audience wall (negative) to the rear wall, and the unit
   * is the meter. With z up, the system is right-handed, and a heading is counterclockwise from +x, seen from above.
   * The simulator's code uses three.js axes, where the floor is x and z: field y is the negative of that z.
   */
  private buildAxisLabels() {
    const label = (text: string, x: number, z: number) => {
      const cv = document.createElement('canvas'); cv.width = 512; cv.height = 96; const g = cv.getContext('2d')!;
      g.fillStyle = 'rgba(233,236,241,0.55)'; g.font = '600 44px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 256, 48);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.225), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.position.set(x, -0.01, z); this.scene.add(m);
    };
    const e = FIELD.half + 0.32;
    label('+x  blue wall', e + 0.35, 0); label('-x  red wall', -e - 0.35, 0); label('-y  audience', 0, e); label('+y  rear', 0, -e);
    const cross = new THREE.BufferGeometry(); cross.setAttribute('position', new THREE.Float32BufferAttribute([-0.06, 0.003, 0, 0.06, 0.003, 0, 0, 0.003, -0.06, 0, 0.003, 0.06], 3));
    this.scene.add(new THREE.LineSegments(cross, new THREE.LineBasicMaterial({ color: 0xe9ecf1, transparent: true, opacity: 0.5 })));
  }

  cycleCamera() { this.mode = CAMERAS[(CAMERAS.indexOf(this.mode) + 1) % CAMERAS.length]; }

  /**
   * The heading that the third-person camera looks along, in radians, or NaN under any other camera. Field-centric
   * sticks drive relative to it, so pushing up drives away from the camera.
   */
  get chaseYaw(): number { return this.mode === 'chase' && !this.freeLook && !this.vr ? this.chase.yaw + this.chase.yawOff : Number.NaN; }

  /** Runs `fn` once per display frame, in the page or in a headset. A headset session has no window animation frames. */
  loop(fn: (now: number) => void) { this.renderer.setAnimationLoop(fn); }

  /** Whether a headset shows the FIELD. */
  get vr() { return this.renderer.xr.isPresenting; }

  /** Starts a headset session: the viewer stands in the alliance area of the focus robot, behind the ALLIANCE wall. */
  async enterVR() {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr; if (!xr) throw new Error('this browser has no WebXR');
    const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    this.renderer.xr.setReferenceSpaceType('local-floor'); this.renderer.xr.setFoveation(1);
    await this.renderer.xr.setSession(session);
    return session;
  }

  /** Draws the scoreboard that hangs over the far side of the FIELD in a headset. It redraws only when the text changes. */
  board(red: number, blue: number, clock: string, phase: string) {
    const key = `${red}|${blue}|${clock}|${phase}`; if (!this.vr || this.boardMesh.userData.key === key) return; this.boardMesh.userData.key = key;
    const mat = this.boardMesh.material as THREE.MeshBasicMaterial, cv = mat.map!.image as HTMLCanvasElement, g = cv.getContext('2d')!;
    g.fillStyle = '#d8261c'; g.fillRect(0, 0, 340, 256); g.fillStyle = '#1f4fd8'; g.fillRect(684, 0, 340, 256); g.fillStyle = '#f4f5f7'; g.fillRect(340, 0, 344, 256);
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '800 150px "Barlow Condensed", sans-serif'; g.fillStyle = '#fff';
    g.fillText(String(red), 170, 132); g.fillText(String(blue), 854, 132);
    g.fillStyle = '#14171c'; g.font = '800 120px "Barlow Condensed", sans-serif'; g.fillText(clock, 512, 92);
    g.font = '700 58px "Barlow Condensed", sans-serif'; g.fillText(phase.toUpperCase(), 512, 212); mat.map!.needsUpdate = true;
  }

  /** Puts the headset's origin in the alliance area on `side`, 0.7 m behind the ALLIANCE wall, facing the FIELD, and hangs the scoreboard across from it. */
  private standAt(side: number) {
    this.rig.position.set(side * (FIELD.half + 0.7), 0, side * -0.6);
    this.rig.rotation.y = Math.atan2(this.rig.position.x, this.rig.position.z);
    this.boardMesh.visible = true; this.boardMesh.position.set(-side * 2.6, 2.1, 0); this.boardMesh.lookAt(this.rig.position.x, 1.6, this.rig.position.z);
  }

  /** Enters free-look mode from where the camera is, so the view doesn't jump. */
  enterFreeLook() {
    this.freeLook = true;
    this.fl.radius = this.camera.position.distanceTo(this.fl.target);
    this.fl.phi   = Math.acos(clamp((this.camera.position.y - this.fl.target.y) / this.fl.radius, -1, 1));
    this.fl.theta = Math.atan2(this.camera.position.x - this.fl.target.x, this.camera.position.z - this.fl.target.z);
  }

  exitFreeLook() { this.freeLook = false; }

  private attachFreeLook(canvas: HTMLCanvasElement) {
    const p = this._pointer;
    canvas.addEventListener('pointerdown', e => {
      if (!this.freeLook) {
        // A left drag looks around the robot in the third-person camera.
        this.dragged = false;
        if (this.mode === 'chase' && e.button === 0) { p.x = e.clientX; p.y = e.clientY; p.btn = 0; this.chase.dragging = true; canvas.setPointerCapture(e.pointerId); }
        return;
      }
      p.x = e.clientX; p.y = e.clientY; p.btn = e.button;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', e => {
      if (p.btn < 0) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (!this.freeLook) {
        if (this.chase.dragging) { this.dragged ||= Math.abs(dx) + Math.abs(dy) > 2; this.chase.yawOff = clamp(this.chase.yawOff - dx * 0.006, -Math.PI, Math.PI); this.chase.pitchOff = clamp(this.chase.pitchOff + dy * 0.004, -0.3, 0.8); }
        return;
      }
      if (p.btn === 0) {
        this.fl.theta -= dx * 0.007;
        this.fl.phi    = clamp(this.fl.phi + dy * 0.007, 0.05, Math.PI - 0.05);
      } else if (p.btn === 2) {
        // A right drag pans the target: sideways along the screen, and up and down.
        const panSpeed = this.fl.radius * 0.0012;
        const right = new THREE.Vector3(); right.crossVectors(
          new THREE.Vector3(Math.sin(this.fl.theta) * Math.sin(this.fl.phi), 0, Math.cos(this.fl.theta) * Math.sin(this.fl.phi)),
          new THREE.Vector3(0, 1, 0)).normalize();
        this.fl.target.addScaledVector(right, -dx * panSpeed);
        this.fl.target.y = clamp(this.fl.target.y - dy * panSpeed * 0.5, -0.5, 2.5);
        this.fl.target.x = clamp(this.fl.target.x, -4, 4);
        this.fl.target.z = clamp(this.fl.target.z, -4, 4);
      }
    });
    const release = () => { p.btn = -1; this.chase.dragging = false; };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('wheel', e => {
      if (this.freeLook) { e.preventDefault(); this.fl.radius = clamp(this.fl.radius * (1 + e.deltaY * 0.001), 0.4, 14); }
      else if (this.mode === 'chase') { e.preventDefault(); this.chase.dist = clamp(this.chase.dist * (1 + e.deltaY * 0.001), 0.8, 4.5); }
    }, { passive: false });
    canvas.addEventListener('contextmenu', e => { if (this.freeLook) e.preventDefault(); });
  }

  /** Moves the camera while paused, by arrow key: free look pans its target, the third-person camera moves in and out, and the others pan (overhead) and zoom. */
  adjustView(key: string) {
    if (this.freeLook) {
      const PAN = 0.18;
      if (key === 'ArrowLeft')  this.fl.target.x -= PAN;
      if (key === 'ArrowRight') this.fl.target.x += PAN;
      if (key === 'ArrowUp')    this.fl.target.z -= PAN;
      if (key === 'ArrowDown')  this.fl.target.z += PAN;
      this.fl.target.x = clamp(this.fl.target.x, -4, 4);
      this.fl.target.z = clamp(this.fl.target.z, -4, 4);
      return;
    }
    if (this.mode === 'chase') {
      if (key === 'ArrowUp') this.chase.dist = clamp(this.chase.dist - 0.2, 0.8, 4.5);
      if (key === 'ArrowDown') this.chase.dist = clamp(this.chase.dist + 0.2, 0.8, 4.5);
      return;
    }
    if (this.mode === 'overhead') {
      const PAN = 0.3;
      if (key === 'ArrowLeft')  this.camera.position.x -= PAN;
      if (key === 'ArrowRight') this.camera.position.x += PAN;
    }
    if (key === 'ArrowUp')   this.camera.fov = Math.max(10, this.camera.fov - 3);
    if (key === 'ArrowDown') this.camera.fov = Math.min(90, this.camera.fov + 3);
    this.camera.updateProjectionMatrix();
  }

  /** Drops the pixel ratio to 1 when frames run slow for 3 s at a higher ratio, as on a laptop's GPU at 2x. */
  private adapt() {
    const f = this.frameTime, now = performance.now(), ms = f.last ? Math.min(100, now - f.last) : 16; f.last = now;
    f.avg += (ms - f.avg) * 0.05; f.slow = f.avg > 24 ? f.slow + ms : 0;
    if (f.slow > 3000 && this.renderer.getPixelRatio() > 1) { this.renderer.setPixelRatio(1); this.resize(); f.slow = 0; }
  }
  private frameTime = { avg: 16, slow: 0, last: 0 };

  sync(sim: Sim, previewKind: 'pollen' | 'nectar' | null, path: { x: number; z: number }[] | null = null) {
    if (!this.vr) this.adapt();
    this.pathLine.visible = !!path && path.length > 1;
    if (path && path.length > 1) this.pathLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(path.flatMap(q => [q.x, 0.012, q.z]), 3));
    while (this.robotGroups.length < sim.robots.length) this.robotGroups.push(this.buildRobot());
    this.robotGroups.forEach((g, i) => { g.visible = i < sim.robots.length; if (g.visible) { const r = sim.robots[i]; this.syncRobot(g, sim.view(i), this.plates[i] ?? `${r.alliance === 'red' ? 'R' : 'B'}${r.slot}`); } });
    const p = sim.robot.translation();
    this.stepGhost(performance.now());

    const n: Record<BallKind, number> = { pollen: 0, nectar_red: 0, nectar_blue: 0 }, xf = this.ballXf;
    const put = (k: BallKind) => {
      let im = this.balls.get(k)!;
      if (n[k] >= im.instanceMatrix.count) { const prev = im; im = this.growBalls(k, prev.instanceMatrix.count * 2); im.instanceMatrix.array.set(prev.instanceMatrix.array); }
      im.setMatrixAt(n[k]++, xf.m.compose(xf.p, xf.q, xf.s));
    };
    for (const b of sim.balls.values()) {
      const t = b.body.translation(); xf.p.set(t.x, t.y, t.z);
      // The ball turns with its physics body, so its holes roll. A replayed trace has positions only.
      const q = (b.body as { rotation?: () => { x: number; y: number; z: number; w: number } }).rotation?.(); if (q) xf.q.set(q.x, q.y, q.z, q.w); else xf.q.identity();
      put(b.kind);
    }
    xf.q.identity();
    for (const f of sim.flowers) { const hs = flowerHeights(f.stack); f.stack.forEach((k, i) => { xf.p.set(f.x, hs[i] + (k === 'pollen' ? FIELD.pollenRadius : FIELD.nectarRadius), f.z); put(k); }); }
    for (const [k, im] of this.balls) { im.count = n[k]; im.instanceMatrix.needsUpdate = true; }
    // The CAD poses the red HIVE at -30 degrees and the blue HIVE at +30 degrees.
    if (this.hiveNodes.red) this.hiveNodes.red.rotation.x = sim.hives.red.phi + HIVE.tiltLimit;
    if (this.hiveNodes.blue) this.hiveNodes.blue.rotation.x = sim.hives.blue.phi - HIVE.tiltLimit;

    if (previewKind) {
      const pv = sim.previewShot(previewKind); this.arc.visible = true;
      this.arc.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pv.points.flat(), 3)); this.arcMat.color.set(pv.scores ? 0x41e07f : 0xe8e8e8); this.onTarget = pv.scores;
    } else { this.arc.visible = false; this.onTarget = null; }

    const side = sim.alliance === 'red' ? -1 : 1;
    if (this.vr) { this.standAt(side); this.renderer.render(this.scene, this.camera); return; }
    if (this.freeLook) {
      const f = this.fl;
      const x = f.target.x + f.radius * Math.sin(f.phi) * Math.sin(f.theta);
      const y = f.target.y + f.radius * Math.cos(f.phi);
      const z = f.target.z + f.radius * Math.sin(f.phi) * Math.cos(f.theta);
      this.camera.fov = 58;
      this.camera.position.set(x, y, z);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(f.target);
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // The overhead camera rolls to keep the FIELD's long side across the screen; the others stand upright. The up
    // vector is set before `lookAt`, which consumes it.
    if (this.mode === 'overhead') this.camera.up.set(side < 0 ? 1 : -1, 0, 0);
    else this.camera.up.set(0, 1, 0);
    const at = new THREE.Vector3();
    if (this.mode === 'driver') { this.camera.fov = 52; this.camera.position.set(side * 3.5, 1.68, side * -0.6); at.set(side * -0.2, 0.3, 0); }
    else if (this.mode === 'overhead') {
      this.camera.fov = 40;
      // With the side panels out (the AUTO editor), lift the camera so the whole FIELD fits the strip between them: the
      // projected width must fit the strip, and so must the projected height. The fov stays put; the camera height does
      // the fitting. Outside the editor the insets are zero and this is the plain 6.4 m view.
      let h = 6.4;
      if (this.insetLeft > 0 || this.insetRight > 0) {
        const tan = Math.tan((20 * Math.PI) / 180), w = 2 * (FIELD.half + 0.08);
        h = Math.max(h, (w * innerHeight) / (2 * tan * (innerWidth - this.insetLeft - this.insetRight)), w / (2 * tan));
      }
      this.camera.position.set(0, h, 0.001);
      at.set(0, 0, 0);
    }
    else if (this.mode === 'audience') { this.camera.fov = 50; this.camera.position.set(0, 2.4, 4.4); at.set(0, 0.4, 0); }
    else {
      // The third-person camera sits behind the shooter's aim, so the middle of the screen is where a launch goes: a
      // turret's angle, or the end that launches. It trails the aim with a time constant of 1/8 s.
      const c = this.chase, now = performance.now(), dt = c.last ? Math.min(0.1, (now - c.last) / 1000) : 0, aim = sim.aimHeading(); c.last = now;
      c.yaw = Number.isFinite(c.yaw) ? c.yaw + wrap(aim - c.yaw) * (1 - Math.exp(-8 * dt)) : aim;
      if (!c.dragging) { const k = Math.exp(-2.5 * dt); c.yawOff *= k; c.pitchOff *= k; }
      const yaw = c.yaw + c.yawOff, ux = Math.cos(yaw), uz = -Math.sin(yaw), base = 0.42 + c.pitchOff;
      // Behind the perimeter, the wall and the alliance-area props would hide the robot, so the camera rises over them.
      const out = Math.max(Math.abs(p.x - ux * c.dist * Math.cos(base)), Math.abs(p.z - uz * c.dist * Math.cos(base))) - FIELD.half;
      c.lift += (Math.min(0.75, (Math.max(0, out) / c.dist) * 1.5) - c.lift) * (dt ? 1 - Math.exp(-6 * dt) : 1);
      const pitch = base + c.lift, back = c.dist * Math.cos(pitch);
      this.camera.fov = 62; this.camera.position.set(p.x - ux * back, 0.25 + c.dist * Math.sin(pitch), p.z - uz * back); const ahead = 1.4 * (1 - c.lift); at.set(p.x + ux * ahead, 0.35, p.z + uz * ahead);
    }
    this.camera.lookAt(at);
    // Slide the camera along the screen's horizontal axis by half the difference of the side panels' widths, so that
    // the FIELD centers in the strip between them. The overhead camera looks straight down, so its shift is exact;
    // for the angled cameras it is close.
    if (this.insetLeft > 0 || this.insetRight > 0) {
      const pxPerM = innerHeight / (2 * this.camera.position.distanceTo(at) * Math.tan(((this.camera.fov / 2) * Math.PI) / 180));
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      this.camera.position.addScaledVector(right, -(this.insetLeft - this.insetRight) / 2 / pxPerM);
    }
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }
}
