// Converts the official BIOBUZZ field STEP file to public/field.glb and
// writes cad/field-manifest.json (staging positions and part bounding boxes).
// Run: node scripts/convert-step.mjs   (takes about two minutes)
// Then compress it, which takes it from 17 MB to 2 MB:
//   npx @gltf-transform/cli@4.1.1 meshopt --quantization-volume scene public/field.glb public/field.glb
// Quantization moves each node's origin, so the viewer turns each HIVE about HIVE.pivotX and HIVE.pivotY.
import fs from 'node:fs';
import occtFactory from 'occt-import-js';
import { MeshoptSimplifier } from 'meshoptimizer';

const STEP = 'cad/field-cad-step.step';
// Parts with a bounding-box diagonal under this size (screws, nuts, washers)
// are dropped to keep the GLB small. Meters.
const MIN_DIAGONAL = 0.035;
// Pivot axis of both hives in CAD coordinates (meters). Y is up.
const PIVOT_Y = 1.11655;

// Components with more triangles than this are simplified to this count.
const MAX_TRIS = { perimeter: 25000, frame: 20000, hive: 30000, flower: 12000 };

await MeshoptSimplifier.ready;
const occt = await occtFactory();
const r = occt.ReadStepFile(new Uint8Array(fs.readFileSync(STEP)), {
  linearUnit: 'meter', linearDeflectionType: 'absolute_value',
  linearDeflection: 0.004, angularDeflection: 0.9,
});
if (!r.success) throw new Error('STEP import failed');

const bbox = (p) => {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = 0; k < p.length; k += 3) for (let a = 0; a < 3; a++) {
    b[a] = Math.min(b[a], p[k + a]); b[a + 3] = Math.max(b[a + 3], p[k + a]);
  }
  return b;
};
const union = (a, b) => [0, 1, 2].map(i => Math.min(a[i], b[i])).concat([3, 4, 5].map(i => Math.max(a[i], b[i])));
const round = (b) => b.map(v => +v.toFixed(4));
const allMeshes = (n) => [...n.meshes, ...n.children.flatMap(allMeshes)];

const classify = (name) => {
  if (name.includes('Pollen')) return 'pollen';
  if (name.includes('Red Nectar')) return 'nectar_red';
  if (name.includes('Blue Nectar')) return 'nectar_blue';
  if (name.includes('Soft Tiles')) return 'tiles';
  if (name.includes('Quick Release Pin')) return 'skip';
  if (name.includes('Gaffer Tape, Red')) return 'tape_red';
  if (name.includes('Gaffer Tape, Blue')) return 'tape_blue';
  if (name.includes('Red Hive')) return 'hive_red';
  if (name.includes('Blue Hive')) return 'hive_blue';
  if (name.includes('Frame')) return 'frame';
  if (name.includes('Perimeter')) return 'perimeter';
  if (name.includes('Tray')) return 'tray';
  const f = name.match(/Flower Assembly <(\d)>/);
  if (f) return `flower_${f[1]}`;
  return 'other';
};

const manifest = { units: 'meter', axes: 'X red->blue, Y up, Z rear->audience', staging: { pollen: [], nectar_red: [], nectar_blue: [] }, components: {}, hiveParts: {} };
const groups = new Map(); // component -> colorKey -> {pos:[], nrm:[], idx:[], color}

const top = r.root.children[0];
const counts = {};
for (const node of top.children) {
  const kind = classify(node.name);
  const idxs = allMeshes(node);
  let nb = null;
  for (const i of idxs) { const b = bbox(r.meshes[i].attributes.position.array); nb = nb ? union(nb, b) : b; }
  if (kind === 'pollen' || kind.startsWith('nectar')) {
    manifest.staging[kind].push(round([(nb[0] + nb[3]) / 2, (nb[1] + nb[4]) / 2, (nb[2] + nb[5]) / 2]));
    continue;
  }
  if (kind === 'skip') continue;
  let comp = kind;
  if (kind.startsWith('tape') || kind === 'tray' || kind === 'other') { counts[kind] = (counts[kind] || 0) + 1; comp = `${kind}_${counts[kind]}`; }
  manifest.components[comp] = { name: node.name, bbox: round(nb) };
  if (kind === 'tiles') continue; // The app draws its own floor plane.
  const offset = kind.startsWith('hive') ? [(nb[0] + nb[3]) / 2, PIVOT_Y, 0] : [0, 0, 0];
  if (kind.startsWith('hive')) { manifest.components[comp].pivot = round(offset); manifest.hiveParts[comp] = []; }
  for (const i of idxs) {
    const m = r.meshes[i]; const p = m.attributes.position.array; const b = bbox(p);
    const diag = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    if (kind.startsWith('hive') && m.index.array.length / 3 > 500) {
      // Local frame: pivot at the origin, hive rotated back to level (phi = 0).
      const phi = kind === 'hive_red' ? -Math.PI / 6 : Math.PI / 6;
      const c = Math.cos(-phi), s = Math.sin(-phi); const lp = new Float32Array(p.length);
      for (let k = 0; k < p.length; k += 3) {
        const y = p[k + 1] - offset[1], z = p[k + 2] - offset[2];
        lp[k] = p[k] - offset[0]; lp[k + 1] = y * c - z * s; lp[k + 2] = y * s + z * c;
      }
      manifest.hiveParts[comp].push({ name: m.name, bbox: round(b), localBbox: round(bbox(lp)), tris: m.index.array.length / 3 });
    }
    if (diag < MIN_DIAGONAL && !kind.startsWith('tape')) continue;
    const color = m.color || [0.6, 0.6, 0.6];
    const key = color.map(c => c.toFixed(3)).join(',');
    if (!groups.has(comp)) groups.set(comp, new Map());
    const g = groups.get(comp);
    if (!g.has(key)) g.set(key, { pos: [], nrm: [], idx: [], color });
    const t = g.get(key); const base = t.pos.length / 3;
    for (let k = 0; k < p.length; k += 3) t.pos.push(p[k] - offset[0], p[k + 1] - offset[1], p[k + 2] - offset[2]);
    const n = m.attributes.normal?.array; if (n) for (const v of n) t.nrm.push(v);
    for (const v of m.index.array) t.idx.push(v + base);
  }
}

// Minimal GLB writer.
const chunks = []; let byteLength = 0;
const gltf = { asset: { version: '2.0', generator: 'ftc-biobuzz-sim convert-step' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] };
const addView = (typed, target) => {
  const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (buf.length % 4)) % 4;
  gltf.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: buf.length, target });
  chunks.push(buf, Buffer.alloc(pad)); byteLength += buf.length + pad;
  return gltf.bufferViews.length - 1;
};
const matIndex = new Map();
let totalTris = 0;
for (const [comp, g] of groups) {
  const prims = [];
  for (const [key, t] of g) {
    if (!matIndex.has(key)) {
      matIndex.set(key, gltf.materials.length);
      gltf.materials.push({ pbrMetallicRoughness: { baseColorFactor: [...t.color, 1], metallicFactor: 0.1, roughnessFactor: 0.7 }, doubleSided: true });
    }
    const limitKey = Object.keys(MAX_TRIS).find(k => comp.startsWith(k));
    if (limitKey) {
      const compTris = [...g.values()].reduce((a, v) => a + v.idx.length / 3, 0);
      const ratio = MAX_TRIS[limitKey] / compTris;
      if (ratio < 1) {
        const target = Math.max(3, Math.floor(t.idx.length * ratio / 3) * 3);
        const [ni] = MeshoptSimplifier.simplify(new Uint32Array(t.idx), new Float32Array(t.pos), 3, target, 0.02, []);
        t.idx = Array.from(ni);
      }
    }
    const pos = new Float32Array(t.pos); const b = bbox(pos);
    const attrs = {};
    gltf.accessors.push({ bufferView: addView(pos, 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min: b.slice(0, 3), max: b.slice(3) });
    attrs.POSITION = gltf.accessors.length - 1;
    if (t.nrm.length === t.pos.length) {
      gltf.accessors.push({ bufferView: addView(new Float32Array(t.nrm), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3' });
      attrs.NORMAL = gltf.accessors.length - 1;
    }
    const idx = new Uint32Array(t.idx);
    gltf.accessors.push({ bufferView: addView(idx, 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
    prims.push({ attributes: attrs, indices: gltf.accessors.length - 1, material: matIndex.get(key) });
    totalTris += idx.length / 3;
  }
  gltf.meshes.push({ name: comp, primitives: prims });
  const node = { name: comp, mesh: gltf.meshes.length - 1 };
  const pivot = manifest.components[comp].pivot; if (pivot) node.translation = pivot;
  gltf.nodes.push(node); gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
}
gltf.buffers.push({ byteLength });
let json = Buffer.from(JSON.stringify(gltf)); json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const bin = Buffer.concat(chunks);
const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync('public/field.glb', Buffer.concat([header, jh, json, bh, bin]));
fs.writeFileSync('cad/field-manifest.json', JSON.stringify(manifest, null, 1));
console.log('triangles', totalTris, 'glb MB', (fs.statSync('public/field.glb').size / 1e6).toFixed(1));
