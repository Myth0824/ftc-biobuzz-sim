/**
 * Reads a Pedro Pathing OpMode's Java source and writes an AUTO tree that drives the same paths. It understands both
 * Pedro APIs: the 1.x builder (`new BezierLine`, `pathBuilder().addPath(...).setLinearHeadingInterpolation(...)`) and the
 * 2.x one (`line(a, b).linear(a, b)`, `curve(...)`, `.constant(h)`, `.tangent()`). It doesn't run the OpMode: it
 * evaluates the declarations of numbers, poses, and paths, and takes the paths in the order that the source follows
 * them. It also reads the mechanism calls between and inside the paths, by their names: an intake that runs while a
 * path is followed wraps that path with `intake.run`, a launch becomes `shooter.shoot`, and a sleep or a timer
 * becomes `wait`. See `mechanism` for the names it knows.
 *
 * Pedro poses are in inches on a 144 in. FIELD with the origin in a corner, and headings in radians. Trees are in
 * meters from the FIELD center, in red's frame. A source whose start pose is on the far half from red's wall is
 * rotated 180°, as a blue robot's tree would be. See docs/behavior-trees.md#coordinates-and-alliances.
 */

const IN = 0.0254, HALF_IN = 72;

interface PPose { kind: 'pose'; x: number; y: number; h: number }
type Heading = { kind: 'linear'; from: number; to: number } | { kind: 'constant'; h: number } | { kind: 'tangent'; reversed: boolean };
interface Segment { kind: 'segment'; pts: PPose[]; heading: Heading; /** Set by a path callback. */ intake?: boolean; shoot?: boolean }
interface Chain { kind: 'chain'; segments: Segment[] }
/** An object the importer doesn't model, such as the follower, or the `Math` class. */
interface Opaque { kind: 'opaque' | 'math' }
/** A lambda, kept as the mechanism events in its body, for path callbacks. */
interface Lambda { kind: 'lambda'; events: Mech[] }
/** A name that isn't declared yet. A field access on it can still find a declared path, as in `paths.score`. */
interface Name { kind: 'name'; name: string }
type Value = number | boolean | PPose | Segment | Chain | Opaque | Lambda | Name | undefined;

const OPAQUE: Opaque = { kind: 'opaque' }, MATH: Opaque = { kind: 'math' };
const isPose = (v: Value): v is PPose => typeof v === 'object' && v.kind === 'pose';
const isSeg = (v: Value): v is Segment => typeof v === 'object' && v.kind === 'segment';
const isChain = (v: Value): v is Chain => typeof v === 'object' && v.kind === 'chain';
const num = (v: Value, what: string): number => { if (typeof v === 'number') return v; if (isPose(v)) return v.h; throw new Error(`${what} isn't a number`); };
const pose = (v: Value, what: string): PPose => { if (isPose(v)) return v; throw new Error(`${what} isn't a pose`); };
const segment = (pts: Value[]): Segment => ({ kind: 'segment', pts: pts.map((p, i) => pose(p, `control point ${i + 1}`)), heading: { kind: 'tangent', reversed: false } });

// ---- A small evaluator for the Java expressions that declare poses and paths ----

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [], re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[dDfFlL]?|([A-Za-z_$][\w$]*)|(->|::|[-+*/%().,<>?:!=&|\[\]]))/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) }); else if (m[2]) out.push({ t: 'id', v: m[2] }); else if (m[3]) out.push({ t: 'op', v: m[3] });
  }
  if (re.lastIndex < src.trimEnd().length) throw new Error(`can't read "${src.slice(re.lastIndex, re.lastIndex + 20).trim()}"`);
  return out;
}

class Expr {
  private i = 0;
  constructor(private toks: Tok[], private env: Map<string, Value>) {}

  static eval(src: string, env: Map<string, Value>): Value {
    const e = new Expr(tokenize(src), env), v = e.sum();
    if (e.i < e.toks.length) throw new Error(`unexpected "${e.toks[e.i].v}"`);
    return v;
  }

  private peek(v: string) { const t = this.toks[this.i]; return !!t && t.t === 'op' && t.v === v; }
  private eat(v: string) { if (!this.peek(v)) throw new Error(`expected "${v}"`); this.i++; }
  private args(): Value[] {
    this.eat('('); const out: Value[] = [];
    while (!this.peek(')')) { out.push(this.sum()); if (!this.peek(')')) this.eat(','); }
    this.eat(')'); return out;
  }

  private sum(): Value {
    let v = this.product();
    while (this.peek('+') || this.peek('-')) { const op = this.toks[this.i++].v, r = this.product(); v = op === '+' ? num(v, 'a sum') + num(r, 'a sum') : num(v, 'a difference') - num(r, 'a difference'); }
    return v;
  }
  private product(): Value {
    let v = this.unary();
    while (this.peek('*') || this.peek('/')) { const op = this.toks[this.i++].v, r = this.unary(); v = op === '*' ? num(v, 'a product') * num(r, 'a product') : num(v, 'a quotient') / num(r, 'a quotient'); }
    return v;
  }
  private unary(): Value {
    if (this.peek('-')) { this.i++; return -num(this.unary(), 'a negation'); }
    if (this.peek('+')) { this.i++; return this.unary(); }
    // A cast such as (double) is skipped.
    const a = this.toks[this.i + 1], b = this.toks[this.i + 2];
    if (this.peek('(') && a?.t === 'id' && /^(double|float|int|long)$/.test(a.v) && b?.t === 'op' && b.v === ')') { this.i += 3; return this.unary(); }
    return this.postfix(this.primary());
  }

  private primary(): Value {
    const t = this.toks[this.i++];
    if (!t) throw new Error('the expression ends early');
    if (t.t === 'num') return t.v;
    if (t.t === 'op' && t.v === '(') {
      let depth = 1, j = this.i; while (j < this.toks.length && depth) { const u = this.toks[j++]; if (u.t === 'op') depth += u.v === '(' ? 1 : u.v === ')' ? -1 : 0; }
      if (this.toks[j]?.t === 'op' && this.toks[j].v === '->') { this.i = j; return this.skipLambda(); }
      const v = this.sum(); this.eat(')'); return v;
    }
    if (t.t !== 'id') throw new Error(`unexpected "${t.v}"`);
    if (t.v === 'new') {
      let type = (this.toks[this.i++] as { v: string }).v;
      while (this.peek('.')) { this.i++; type = (this.toks[this.i++] as { v: string }).v; }
      if (this.peek('<')) { while (!this.peek('>')) this.i++; this.i++; }
      return construct(type, this.args());
    }
    if (t.v === 'true' || t.v === 'false') return t.v === 'true';
    if (t.v === 'Math') return MATH;
    if (this.peek('(')) return call(null, t.v, this.args());
    return this.env.get(t.v) ?? { kind: 'name', name: t.v };
  }

  /** Skips a lambda from its arrow to the end of the argument that holds it, and keeps the mechanism calls in it. */
  private skipLambda(): Value {
    const from = this.i;
    for (let depth = 0; this.i < this.toks.length; this.i++) {
      const u = this.toks[this.i]; if (u.t !== 'op') continue;
      if (u.v === '(') depth++; else if (u.v === ')' && --depth < 0) break; else if (u.v === ',' && depth === 0) break;
    }
    const body = this.toks.slice(from + 1, this.i).map(u => u.v).join(' ');
    const calls = scan(body, new Map(), new Map()).flatMap(e => (e.kind === 'intakeOn' || e.kind === 'intakeOff' || e.kind === 'shoot' ? [e.kind] : []));
    return { kind: 'lambda', events: [...[...body.matchAll(/__mech_(\w+)/g)].map(m => m[1] as Mech), ...calls] };
  }

  private postfix(v: Value): Value {
    for (;;) {
      if (this.peek('->')) return this.skipLambda();
      if (!this.peek('.')) return resolve(v, this.env);
      this.i++; const name = (this.toks[this.i++] as { v: string }).v;
      if (this.peek('(')) { v = call(resolve(v, this.env), name, this.args()); continue; }
      // A field access: Math.PI, a constant on a class, or a path on a holder object such as `paths.score`.
      if (v === MATH) v = name === 'PI' ? Math.PI : name === 'E' ? Math.E : undefined;
      else if (isPose(v) && (name === 'x' || name === 'y')) v = v[name];
      else if (isPose(v) && name === 'heading') v = v.h;
      else v = this.env.get(name) ?? { kind: 'name', name };
    }
  }
}

const resolve = (v: Value, env: Map<string, Value>): Value => (typeof v === 'object' && v.kind === 'name' ? env.get(v.name) ?? OPAQUE : v);

function construct(type: string, a: Value[]): Value {
  if (type === 'Pose' || type === 'Pose2D' || type === 'Point') {
    if (isPose(a[0])) return a[0];
    // A 1.x `Point` takes x, y, and a coordinate system; a Pose takes x, y, and a heading.
    return { kind: 'pose', x: num(a[0], 'x'), y: num(a[1], 'y'), h: type === 'Point' || a.length < 3 ? 0 : num(a[2], 'the heading') };
  }
  if (type === 'BezierLine' || type === 'BezierCurve' || type === 'BezierPoint') return segment(a);
  if (type === 'Path') { if (isSeg(a[0])) return { ...a[0] }; throw new Error('a Path needs a Bézier curve'); }
  if (type === 'PathChain') return { kind: 'chain', segments: a.filter(isSeg) };
  if (type === 'PathBuilder') return { kind: 'chain', segments: [] };
  return OPAQUE;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function call(on: Value | null, name: string, a: Value[]): Value {
  if (on === MATH) {
    const f: Record<string, (...x: number[]) => number> = { toRadians: d => (d * Math.PI) / 180, toDegrees: r => (r * 180) / Math.PI, sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, atan2: Math.atan2, hypot: Math.hypot, min: Math.min, max: Math.max };
    if (!f[name]) throw new Error(`Math.${name} isn't supported`);
    return f[name](...a.map((v, i) => num(v, `argument ${i + 1} of Math.${name}`)));
  }
  // Static helpers of the 2.x API, called bare after a static import or on `Paths`.
  if (on === null || on === OPAQUE) {
    if (name === 'line' || name === 'curve') return segment(a);
    if (name === 'chain') return { kind: 'chain', segments: a.flatMap(v => (isSeg(v) ? [v] : isChain(v) ? v.segments : [])) };
    if (name === 'pathBuilder') return { kind: 'chain', segments: [] };
    if (name === 'zero' || name === 'origin') return { kind: 'pose', x: 0, y: 0, h: 0 };
    if (name === 'toRadians' || name === 'toDegrees') return call(MATH, name, a);
    return OPAQUE;
  }
  if (isPose(on)) {
    if (name === 'getX' || name === 'x') return on.x;
    if (name === 'getY' || name === 'y') return on.y;
    if (name === 'getHeading' || name === 'heading') return on.h;
    if (name === 'withHeading' || name === 'setHeading') return { ...on, h: num(a[0], 'the heading') };
    if (name === 'mirror') return { kind: 'pose', x: 144 - on.x, y: on.y, h: wrap(Math.PI - on.h) };
    return on;
  }
  if (isSeg(on) || isChain(on)) {
    // A chain's heading calls set the path that was added last, as a PathBuilder does; the `Global` ones set them all.
    const targets = isSeg(on) ? [on] : name.includes('Global') ? on.segments : on.segments.slice(-1);
    const set = (h: Heading) => { for (const s of targets) s.heading = h; return on; };
    switch (name) {
      case 'addPath': case 'addPaths': if (isChain(on)) for (const v of a) on.segments.push(...(isSeg(v) ? [{ ...v }] : isChain(v) ? v.segments : [])); return on;
      case 'linear': case 'setLinearHeadingInterpolation': case 'setGlobalLinearHeadingInterpolation': return set({ kind: 'linear', from: num(a[0], 'the start heading'), to: num(a[1], 'the end heading') });
      case 'constant': case 'setConstantHeadingInterpolation': case 'setGlobalConstantHeadingInterpolation': return set({ kind: 'constant', h: num(a[0], 'the heading') });
      case 'tangent': case 'setTangentHeadingInterpolation': case 'setGlobalTangentHeadingInterpolation': return set({ kind: 'tangent', reversed: false });
      case 'reversed': return set({ kind: 'tangent', reversed: true });
      case 'addParametricCallback': case 'addTemporalCallback': case 'addPoseCallback': case 'addCallback': {
        const events = a.flatMap(v => (typeof v === 'object' && v.kind === 'lambda' ? v.events : []));
        for (const s of targets) { if (events.includes('intakeOn')) s.intake = true; if (events.includes('shoot')) s.shoot = true; }
        return on;
      }
      case 'setReversed': return a[0] === false ? on : set({ kind: 'tangent', reversed: true });
      default: return on; // build(), callbacks, braking, and timeouts don't change the geometry.
    }
  }
  return OPAQUE;
}

// ---- Reading the source ----

/** Removes comments and string literals. */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/"(?:\\.|[^"\\])*"/g, '""');

/** The index of the bracket that closes the one at `open`. */
function closing(src: string, open: number): number {
  const o = src[open], c = o === '{' ? '}' : ')';
  for (let i = open, depth = 0; i < src.length; i++) { if (src[i] === o) depth++; else if (src[i] === c && --depth === 0) return i; }
  return src.length;
}

/**
 * Replaces each lambda body in braces with one expression, so that the statement splitter doesn't cut it: the
 * mechanism events in the body, as `__mech_` names, or `null`.
 */
function foldLambdas(src: string): string {
  for (let at = src.search(/->\s*\{/); at >= 0; at = src.search(/->\s*\{/)) {
    const open = src.indexOf('{', at), end = closing(src, open);
    const events = scan(src.slice(open + 1, end), new Map(), new Map()).map(e => e.kind).filter(k => k !== 'path' && k !== 'boundary' && k !== 'wait');
    src = `${src.slice(0, at)}-> ${events.length ? `(${events.map(k => `__mech_${k}`).join(' + ')})` : 'null'}${src.slice(end + 1)}`;
  }
  return src;
}

// ---- Mechanism calls ----

type Mech = 'intakeOn' | 'intakeOff' | 'shoot';
type Event = { kind: Mech | 'boundary' } | { kind: 'path'; name: string } | { kind: 'wait'; sec: number };

const INTAKE = /intake|collect|roller|sweep|brush/, SHOT = /^(shoot|launch|fire|kick|flick|feed|score|release)/, FEEDER = /feed|kick|flick|push|index|transfer|gate/;
/** Methods that read a mechanism or wait for the follower: a check, not an action. */
const QUERY = /^(get|is|has|read|at|following)/;

/**
 * Names a mechanism call by its receiver and method: `intake.setPower(1)`, `robot.startIntake()`, `stopIntake()`,
 * `shooter.fire()`, `launch()`, or `feeder.setPosition(FEED)`. A flywheel's spin-up isn't a launch, so `shooter.setVelocity`
 * is not one. Returns null for any other call.
 */
function mechanism(recv: string, method: string, arg: Value): Mech | null {
  const r = recv.toLowerCase(), m = method.toLowerCase(), s = `${r}.${m}`;
  if (QUERY.test(m)) return null;
  const power = typeof arg === 'number' ? arg : NaN;
  if (INTAKE.test(s)) {
    if (/stop|off|idle|disable|reverse|outtake|eject|rest|hold/.test(m)) return 'intakeOff';
    if (/position/.test(m)) return null;
    return power <= 0 ? 'intakeOff' : 'intakeOn';
  }
  if (SHOT.test(m)) return 'shoot';
  if (FEEDER.test(r) && /power|position|run|on|start|push|go/.test(m) && !(power <= 0)) return 'shoot';
  return null;
}

/** A timer that a condition compares, as `pathTimer.getElapsedTimeSeconds() > 1.5`, in seconds per unit it reads. */
const TIMER: Record<string, number> = { getelapsedtimeseconds: 1, seconds: 1, time: 1, getelapsedtime: 1e-3, milliseconds: 1e-3 };
/** Calls that wait: `sleep(ms)`, an FTCLib `WaitCommand(ms)`, and a NextFTC `Delay(s)`. */
const SLEEP: Record<string, number> = { sleep: 1e-3, waitcommand: 1e-3, sleepcommand: 1e-3, delay: 1, waitseconds: 1 };

/** A call, as `a.b(`, or a method reference, as `a::b`. */
const CALL = /\b(new\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:\(|::\s*([A-Za-z_$][\w$]*))/g;
const DECL = /\b(?:void|boolean|int|double|float|long|[A-Z][\w$<>,\[\] ]*)\s+([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?:throws\s+[\w$., ]+)?\{/g;

/** The methods that the class declares, by name, with their bodies. */
function methods(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(DECL)) { const open = m.index! + m[0].length - 1; out.set(m[1], src.slice(open + 1, closing(src, open))); }
  return out;
}

/**
 * Lists the paths followed, the mechanism calls, and the waits in `src`, in source order. A call to one of the class's
 * own methods is read in place of the call. A `case` label or a check on the follower is a boundary: the path before it
 * has ended.
 */
function scan(src: string, env: Map<string, Value>, own: Map<string, string>, depth = 0): Event[] {
  const out: Event[] = [], val = (a: string): Value => { try { return Expr.eval(a, env); } catch { return undefined; } };
  const isPath = (n: string) => { const v = env.get(n.split('.').pop()!); return isSeg(v) || isChain(v); };
  const marks = [...src.matchAll(/\bcase\b|\bdefault\s*:/g)].map(m => m.index!);
  let mark = 0;
  for (const m of src.matchAll(CALL)) {
    const at = m.index!;
    while (mark < marks.length && marks[mark] < at) { out.push({ kind: 'boundary' }); mark++; }
    if (m[3]) { const mech = mechanism(m[2].replace(/\s+/g, ''), m[3], undefined); if (mech) out.push({ kind: mech }); continue; }
    const chain = m[2].replace(/\s+/g, ''), parts = chain.split('.'), method = parts.pop()!, recv = parts.join('.');
    const open = at + m[0].length - 1, args = src.slice(open + 1, closing(src, open)).split(','), lower = method.toLowerCase();
    if (/^(if|while|for|switch|catch|synchronized|return)$/.test(method)) continue;
    // A declaration, as `void runIntake() {`, isn't a call.
    const before = src.slice(Math.max(0, at - 40), at);
    if (!m[1] && /[\w$>\]]\s+$/.test(before) && !/(\b(new|return|else)|->)\s+$/.test(before)) continue;
    if (method === 'follow' || method === 'followPath' || (m[1] && /^Follow(Path)?(Command)?$/.test(method))) {
      const name = args.map(a => a.trim()).find(isPath); if (name) out.push({ kind: 'path', name: name.split('.').pop()! }); continue;
    }
    if (/^(isBusy|following|atParametricEnd|isRobotStuck)$/.test(method)) { out.push({ kind: 'boundary' }); continue; }
    if (SLEEP[lower] !== undefined) { const v = val(args[0]); if (typeof v === 'number') out.push({ kind: 'wait', sec: v * SLEEP[lower] }); continue; }
    if (TIMER[lower] !== undefined) {
      // A timer is a wait when the condition compares it alone, not as a timeout beside the follower's check.
      const cond = /^\s*\)\s*>=?\s*([^)&|;?]+)/.exec(src.slice(closing(src, open)));
      const condition = src.slice(src.lastIndexOf('if', at), at);
      if (cond && !/\|\||isBusy/.test(condition)) { const v = val(cond[1]); if (typeof v === 'number' && v > 0) out.push({ kind: 'wait', sec: v * TIMER[lower] }); }
      continue;
    }
    if (!recv && own.has(method) && depth < 4) {
      const inner = scan(own.get(method)!, env, own, depth + 1);
      if (inner.some(e => e.kind !== 'boundary')) { out.push(...inner); continue; }
    }
    const mech = mechanism(recv, method, val(args[0]));
    if (mech) out.push({ kind: mech });
  }
  return out;
}

/** The Bézier point at `t`, by de Casteljau. */
function bezier(pts: PPose[], t: number): { x: number; y: number } {
  let p = pts.map(q => ({ x: q.x, y: q.y }));
  while (p.length > 1) p = p.slice(1).map((q, i) => ({ x: p[i].x + (q.x - p[i].x) * t, y: p[i].y + (q.y - p[i].y) * t }));
  return p[0];
}

/** Splits a declaration of several variables, as `Pose a = new Pose(1, 2, 0), b = ...`, into one per variable. */
function declarators(s: string): string[] {
  const out: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i <= s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++; else if (ch === ')') depth--;
    else if ((ch === ',' && depth === 0) || i === s.length) {
      const part = s.slice(from, i).trim();
      if (out.length && !/^[A-Za-z_$][\w$]*\s*=(?!=)/.test(part)) out[out.length - 1] += `, ${part}`; else out.push(part);
      from = i + 1;
    }
  }
  return out;
}

export interface PedroWaypoint { x: number; y: number; headingDeg: number | null }
export interface PedroImport {
  /** The tree file, ready for `addAutoTree`. */ tree: Record<string, unknown>;
  /** Things the importer skipped or guessed, for the person importing. */ warnings: string[];
}

/**
 * Converts a Pedro Pathing OpMode to an AUTO tree. Throws when the source has no path that it can read.
 * @param fileName The source file's name. The class name in the source names the tree; the file name is the fallback.
 */
export function importPedro(java: string, fileName = 'Auto.java'): PedroImport {
  const stripped = strip(java), src = foldLambdas(stripped), env = new Map<string, Value>(), warnings: string[] = [];
  const statements = src.split(/[;{}]/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).flatMap(declarators);
  // Two passes, so a declaration can use a field that the file declares further down.
  for (let pass = 0; pass < 2; pass++) {
    for (const s of statements) {
      const m = /^(?:@\w+(?:\([^)]*\))?\s+)*(?:[\w$<>,\[\]. ]+\s)?([A-Za-z_$][\w$]*)\s*=(?!=)\s*(.+)$/.exec(s);
      if (!m || /^(if|for|while|return|case)\b/.test(s)) continue;
      try { const v = Expr.eval(m[2], env); if (isPose(v) || isSeg(v) || isChain(v) || typeof v === 'number') env.set(m[1], typeof v === 'object' ? structuredClone(v) : v); }
      catch (e) { if (pass === 1 && /\b(Pose|Bezier|line|curve|pathBuilder|Path)\b/.test(m[2])) warnings.push(`Skipped ${m[1]}: ${(e as Error).message}.`); }
    }
    // Statements that aren't assignments: a heading call on a path that was built before, such as `park.setLinearHeadingInterpolation(a, b)`.
    for (const s of statements) {
      const m = /^([A-Za-z_$][\w$]*)\.(set\w*HeadingInterpolation|setReversed|add\w*Callback)\((.*)\)$/.exec(s);
      if (m && pass === 1 && (isSeg(env.get(m[1])) || isChain(env.get(m[1])))) try { Expr.eval(s, env); } catch { /* reported above */ }
    }
  }
  // The OpMode's own methods that follow no path, such as `runIntake()`, are read where they are called. Path callbacks
  // were read with their paths.
  let body = stripped;
  for (const m of body.matchAll(/\.add\w*Callback\s*\(/g)) { const open = m.index! + m[0].length - 1, end = closing(body, open); body = body.slice(0, open + 1) + ' '.repeat(end - open - 1) + body.slice(end); }
  const helpers = new Map([...methods(body)].filter(([, b]) => !/\.follow(Path)?\s*\(|\bFollow(Path)?(Command)?\s*\(/.test(b)));
  for (const b of helpers.values()) body = body.replace(b, ' '.repeat(b.length));
  const events = scan(body, env, helpers), order: string[] = [];
  for (const e of events) if (e.kind === 'path' && !order.includes(e.name)) order.push(e.name);
  const paths = (order.length ? order : [...env.keys()]).filter(k => isSeg(env.get(k)) || isChain(env.get(k)));
  if (!paths.length) throw new Error('found no Pedro path: expected line(...), curve(...), new BezierLine(...), or pathBuilder()...build()');
  if (!order.length) warnings.push('The source never calls follow() or followPath(), so the paths run in the order they are declared.');

  const startName = /\.(?:setStartingPose|setPose)\(\s*([\w$.]+)\s*\)/.exec(src)?.[1]?.split('.').pop();
  const firstSeg = (k: string) => { const v = env.get(k)!; return isSeg(v) ? v : (v as Chain).segments[0]; };
  const start = (startName && isPose(env.get(startName)) ? env.get(startName) as PPose : firstSeg(paths[0])?.pts[0]);
  if (!start) throw new Error('the first path has no points');
  // Trees are written for red. A start on the far half from red's wall means the source's origin is the other corner.
  const rotate = start.x > HALF_IN;
  if (rotate) warnings.push('The start pose is on the half away from the red wall, so the paths are rotated 180° into red\'s frame.');
  const toField = (x: number, y: number) => { const fx = (x - HALF_IN) * IN, fy = (y - HALF_IN) * IN; return rotate ? { x: -fx, y: -fy } : { x: fx, y: fy }; };
  const toDeg = (h: number) => { const d = ((h + (rotate ? Math.PI : 0)) * 180) / Math.PI; return Math.round((((d % 360) + 540) % 360 - 180) * 10) / 10; };
  const r3 = (v: number) => Math.round(v * 1000) / 1000;

  const waypoints = (seg: Segment): PedroWaypoint[] => {
    const curved = seg.pts.length > 2, n = curved ? 6 : 1, out: PedroWaypoint[] = [];
    for (let k = 1; k <= n; k++) {
      const t = k / n, p = bezier(seg.pts, t), q = toField(p.x, p.y), h = seg.heading;
      let heading: number | null = null;
      if (h.kind === 'linear') heading = toDeg(h.from + wrap(h.to - h.from) * t);
      else if (h.kind === 'constant') heading = toDeg(h.h);
      else if (h.reversed) { const b = bezier(seg.pts, Math.max(0, t - 0.01)); heading = toDeg(Math.atan2(p.y - b.y, p.x - b.x) + Math.PI); }
      out.push({ x: r3(q.x), y: r3(q.y), headingDeg: heading });
    }
    return out;
  };

  const className = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(src)?.[1] ?? fileName.replace(/\.java$/i, '');
  const opName = /@Autonomous\s*\(\s*name\s*=\s*"([^"]*)"/.exec(java)?.[1];
  const s0 = toField(start.x, start.y);
  const children: Record<string, unknown>[] = [{
    id: 's1', note: 'The OpMode\'s start pose. The planner drives there from wherever the robot starts in the simulator.',
    ref: 'drive.driveTo', params: { pose: 'start', timeoutSec: 5 },
  }];
  const segsOf = (name: string) => { const v = env.get(name)!; return isSeg(v) ? [v] : (v as Chain).segments; };
  type Step = { kind: 'path'; name: string; intake: boolean } | { kind: 'shoot' } | { kind: 'wait'; sec: number; intake: boolean };
  const steps: Step[] = [], seen = new Set<string>();
  let intake = false, driving = false, intakeCalls = 0, shots = 0;
  for (const e of order.length ? events : paths.map(name => ({ kind: 'path' as const, name }))) {
    const last = steps[steps.length - 1];
    if (e.kind === 'boundary') driving = false;
    else if (e.kind === 'path') {
      if (seen.has(e.name) || !paths.includes(e.name)) continue;
      seen.add(e.name); driving = true;
      steps.push({ kind: 'path', name: e.name, intake: intake || segsOf(e.name).some(g => g.intake) });
      if (segsOf(e.name).some(g => g.shoot)) { steps.push({ kind: 'shoot' }); shots++; }
    } else if (e.kind === 'intakeOn' || e.kind === 'intakeOff') {
      intake = e.kind === 'intakeOn'; intakeCalls++;
      // An intake started right after a follow runs while that path is driven.
      if (intake && driving && last?.kind === 'path') last.intake = true;
    } else if (e.kind === 'shoot') { shots++; if (last?.kind !== 'shoot') steps.push({ kind: 'shoot' }); }
    // A short wait after a launch waits for the launch, which shooter.shoot already does.
    else if (e.kind === 'wait' && !(last?.kind === 'shoot' && e.sec <= 1.5)) {
      if (last?.kind === 'wait' && last.intake === intake) last.sec += e.sec; else steps.push({ kind: 'wait', sec: e.sec, intake });
    }
  }
  const withIntake = (id: string, step: Record<string, unknown>, on: boolean) =>
    (on ? { id, parallel: { policy: 'any', children: [{ ...step, id: `${id}-drive` }, { ref: 'intake.run', params: { filter: 'all' } }] } } : { ...step, id });
  for (const st of steps) {
    const id = `s${children.length + 1}`;
    if (st.kind === 'path') {
      const wps = segsOf(st.name).flatMap(waypoints);
      if (!wps.length) continue;
      let len = Math.hypot(wps[0].x - s0.x, wps[0].y - s0.y); for (let k = 1; k < wps.length; k++) len += Math.hypot(wps[k].x - wps[k - 1].x, wps[k].y - wps[k - 1].y);
      children.push(withIntake(id, { note: `Pedro path ${st.name}.`, ref: 'drive.followPath', params: { waypoints: wps, timeoutSec: Math.ceil(len / 0.8 + 2), tag: `pedro-${st.name}` } }, st.intake));
    } else if (st.kind === 'shoot') {
      // Named as the step settings name a launch after a drive, so the editor shows it as that drive's Shoot box.
      const prev = children[children.length - 1], after = prev.ref === 'drive.followPath' || 'parallel' in prev;
      children.push({ id: after ? `${prev.id}-shoot` : id, ref: 'shooter.shoot', params: { count: 4, timeoutSec: 4 } });
    } else children.push(withIntake(id, { ref: 'wait', params: { timeoutSec: Math.round(st.sec * 100) / 100 } }, st.intake));
  }
  if (intakeCalls || shots) warnings.push(`Read ${intakeCalls} intake call${intakeCalls === 1 ? '' : 's'} and ${shots} launch${shots === 1 ? '' : 'es'} by their names. Check them in the AUTO editor.`);
  const id = `pedro-${className.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`;
  return {
    warnings,
    tree: {
      kind: 'bt.tree', id, name: `Pedro: ${opName || className}`, env: 'onboard',
      description: `Imported from ${fileName}: ${paths.length} path${paths.length === 1 ? '' : 's'}${intakeCalls || shots ? ', with its intake and launches' : ', driven only. Add intake and shooter steps in the AUTO editor'}.`,
      meta: { start: 'any' },
      defs: { start: `pose(${r3(s0.x)}, ${r3(s0.y)}, ${toDeg(start.h)})` },
      root: { sequence: { children } },
    },
  };
}
