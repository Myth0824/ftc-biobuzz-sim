/**
 * Reads a Pedro Pathing OpMode's Java source and writes an AUTO tree that drives the same paths. It understands both
 * Pedro APIs: the 1.x builder (`new BezierLine`, `pathBuilder().addPath(...).setLinearHeadingInterpolation(...)`) and the
 * 2.x/3.x one (`line(a, b).linear(a, b)`, `curve(...)`, `.constant(h)`, `.tangent()`). It doesn't run the OpMode: a Java
 * parser (java-parser, the one behind prettier-plugin-java) gives the file's structure, a small evaluator works out the
 * numbers, poses, and paths that the file declares, and the paths run in the order that the source follows them. It
 * also reads the mechanism calls between and inside the paths, by their names: an intake that runs while a path is
 * followed wraps that path with `intake.run`, a launch becomes `shooter.shoot`, and a sleep or a timer becomes `wait`.
 * See `mechanism` for the names it knows.
 *
 * Pedro poses are in inches on a 144 in. FIELD with the origin in a corner, and headings in radians. Trees are in
 * meters from the FIELD center, in red's frame. A source whose start pose is on the far half from red's wall is
 * rotated 180°, as a blue robot's tree would be. See docs/behavior-trees.md#coordinates-and-alliances.
 */
import type { CstNode, IToken } from 'java-parser';

type CstEl = CstNode | IToken;

const IN = 0.0254, HALF_IN = 72;

interface PPose { kind: 'pose'; x: number; y: number; h: number }
type Heading = { kind: 'linear'; from: number; to: number } | { kind: 'constant'; h: number } | { kind: 'tangent'; reversed: boolean };
interface Segment { kind: 'segment'; pts: PPose[]; heading: Heading; /** Set by a path callback. */ intake?: boolean; shoot?: boolean }
interface Chain { kind: 'chain'; segments: Segment[] }
/** An object the importer doesn't model, such as the follower, or the `Math` class. */
interface Opaque { kind: 'opaque' | 'math' }
/** A lambda or a method reference, kept as the mechanism events that it runs, for path callbacks. */
interface Lambda { kind: 'lambda'; events: Mech[] }
/** A name that isn't declared yet. A field access on it can still find a declared path, as in `paths.score`. */
interface Name { kind: 'name'; name: string }
interface Namespace { kind: 'namespace'; name: string }
interface PureFunction { kind: 'function'; invoke: (on: Value | null, args: Value[]) => Value }
type Value = number | boolean | PPose | Segment | Chain | Opaque | Lambda | Name | Namespace | PureFunction | undefined;

const OPAQUE: Opaque = { kind: 'opaque' }, MATH: Opaque = { kind: 'math' };
const isPose = (v: Value): v is PPose => typeof v === 'object' && v.kind === 'pose';
const isSeg = (v: Value): v is Segment => typeof v === 'object' && v.kind === 'segment';
const isChain = (v: Value): v is Chain => typeof v === 'object' && v.kind === 'chain';
const isPath = (v: Value) => isSeg(v) || isChain(v);
const num = (v: Value, what: string): number => { if (typeof v === 'number') return v; if (isPose(v)) return v.h; throw new Error(`${what} isn't a number`); };
const pose = (v: Value, what: string): PPose => { if (isPose(v)) return v; throw new Error(`${what} isn't a pose`); };
const segment = (pts: Value[]): Segment => ({ kind: 'segment', pts: pts.map((p, i) => pose(p, `control point ${i + 1}`)), heading: { kind: 'tangent', reversed: false } });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// ---- A small evaluator for the expressions that declare poses and paths ----

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [], re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[dDfFlL]?|([A-Za-z_$][\w$]*)|([-+*/%().,<>?:!=&|\[\]]))/y;
  let m: RegExpExecArray | null;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) }); else if (m[2]) out.push({ t: 'id', v: m[2] }); else if (m[3]) out.push({ t: 'op', v: m[3] });
  }
  if (re.lastIndex < src.trimEnd().length) throw new Error(`can't read "${src.slice(re.lastIndex, re.lastIndex + 20).trim()}"`);
  return out;
}

/** Evaluates one expression. The parser has replaced each lambda and method reference in it with a name in `env`. */
class Expr {
  private i = 0;
  constructor(private toks: Tok[], private env: Map<string, Value>) {}

  static eval(src: string, env: Map<string, Value>): Value {
    const e = new Expr(tokenize(src), env), v = e.comparison();
    if (e.i < e.toks.length) throw new Error(`unexpected "${e.toks[e.i].v}"`);
    return v;
  }

  private peek(v: string) { const t = this.toks[this.i]; return !!t && t.t === 'op' && t.v === v; }
  private eat(v: string) { if (!this.peek(v)) throw new Error(`expected "${v}"`); this.i++; }
  private args(): Value[] {
    this.eat('('); const out: Value[] = [];
    while (!this.peek(')')) { out.push(this.comparison()); if (!this.peek(')')) this.eat(','); }
    this.eat(')'); return out;
  }

  private comparison(): Value {
    const v = this.sum();
    if (this.peek('=') || this.peek('!')) {
      const op = this.toks[this.i++].v; this.eat('='); const r = this.sum();
      const equal = typeof v === 'object' && v.kind === 'namespace' && typeof r === 'object' && r.kind === 'namespace' ? v.name === r.name : v === r;
      return op === '=' ? equal : !equal;
    }
    return v;
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
    if (t.t === 'op' && t.v === '(') { const v = this.comparison(); this.eat(')'); return v; }
    if (t.t !== 'id') throw new Error(`unexpected "${t.v}"`);
    if (t.v === 'new') {
      let type = (this.toks[this.i++] as { v: string }).v;
      while (this.peek('.')) { this.i++; type = (this.toks[this.i++] as { v: string }).v; }
      if (this.peek('<')) { while (!this.peek('>')) this.i++; this.i++; }
      return construct(type, this.args());
    }
    if (t.v === 'true' || t.v === 'false') return t.v === 'true';
    if (t.v === 'Math') return MATH;
    if (this.peek('(')) return call(null, t.v, this.args(), this.env);
    return this.env.get(t.v) ?? { kind: 'name', name: t.v };
  }

  private postfix(v: Value): Value {
    for (;;) {
      if (!this.peek('.')) return resolve(v, this.env);
      this.i++; const name = (this.toks[this.i++] as { v: string }).v;
      if (this.peek('(')) { v = call(resolve(v, this.env), name, this.args(), this.env); continue; }
      // A field access: Math.PI, a constant on a class, or a path on a holder object such as `paths.score`.
      if (v === MATH) v = name === 'PI' ? Math.PI : name === 'E' ? Math.E : undefined;
      else if (isPose(v) && (name === 'x' || name === 'y')) v = v[name];
      else if (isPose(v) && name === 'heading') v = v.h;
      else if (typeof v === 'object' && (v.kind === 'name' || v.kind === 'namespace')) {
        const qualified = `${v.name}.${name}`;
        v = this.env.get(qualified) ?? this.env.get(name) ?? { kind: 'name', name: qualified };
      } else v = this.env.get(name) ?? { kind: 'name', name };
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

function call(on: Value | null, name: string, a: Value[], env?: Map<string, Value>): Value {
  const namespace = typeof on === 'object' && on?.kind === 'namespace' ? on.name : '';
  const fn = env?.get(`__call_${namespace}.${name}`) ?? env?.get(`__call_${namespace.split('.').slice(0, -1).join('.')}.${name}`) ??
    (on === null || on === OPAQUE ? env?.get(`__call_${name}`) : undefined);
  if (typeof fn === 'object' && fn.kind === 'function') return fn.invoke(on, a);
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
      case 'setReversed': return a[0] === false ? on : set({ kind: 'tangent', reversed: true });
      case 'addParametricCallback': case 'addTemporalCallback': case 'addPoseCallback': case 'addCallback': {
        const events = a.flatMap(v => (typeof v === 'object' && v.kind === 'lambda' ? v.events : []));
        for (const s of targets) { if (events.includes('intakeOn')) s.intake = true; if (events.includes('shoot')) s.shoot = true; }
        return on;
      }
      default: return on; // build(), braking, and timeouts don't change the geometry.
    }
  }
  return OPAQUE;
}

/** The Bézier point at `t`, by de Casteljau. */
function bezier(pts: PPose[], t: number): { x: number; y: number } {
  let p = pts.map(q => ({ x: q.x, y: q.y }));
  while (p.length > 1) p = p.slice(1).map((q, i) => ({ x: p[i].x + (q.x - p[i].x) * t, y: p[i].y + (q.y - p[i].y) * t }));
  return p[0];
}

// ---- Mechanism calls ----

type Mech = 'intakeOn' | 'intakeOff' | 'shoot';
type Event = { kind: Mech | 'boundary' } | { kind: 'path'; name: string } | { kind: 'wait'; sec: number };

const INTAKE = /intake|collect|roller|sweep|brush/, SHOT = /^(shoot|launch|fire|kick|flick|feed|score|release)/, FEEDER = /feed|kick|flick|push|index|transfer|gate/;
/** Methods that read a mechanism or the follower: a check, not an action. */
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
/** Calls and commands that wait: `sleep(ms)`, an FTCLib `WaitCommand(ms)`, and a NextFTC `Delay(s)`. */
const SLEEP: Record<string, number> = { sleep: 1e-3, waitcommand: 1e-3, sleepcommand: 1e-3, delay: 1, waitseconds: 1 };
const FOLLOW_CMD = /^Follow(Path)?(Command)?$/, FOLLOWER_CHECK = /^(isBusy|following|atParametricEnd|isRobotStuck)$/;

// ---- Reading the parse tree ----

const isTok = (x: CstEl): x is IToken => 'image' in x;
const at = (x: CstEl) => (isTok(x) ? x.startOffset : x.location.startOffset);
const endOf = (x: CstEl) => (isTok(x) ? x.endOffset : x.location.endOffset);
/** A node's children, tokens too, in source order. The parser groups them by kind. */
const kids = (n: CstNode): CstEl[] => Object.values(n.children).flat().sort((a, b) => at(a) - at(b));
const child = (n: CstNode, name: string) => n.children[name]?.[0] as CstNode | undefined;
/** Every node named `name` under `n`, in source order, `n` included. */
function nodes(n: CstNode, name: string, out: CstNode[] = []): CstNode[] {
  if (n.name === name) out.push(n);
  for (const c of kids(n)) if (!isTok(c)) nodes(c, name, out);
  return out;
}
/** The tokens under `n`, in source order. */
const tokens = (n: CstEl): IToken[] => (isTok(n) ? [n] : kids(n).flatMap(tokens));

/** Blanks out comments, keeping every offset, so that a slice of the source is an expression the evaluator can read. */
function blankComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i], two = src.slice(i, i + 2);
    if (two === '//' || two === '/*') { const end = two === '//' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2) + 2; const j = end < (two === '//' ? 0 : 2) ? src.length : end; out += src.slice(i, j).replace(/[^\n]/g, ' '); i = j; continue; }
    if (c === '"' || c === '\'') { let j = i + 1; while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1; out += src.slice(i, j + 1); i = j + 1; continue; }
    out += c; i++;
  }
  return out;
}

/** One method call: `recv.method(args)`. `recv` is the dotted text before the method, with call arguments left out. */
interface Call { recv: string; method: string; args: CstNode[]; node: CstNode }
/** One `new Type(args)`. */
interface New { type: string; args: CstNode[] }

class Source {
  readonly env: Map<string, Value>;
  /** The OpMode's own methods, by name, and those of them that follow no path. */
  readonly methods = new Map<string, CstNode>(); readonly helpers = new Set<string>();
  private lambdaNames = new Map<CstNode, string>();

  constructor(readonly text: string, readonly root: CstNode, env = new Map<string, Value>()) {
    this.env = env;
    for (const m of nodes(root, 'methodDeclaration')) {
      const name = tokens(child(child(m, 'methodHeader')!, 'methodDeclarator')!).find(t => t.tokenType.name === 'Identifier')?.image, body = child(m, 'methodBody');
      if (!name || !body) continue;
      this.methods.set(name, body);
      if (!this.follows(body)) this.helpers.add(name);
    }
  }

  slice(n: CstEl) { return this.text.slice(at(n), endOf(n) + 1); }
  argsOf(n: CstNode | undefined): CstNode[] { const list = n && child(n, 'argumentList'); return list ? (list.children.expression as CstNode[]).slice().sort((a, b) => at(a) - at(b)) : []; }

  /** True when `n` follows a path anywhere inside it. */
  follows(n: CstNode): boolean { return this.calls(n).some(c => c.method === 'follow' || c.method === 'followPath') || this.news(n).some(c => FOLLOW_CMD.test(c.type)); }

  /** The method calls in `n`, in source order. A call on a call's result, as `a.b().c()`, has the receiver `a.b.c`'s first part. */
  calls(n: CstNode): Call[] { return nodes(n, 'primary').flatMap(p => this.callsOf(p)); }
  private callsOf(p: CstNode): Call[] {
    const prefix = child(p, 'primaryPrefix')!, out: Call[] = [];
    let chain = this.prefixName(prefix);
    for (const s of (p.children.primarySuffix ?? []) as CstNode[]) {
      const inv = child(s, 'methodInvocationSuffix'), dot = s.children.Identifier?.[0] as IToken | undefined;
      if (inv) { const parts = chain.split('.'), method = parts.pop()!; out.push({ recv: parts.join('.'), method, args: this.argsOf(inv), node: s }); }
      else if (dot) chain += `.${dot.image}`;
    }
    return out;
  }
  /** The dotted name that a primary starts with, as `robot.intake.setPower`, or '' for anything else. */
  private prefixName(prefix: CstNode): string {
    const ref = child(prefix, 'fqnOrRefType'); if (ref) return tokens(ref).filter(t => t.tokenType.name !== 'Dot' && t.tokenType.name !== 'At').map(t => t.image).join('.');
    return prefix.children.This ? 'this' : '';
  }
  /** The `new` expressions in `n`, in source order. */
  news(n: CstNode): New[] {
    return nodes(n, 'unqualifiedClassInstanceCreationExpression').map(u => ({ type: tokens(child(u, 'classOrInterfaceTypeToInstantiate')!).filter(t => t.tokenType.name === 'Identifier').pop()?.image ?? '', args: this.argsOf(u) }));
  }

  /** An expression's text for the evaluator, with each lambda and method reference in it replaced by a name in `env`. */
  expr(n: CstNode): string {
    const cut: CstNode[] = [];
    for (const l of nodes(n, 'lambdaExpression')) if (!cut.some(c => at(c) <= at(l) && endOf(l) <= endOf(c))) cut.push(l);
    for (const p of nodes(n, 'primary')) if ((p.children.primarySuffix as CstNode[] | undefined)?.some(s => child(s, 'methodReferenceSuffix')) && !cut.some(c => at(c) <= at(p) && endOf(p) <= endOf(c))) cut.push(p);
    cut.sort((a, b) => at(a) - at(b));
    let text = '', from = at(n);
    for (const c of cut) { text += this.text.slice(from, at(c)) + this.lambda(c); from = endOf(c) + 1; }
    return text + this.text.slice(from, endOf(n) + 1);
  }
  private lambda(n: CstNode): string {
    let name = this.lambdaNames.get(n);
    if (!name) {
      let index = this.lambdaNames.size;
      while (this.env.has(`__fn${index}`)) index++;
      name = `__fn${index}`; this.lambdaNames.set(n, name);
      const events = n.name === 'lambdaExpression' ? this.scan(n).flatMap(e => (e.kind === 'intakeOn' || e.kind === 'intakeOff' || e.kind === 'shoot' ? [e.kind] : []))
        : (() => { const s = (n.children.primarySuffix as CstNode[]).find(x => child(x, 'methodReferenceSuffix'))!, m = tokens(child(s, 'methodReferenceSuffix')!).find(t => t.tokenType.name === 'Identifier')?.image ?? ''; const k = mechanism(this.prefixName(child(n, 'primaryPrefix')!), m, undefined); return k ? [k] : []; })();
      this.env.set(name, { kind: 'lambda', events });
    }
    return name;
  }
  value(n: CstNode | undefined): Value { if (!n) return undefined; try { return Expr.eval(this.expr(n), this.env); } catch { return undefined; } }

  /**
   * Lists the paths followed, the mechanism calls, and the waits in `n`, in source order. A call to one of the OpMode's
   * helper methods is read in place of the call, and a helper's own body is skipped where it is declared. A `case`
   * label or a check on the follower is a boundary: the path before it has ended.
   */
  scan(n: CstNode, depth = 0, out: Event[] = []): Event[] {
    switch (n.name) {
      case 'switchLabel': out.push({ kind: 'boundary' }); return out;
      case 'methodDeclaration': { const name = [...this.methods].find(([, b]) => at(b) >= at(n) && endOf(b) <= endOf(n))?.[0]; if (name && this.helpers.has(name)) return out; break; }
      case 'primary': this.scanPrimary(n, depth, out); return out;
      case 'binaryExpression': for (const c of kids(n)) if (!isTok(c)) this.scan(c, depth, out); this.timerWaits(n, out); return out;
    }
    for (const c of kids(n)) if (!isTok(c)) this.scan(c, depth, out);
    return out;
  }

  private scanPrimary(p: CstNode, depth: number, out: Event[]) {
    const prefix = child(p, 'primaryPrefix')!, created = child(prefix, 'newExpression');
    if (created) {
      const u = nodes(created, 'unqualifiedClassInstanceCreationExpression')[0], made = u && this.news(u)[0];
      if (made && FOLLOW_CMD.test(made.type)) this.followed(made.args, out);
      else if (made && SLEEP[made.type.toLowerCase()] !== undefined) this.slept(made.type, made.args, out);
      else for (const a of made?.args ?? []) this.scan(a, depth, out);
    } else if (!child(prefix, 'fqnOrRefType')) for (const c of kids(prefix)) if (!isTok(c)) this.scan(c, depth, out);
    for (const c of this.callsOf(p)) this.scanCall(c, depth, out);
    const ref = (p.children.primarySuffix as CstNode[] | undefined)?.find(s => child(s, 'methodReferenceSuffix'));
    if (ref) { const m = tokens(ref).find(t => t.tokenType.name === 'Identifier')?.image ?? '', k = mechanism(this.prefixName(prefix), m, undefined); if (k) out.push({ kind: k }); }
  }

  private scanCall(c: Call, depth: number, out: Event[]) {
    const lower = c.method.toLowerCase();
    if (c.method === 'follow' || c.method === 'followPath') return this.followed(c.args, out);
    if (/^add\w*Callback$/.test(c.method)) return; // A path callback was read with its path.
    if (FOLLOWER_CHECK.test(c.method)) { out.push({ kind: 'boundary' }); return; }
    if (SLEEP[lower] !== undefined) return this.slept(c.method, c.args, out);
    if ((!c.recv || c.recv === 'this') && this.helpers.has(c.method) && depth < 4) {
      const inner = this.scan(this.methods.get(c.method)!, depth + 1);
      if (inner.some(e => e.kind !== 'boundary')) { out.push(...inner); return; }
    }
    const k = mechanism(c.recv, c.method, this.value(c.args[0]));
    if (k) { out.push({ kind: k }); return; }
    for (const a of c.args) this.scan(a, depth, out);
  }

  private followed(args: CstNode[], out: Event[]) {
    for (const a of args) { const v = this.value(a); if (isPath(v)) { out.push({ kind: 'path', name: this.pathName(a) }); return; } }
  }
  /** Keep an explicit owner; reject a holder whose member name could refer to multiple companion paths. */
  private pathName(a: CstNode) {
    const expr = this.slice(a).trim(), name = expr.split('.').pop()!;
    if (expr.includes('.') && isPath(this.env.get(expr))) return expr;
    if (!expr.includes('.') || expr.startsWith('this.')) {
      const scoped = `${ownerName(this, a)}.${name}`;
      if (isPath(this.env.get(scoped))) return scoped;
    }
    const aliases = [...this.env.keys()].filter(k => k.endsWith(`.${name}`) && isPath(this.env.get(k)));
    if (aliases.length > 1) throw new Error(`Ambiguous path ${expr}: ${aliases.join(', ')}. Use an explicit class-qualified path or select only its needed companions.`);
    return name;
  }
  private slept(name: string, args: CstNode[], out: Event[]) { const v = this.value(args[0]); if (typeof v === 'number') out.push({ kind: 'wait', sec: v * SLEEP[name.toLowerCase()] }); }

  /** A timer compared alone in a condition, as `t.seconds() > 1.5`, is a wait. Beside `||` or the follower's check, it is a timeout. */
  private timerWaits(n: CstNode, out: Event[]) {
    const ops = ((n.children.BinaryOperator ?? []) as IToken[]).slice().sort((a, b) => a.startOffset - b.startOffset), operands = ((n.children.unaryExpression ?? []) as CstNode[]).slice().sort((a, b) => at(a) - at(b));
    if (ops.some(o => o.image === '||') || /isBusy/.test(this.slice(n))) return;
    ops.forEach((o, k) => {
      if (o.image !== '>' && o.image !== '>=') return;
      const m = /(\w+)\s*\(\s*\)\s*$/.exec(this.slice(operands[k])), unit = m && TIMER[m[1].toLowerCase()];
      const v = unit ? this.value(operands[k + 1]) : undefined;
      if (unit && typeof v === 'number' && v > 0) out.push({ kind: 'wait', sec: v * unit });
    });
  }
}

/** Reads every assignment and declaration of a number, a pose, or a path into `src.env`, in two passes, so that a declaration can use a field that the file declares further down. */
function declarations(src: Source, warnings: string[], qualified = false) {
  const assigns: [string, CstNode][] = [];
  for (const d of nodes(src.root, 'variableDeclarator')) {
    const name = tokens(child(d, 'variableDeclaratorId')!)[0]?.image, init = child(d, 'variableInitializer'), e = init && child(init, 'expression');
    if (name && e) assigns.push([name, e]);
  }
  for (const b of nodes(src.root, 'binaryExpression')) {
    const op = (b.children.AssignmentOperator as IToken[] | undefined)?.[0], lhs = child(b, 'unaryExpression'), rhs = child(b, 'expression');
    if (op?.image === '=' && lhs && rhs) assigns.push([src.slice(lhs).trim().split('.').pop()!, rhs]);
  }
  assigns.sort((a, b) => at(a[1]) - at(b[1]));
  // A statement that changes a path built before, such as `park.setLinearHeadingInterpolation(a, b)` or a callback.
  const changes = nodes(src.root, 'expressionStatement').filter(s => /^\s*[A-Za-z_$][\w$]*\s*\.\s*(set\w*HeadingInterpolation|setReversed|add\w*Callback)\s*\(/.test(src.slice(s)));
  for (let pass = 0; pass < 2; pass++) {
    for (const [name, e] of assigns) {
      try {
        const v = Expr.eval(src.expr(e), qualified ? lexicalEnv(src, e) : src.env);
        if (isPose(v) || isPath(v) || typeof v === 'number') {
          const value = typeof v === 'object' ? structuredClone(v) : v;
          src.env.set(name, value);
          if (qualified) {
            const owner = ownerName(src, e);
            if (owner) src.env.set(`${owner}.${name}`, value);
          }
        }
      }
      catch (err) { if (pass === 1 && /\b(Pose|Bezier|line|curve|pathBuilder|Path)\b/.test(src.slice(e))) warnings.push(`Skipped ${name}: ${(err as Error).message}.`); }
    }
    if (pass === 1) for (const s of changes) { const name = /^\s*([A-Za-z_$][\w$]*)/.exec(src.slice(s))![1]; if (isPath(src.env.get(name))) try { Expr.eval(src.expr(child(child(s, 'statementExpression')!, 'expression')!), src.env); } catch { /* reported above */ } }
  }
}

export interface PedroWaypoint { x: number; y: number; headingDeg: number | null }
export interface PedroImport {
  /** The tree file, ready for `addAutoTree`. */ tree: Record<string, unknown>;
  /** Things the importer skipped or guessed, for the person importing. */ warnings: string[];
}

export interface PedroJavaFile { name: string; java: string }
export interface PedroProjectOptions { entryFile?: string; alliance?: 'RED' | 'BLUE' }
interface ParsedFile { file: PedroJavaFile; src: Source; opName?: string }

function ownerName(src: Source, n: CstNode): string | undefined {
  const owners = [...nodes(src.root, 'normalClassDeclaration'), ...nodes(src.root, 'enumDeclaration')]
    .filter(c => at(c) <= at(n) && endOf(n) <= endOf(c)).sort((a, b) => at(b) - at(a));
  const owner = owners[0], id = owner && child(owner, 'typeIdentifier');
  return id && tokens(id)[0]?.image;
}

/** Restore unqualified fields from the helper's enclosing classes rather than another file's last declaration. */
function lexicalEnv(src: Source, n: CstNode): Map<string, Value> {
  const local = new Map(src.env);
  const owners = [...nodes(src.root, 'normalClassDeclaration'), ...nodes(src.root, 'enumDeclaration')]
    .filter(c => at(c) <= at(n) && endOf(n) <= endOf(c)).sort((a, b) => at(a) - at(b));
  for (const owner of owners) {
    const prefix = `${tokens(child(owner, 'typeIdentifier')!)[0].image}.`;
    for (const [key, value] of src.env) if (key.startsWith(prefix) && !key.slice(prefix.length).includes('.')) local.set(key.slice(prefix.length), value);
  }
  return local;
}

async function parseFiles(files: PedroJavaFile[], env = new Map<string, Value>()): Promise<ParsedFile[]> {
  if (!files.length) throw new Error('Select an OpMode and its companion .java files.');
  if (new Set(files.map(f => f.name)).size !== files.length) throw new Error('Duplicate Java filenames: select each companion file once.');
  const { parse } = await import('java-parser');
  return files.map(file => {
    const text = blankComments(file.java);
    let root: CstNode;
    try { root = parse(text); } catch (err) {
      const m = /line: (\d+), column: (\d+)/.exec((err as Error).message);
      throw new Error(`${file.name}: it doesn't read as Java${m ? ` at line ${m[1]}, column ${m[2]}` : ''}`);
    }
    const src = new Source(text, root, env);
    const auto = nodes(root, 'annotation').find(a => /^@\s*Autonomous\b/.test(src.slice(a)));
    const cls = nodes(root, 'classDeclaration').find(c => child(c, 'normalClassDeclaration'));
    const concrete = cls && !(cls.children.classModifier as CstNode[] | undefined)?.some(m => tokens(m).some(t => t.tokenType.name === 'Abstract'));
    return { file, src, opName: auto && concrete ? /\bname\s*=\s*"([^"]*)"/.exec(src.slice(auto))?.[1] || file.name.replace(/\.java$/i, '') : undefined };
  });
}

/** Lists concrete @Autonomous entry files without evaluating their declarations. */
export async function listPedroOpModes(files: PedroJavaFile[]): Promise<{ fileName: string; name: string }[]> {
  return (await parseFiles(files)).filter(f => f.opName !== undefined).map(f => ({ fileName: f.file.name, name: f.opName! }));
}

/** Only numeric/pose helpers made from return expressions and if/else are evaluated. No Java code is executed. */
function registerPoseHelpers(src: Source, budget: { depth: number }) {
  for (const m of nodes(src.root, 'methodDeclaration')) {
    const header = child(m, 'methodHeader')!, result = child(header, 'result');
    if (!result || !/^(Pose|Pose2D|Point|double|float|int|long)$/.test(src.slice(result).trim())) continue;
    const declarator = child(header, 'methodDeclarator')!, name = tokens(declarator)[0].image, body = child(m, 'methodBody')!;
    const params = nodes(declarator, 'variableDeclaratorId').map(n => tokens(n)[0].image);
    const fn: PureFunction = { kind: 'function', invoke(on, args) {
      if (args.length !== params.length) throw new Error(`Wrong argument count for ${name}`);
      if (budget.depth >= 8) throw new Error(`Pose helper recursion limit in ${name}`);
      const local = lexicalEnv(src, m); local.set('this', on ?? OPAQUE);
      params.forEach((p, i) => local.set(p, args[i]));
      const evaluate = (n: CstNode): { value: Value } | undefined => {
        if (n.name === 'returnStatement') return { value: Expr.eval(src.slice(child(n, 'expression')!), local) };
        if (n.name === 'ifStatement') {
          const condition = Expr.eval(src.slice(child(n, 'expression')!), local);
          if (typeof condition !== 'boolean') throw new Error(`Unresolved condition in ${name}`);
          const branches = n.children.statement as CstNode[];
          const branch = branches[condition ? 0 : 1]; return branch && evaluate(branch);
        }
        if (!/^(methodBody|block|blockStatements|blockStatement|statement|statementWithoutTrailingSubstatement)$/.test(n.name)) throw new Error(`Unsupported statement in pose helper ${name}`);
        for (const c of kids(n)) if (!isTok(c)) { const ret = evaluate(c); if (ret) return ret; }
      };
      budget.depth++;
      try { return evaluate(body)?.value; } finally { budget.depth--; }
    } };
    src.env.set(`__call_${name}`, fn);
    const owner = ownerName(src, m);
    if (owner) src.env.set(`__call_${owner}.${name}`, fn);
  }
}

/** Imports one selected routine, resolving companion declarations independently of upload order. */
export async function importPedroProject(files: PedroJavaFile[], options: PedroProjectOptions = {}): Promise<PedroImport> {
  const env = new Map<string, Value>(), parsed = await parseFiles(files, env);
  const candidates = parsed.filter(f => f.opName !== undefined);
  const entry = options.entryFile ? parsed.find(f => f.file.name === options.entryFile) : candidates.length === 1 ? candidates[0] : parsed.length === 1 ? parsed[0] : undefined;
  if (!entry) throw new Error(options.entryFile ? `Entry file ${options.entryFile} wasn't selected.` : 'Choose an OpMode to import from the selected Java files.');
  // Other routines are choices, not dependencies. Their fields and helper names must not shadow this routine.
  const ordered = [...parsed.filter(f => f !== entry && f.opName === undefined).sort((a, b) => a.file.name.localeCompare(b.file.name)), entry];
  const budget = { depth: 0 };
  for (const { src } of ordered) {
    for (const n of [...nodes(src.root, 'normalClassDeclaration'), ...nodes(src.root, 'enumDeclaration')]) {
      const name = tokens(child(n, 'typeIdentifier')!)[0].image;
      env.set(name, { kind: 'namespace', name });
    }
    for (const n of nodes(src.root, 'enumConstant')) {
      const name = (n.children.Identifier?.[0] as IToken | undefined)?.image;
      if (name) { const value: Namespace = { kind: 'namespace', name: `${ownerName(src, n)}.${name}` }; env.set(name, value); env.set(value.name, value); }
    }
    registerPoseHelpers(src, budget);
  }
  const alliance = env.get(`Alliance.${options.alliance ?? 'RED'}`);
  if (alliance) { env.set('alliance', alliance); env.set('Robot.alliance', alliance); }
  // Every pass can resolve one more companion dependency. The final pass alone reports skipped geometry.
  for (let pass = 0; pass < parsed.length + 2; pass++) for (const { src } of ordered) declarations(src, [], true);
  const warnings: string[] = [];
  for (const { src } of ordered) declarations(src, warnings, true);
  const unresolved = entry.src.calls(entry.src.root).filter(c => c.method === 'follow' || c.method === 'followPath')
    .filter(c => !c.args.some(a => isPath(entry.src.value(a)))).map(c => c.args.map(a => entry.src.slice(a)).join(', '));
  if (unresolved.length) throw new Error(`Cannot resolve followed path ${unresolved.join(', ')}. Include its companion path and field .java files. ${[...new Set(warnings)].join(' ')}`);
  if (alliance) warnings.unshift(`Alliance-dependent poses previewed for ${options.alliance ?? 'RED'}; runtime gamepad choices and start delay are not executed.`);
  return buildPedro(entry.src, entry.file.name, [...new Set(warnings)]);
}

/**
 * Converts a Pedro Pathing OpMode to an AUTO tree. Throws when the file isn't Java, or has no path that it can read. The
 * Java parser loads on the first import.
 * @param fileName The source file's name. The class name in the source names the tree; the file name is the fallback.
 */
export async function importPedro(java: string, fileName = 'Auto.java'): Promise<PedroImport> {
  const [{ src }] = await parseFiles([{ name: fileName, java }]), warnings: string[] = [];
  declarations(src, warnings);
  return buildPedro(src, fileName, warnings);
}

function buildPedro(src: Source, fileName: string, warnings: string[]): PedroImport {
  const { root, env } = src;

  const events = src.scan(root), order: string[] = [];
  for (const e of events) if (e.kind === 'path' && !order.includes(e.name)) order.push(e.name);
  const paths = (order.length ? order : [...env.keys()].filter(k => !k.includes('.'))).filter(k => isPath(env.get(k)));
  if (!paths.length) throw new Error('found no Pedro path: expected line(...), curve(...), new BezierLine(...), or pathBuilder()...build()');
  if (!order.length) warnings.push('The source never calls follow() or followPath(), so the paths run in the order they are declared.');

  const firstSeg = (k: string) => { const v = env.get(k)!; return isSeg(v) ? v : (v as Chain).segments[0]; };
  const startCall = src.calls(root).find(c => c.method === 'setStartingPose' || c.method === 'setPose'), startValue = startCall && src.value(startCall.args[0]);
  const start = isPose(startValue) ? startValue : firstSeg(paths[0])?.pts[0];
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

  const cls = nodes(root, 'normalClassDeclaration')[0], className = (cls && tokens(child(cls, 'typeIdentifier')!)[0]?.image) ?? fileName.replace(/\.java$/i, '');
  const auto = nodes(root, 'annotation').find(a => /^@\s*Autonomous\b/.test(src.slice(a)));
  const opName = auto && /\bname\s*=\s*"([^"]*)"/.exec(src.slice(auto))?.[1];
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
