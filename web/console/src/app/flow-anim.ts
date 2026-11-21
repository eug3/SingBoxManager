import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { Backend, Connection } from './models';
import { ClashService } from './clash.service';
import { FLOW_COLS, buildFlow, colOfKey, flowKind, pathKind } from './flow-model';
import type { FlowCol, FlowKind, FlowLayout } from './flow-model';

/** 采样间隔（clash_api /connections） */
const SAMPLE_MS = 1500;
/** 粒子走完全程的时长 */
const PARTICLE_MS = 1600;
/** 同时存在的粒子上限（超出丢最旧的） */
const MAX_PARTICLES = 150;
/** 初始化尺寸（ResizeObserver 量到真实尺寸前用） */
const FALLBACK_W = 960;
const FALLBACK_H = 460;
/** 列头文案（与五列一一对应） */
const TITLES = ['我的电脑', '分流节点', '节点组', '节点', '互联网'];
const SUBS = ['本机', 'rule → outbound', 'Selector / URLTest', '实际出站', '目标域名 / IP'];
const MARKS = ['①', '②', '③', '④', '⑤'];

const r1 = (n: number): number => Math.round(n * 10) / 10;

interface Size {
  w: number;
  h: number;
}

/** 列里一个节点锚点：左沿 / 右沿 / 垂直中心（连线与粒子都挂在这上面） */
interface Anchor {
  x0: number;
  x1: number;
  cy: number;
}

interface ColGeom {
  key: FlowCol;
  mark: string;
  title: string;
  sub: string;
  total: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface NodeGeom {
  key: string;
  name: string;
  label: string;
  badge: string;
  count: number;
  kind: FlowKind;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface EdgeGeom {
  d: string;
  opacity: number;
  width: number;
}

/** 一帧里的一个粒子（模板用） */
interface Dot {
  n: number;
  cx: number;
  cy: number;
  r: number;
  opacity: number;
  kind: FlowKind;
}

/** 粒子内部状态：沿列 key 路径走，t∈[0,1] */
interface Particle {
  n: number;
  keys: string[];
  t: number;
  kind: FlowKind;
}

/**
 * 文本按「半角宽度单位」截断（CJK 算 2 个单位），保证节点名不压到右侧次数。
 */
function fitText(s: string, units: number): string {
  let used = 0;
  let out = '';
  for (const ch of s) {
    const w = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 2 : 1;
    if (used + w > units) return out ? out + '…' : s.slice(0, 1);
    used += w;
    out += ch;
  }
  return out;
}

/** 两点之间的横向三次贝塞尔（起点右沿 → 终点左沿），控制点水平外推 */
function curvePath(a: Anchor, b: Anchor): string {
  const dx = Math.max(10, (b.x0 - a.x1) * 0.5);
  const c1x = a.x1 + dx;
  const c2x = Math.max(a.x1 + 6, b.x0 - dx);
  return `M${r1(a.x1)} ${r1(a.cy)} C${r1(c1x)} ${r1(a.cy)},${r1(c2x)} ${r1(b.cy)},${r1(b.x0)} ${r1(b.cy)}`;
}

/** 同一条贝塞尔在 t∈[0,1] 处的点（粒子沿真实连线走，不另算路径） */
function bezierAt(a: Anchor, b: Anchor, t: number): { x: number; y: number } {
  const dx = Math.max(10, (b.x0 - a.x1) * 0.5);
  const x0 = a.x1;
  const x1 = a.x1 + dx;
  const x2 = Math.max(a.x1 + 6, b.x0 - dx);
  const x3 = b.x0;
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * mt * mt * t;
  const w2 = 3 * mt * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * x0 + w1 * x1 + w2 * x2 + w3 * x3,
    y: w0 * a.cy + w1 * a.cy + w2 * b.cy + w3 * b.cy,
  };
}

/**
 * 流向动画 — 五列（我的电脑 → 分流节点 → 节点组 → 节点 → 互联网）。
 *
 * - 每 1.5s 采样一次 `/connections`，`buildFlow` 归并成五列布局（flow-model 纯函数）
 * - 每条**新出现**的连接生成一个粒子，沿自己的列 key 路径走完 1.6s 后消失（上限 150）
 * - 粒子推进只走 requestAnimationFrame；布局随 ResizeObserver 重算；销毁时全部清掉
 * - 采样失败只更新顶部错误提示，保留上一帧布局（不会闪成空画布）
 */
@Component({
  selector: 'app-flow-anim',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  templateUrl: './flow-anim.html',
  styles: `
    :host {
      display: block;
      height: 100%;
    }
  `,
})
export class FlowAnim implements AfterViewInit, OnDestroy {
  readonly backend = input.required<Backend>();

  private readonly clash = inject(ClashService);
  private readonly canvas = viewChild<ElementRef<HTMLDivElement>>('canvas');

  /** 当前五列布局（首帧空布局，采样后填充） */
  readonly flow = signal<FlowLayout>(buildFlow([]));
  /** 顶部统计：本次采样新增的连接数 */
  readonly added = signal(0);
  /** 采样错误（401 / CORS / 地址没填） */
  readonly err = signal('');
  /** 粒子渲染层（每帧重算，t 到 1 的粒子已被移除） */
  private readonly dotsSig = signal<Dot[]>([]);
  readonly dots = this.dotsSig.asReadonly();

  private readonly size = signal<Size>({ w: FALLBACK_W, h: FALLBACK_H });

  /** 粒子内部状态（原生数组，不进 signal：每帧只把投影结果写 dots） */
  private particles: Particle[] = [];
  /** 已见过的连接 id → 最近出现的时刻（毫秒），用于「新连接才生成粒子」 */
  private readonly seen = new Map<string, number>();
  private seq = 0;
  private rafId = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ro: ResizeObserver | null = null;
  private lastFrame = 0;
  private destroyed = false;

  readonly stats = computed(() => this.flow().stats);
  /** SVG viewBox 与量到的容器像素尺寸 1:1（文字/圆点不缩放） */
  readonly vb = computed(() => {
    const s = this.size();
    return `0 0 ${s.w} ${s.h}`;
  });
  readonly geom = computed(() => this.buildGeometry());

  constructor() {
    // 后端切换（含首次）→ 清空历史并立刻采样；写信号的动作放进 untracked，避免 effect 自我触发
    effect(() => {
      const b = this.backend();
      untracked(() => this.reset(b));
    });
  }

  ngAfterViewInit(): void {
    const el = this.canvas()?.nativeElement;
    if (!el) return;
    this.measure(el);
    this.ro = new ResizeObserver(() => this.measure(el));
    this.ro.observe(el);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.ro?.disconnect();
    this.ro = null;
    this.particles = [];
    this.seen.clear();
  }

  /** 后端切换：状态清零 + 立刻拉一次（定时器与 rAF 由 ngOnInit 之后首帧启动，只起一次） */
  private reset(b: Backend): void {
    this.seen.clear();
    this.particles = [];
    this.dotsSig.set([]);
    this.added.set(0);
    this.err.set('');
    this.flow.set(buildFlow([]));
    this.ensureLoops();
    void this.sample(b);
  }

  /** 定时采样与 rAF 循环都只启动一次（reset 可能被多次调用） */
  private ensureLoops(): void {
    if (!this.timer) {
      this.timer = setInterval(() => {
        if (document.hidden) return;
        void this.sample(this.backend());
      }, SAMPLE_MS);
    }
    if (!this.rafId) {
      this.lastFrame = 0;
      const step = (ts: number): void => {
        if (this.destroyed) return;
        const dt = this.lastFrame ? Math.min(120, ts - this.lastFrame) : 16;
        this.lastFrame = ts;
        this.advance(dt);
        this.rafId = requestAnimationFrame(step);
      };
      this.rafId = requestAnimationFrame(step);
    }
  }

  /** 采样一次连接列表并刷新布局/粒子 */
  private async sample(b: Backend): Promise<void> {
    if (!b?.api) {
      this.err.set('该后端还没配置地址（在「⚙ 后端配置」里填 http(s)://主机:9090）');
      return;
    }
    try {
      const resp = await this.clash.connections(b);
      if (this.destroyed) return;
      this.err.set('');
      this.apply(resp?.connections ?? []);
    } catch (e) {
      if (this.destroyed) return;
      const err = e as { status?: number; message?: string };
      this.err.set(err?.status === 401 ? '密钥未填或错误（401）' : (err?.message ?? String(e)));
    }
  }

  /** 归并布局 + 给「第一次见到」的连接生成粒子 */
  private apply(conns: Connection[]): void {
    const flow = buildFlow(conns);
    this.flow.set(flow);
    const now = Date.now();
    const live = new Set<string>();
    let added = 0;
    for (const s of flow.sample) {
      live.add(s.id);
      if (!this.seen.has(s.id)) {
        added++;
        this.spawn(s.path);
      }
      this.seen.set(s.id, now);
    }
    // 已经断开的连接：超过 2 分钟没再出现就忘掉 id（防止 Map 无限增长）
    for (const [id, at] of [...this.seen]) {
      if (!live.has(id) && now - at > 120_000) this.seen.delete(id);
    }
    this.added.set(added);
  }

  private spawn(keys: readonly string[]): void {
    if (keys.length < 2) return;
    this.particles.push({ n: ++this.seq, keys: [...keys], t: 0, kind: pathKind(keys) });
    if (this.particles.length > MAX_PARTICLES)
      this.particles.splice(0, this.particles.length - MAX_PARTICLES);
  }

  /** 每帧推进：t 按 deltaTime 前进，走完即移除；再把投影写进 dots */
  private advance(dt: number): void {
    if (!this.particles.length) {
      if (this.dotsSig().length) this.dotsSig.set([]);
      return;
    }
    const keep: Particle[] = [];
    for (const p of this.particles) {
      p.t += dt / PARTICLE_MS;
      if (p.t < 1) keep.push(p);
    }
    this.particles = keep;
    const g = this.geom();
    const out: Dot[] = [];
    for (const p of keep) {
      const at = this.pointAt(p, g.anchors, g.fallback);
      if (!at) continue;
      const t = p.t;
      const opacity = t < 0.08 ? t / 0.08 : t > 0.86 ? Math.max(0, (1 - t) / 0.14) : 1;
      out.push({ n: p.n, cx: r1(at.x), cy: r1(at.y), r: 2.6, opacity: r1(opacity), kind: p.kind });
    }
    this.dotsSig.set(out);
  }

  /** 粒子当前点：按路径分段线性分配时间，段内走真实贝塞尔 */
  private pointAt(
    p: Particle,
    anchors: Map<string, Anchor>,
    fallback: (k: string) => Anchor,
  ): { x: number; y: number } | null {
    const keys = p.keys;
    const segs = keys.length - 1;
    if (segs < 1) return null;
    const u = Math.min(1, Math.max(0, p.t)) * segs;
    const idx = Math.min(segs - 1, Math.floor(u));
    const a = anchors.get(keys[idx]) ?? fallback(keys[idx]);
    const b = anchors.get(keys[idx + 1]) ?? fallback(keys[idx + 1]);
    if (!a || !b) return null;
    return bezierAt(a, b, u - idx);
  }

  /** 容器尺寸（ResizeObserver 回调里调用；变化超过 1px 才写 signal，避免抖动重排） */
  private measure(el: HTMLElement): void {
    const w = Math.max(320, Math.round(el.clientWidth));
    const h = Math.max(240, Math.round(el.clientHeight));
    const prev = this.size();
    if (Math.abs(prev.w - w) > 1 || Math.abs(prev.h - h) > 1) this.size.set({ w, h });
  }

  /** 五列几何：列背景/列头、节点块、列间连线，以及按 key 查锚点的索引 */
  private buildGeometry(): {
    cols: ColGeom[];
    nodes: NodeGeom[];
    edges: EdgeGeom[];
    anchors: Map<string, Anchor>;
    fallback: (key: string) => Anchor;
  } {
    const { w, h } = this.size();
    const flow = this.flow();
    const padX = 14;
    const slotW = Math.max(80, (w - padX * 2) / FLOW_COLS.length);
    const gap = Math.min(20, Math.max(10, slotW * 0.1));
    const colW = Math.max(60, slotW - gap);
    const headerH = 44;
    const top = headerH + 6;
    const bottom = Math.max(top + 60, h - 12);
    const avail = bottom - top;

    const cols: ColGeom[] = [];
    const nodes: NodeGeom[] = [];
    const anchors = new Map<string, Anchor>();
    const slotAnchors: Anchor[] = [];
    const units = Math.max(4, Math.floor((colW - 46) / 6.4));
    const badgeUnits = Math.max(4, Math.floor((colW - 18) / 5.1));

    FLOW_COLS.forEach((col, i) => {
      const x = r1(padX + slotW * i + (slotW - colW) / 2);
      const list = flow.cols[col];
      const total = list.reduce((n, it) => n + it.count, 0);
      cols.push({
        key: col,
        mark: MARKS[i],
        title: TITLES[i],
        sub: SUBS[i],
        total,
        x,
        y: 6,
        w: r1(colW),
        h: Math.max(140, h - 12),
      });

      // 纵向铺开（类桑基图）：节点少就拉开、多就压紧，整列居中；最多 84px 一档
      const n = list.length;
      const blockH = n > 7 ? 26 : 30;
      const rowGap = n > 7 ? 5 : 8;
      let spread = blockH + rowGap;
      if (n > 1) {
        spread = Math.min(84, Math.max(blockH + rowGap, avail / n));
        if (spread * (n - 1) + blockH > avail)
          spread = Math.max(blockH + 2, (avail - blockH) / (n - 1));
      }
      const totalH = n > 1 ? spread * (n - 1) + blockH : blockH;
      const startY = top + Math.max(0, (avail - totalH) / 2);
      list.forEach((it, j) => {
        const y = r1(startY + (n > 1 ? j * spread : 0));
        nodes.push({
          key: it.key,
          name: it.name,
          label: fitText(it.name, units),
          badge: it.badge ? fitText(it.badge, badgeUnits) : '',
          count: it.count,
          kind: flowKind(it.name),
          x,
          y,
          w: r1(colW),
          h: blockH,
        });
        anchors.set(it.key, { x0: x, x1: r1(x + colW), cy: r1(y + blockH / 2) });
      });
      slotAnchors.push({ x0: x, x1: r1(x + colW), cy: r1(top + avail / 2) });
    });

    // 超出一列 10 个上限的节点在 sample 路径里仍存在：按列中心兜底定位，粒子不会凭空消失
    const fallback = (key: string): Anchor =>
      slotAnchors[FLOW_COLS.indexOf(colOfKey(key))] ?? slotAnchors[0];

    const edges: EdgeGeom[] = flow.edges.map((e) => {
      const a = anchors.get(e.from) ?? fallback(e.from);
      const b = anchors.get(e.to) ?? fallback(e.to);
      return {
        d: curvePath(a, b),
        opacity: r1(Math.min(0.6, 0.16 + Math.log2(1 + e.count) * 0.12)),
        width: r1(Math.min(3, 1 + Math.log2(e.count) * 0.55)),
      };
    });

    return { cols, nodes, edges, anchors, fallback };
  }
}
