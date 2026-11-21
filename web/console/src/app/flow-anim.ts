import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
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
import { RouterService } from './router.service';
import { errMsg } from './util';
import { buildFlow, buildLayout, buildStatic, emptyStatic, pointOnPath } from './flow-model';
import type { FlowEdgeGeom, FlowKind, FlowLayout, FlowNodeGeom, FlowSize, FlowStat } from './flow-model';

/** 连接采样间隔（clash_api /connections） */
const SAMPLE_MS = 1500;
/** 静态拓扑（config.json）刷新间隔：结构变化不频繁，30s 足够 */
const CFG_MS = 30_000;
/** 粒子走完全程的时长 */
const PARTICLE_MS = 1800;
/** 同时存在的粒子上限（超出丢最旧的） */
const MAX_PARTICLES = 180;
/** 已见过连接 id 的保留时长（超过就忘掉，避免 Map 无限增长） */
const SEEN_TTL_MS = 120_000;
/** 初始化尺寸（ResizeObserver 量到真实尺寸前用） */
const FALLBACK_W = 1080;
const FALLBACK_H = 520;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** 模板里用的节点块（几何 + hover 派生状态） */
interface NodeView extends FlowNodeGeom {
  hi: boolean;
  dim: boolean;
}

/** 模板里用的连线（几何 + hover 派生状态） */
interface EdgeView extends FlowEdgeGeom {
  hi: boolean;
  dim: boolean;
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
 * 流向动画 v3 — 六列（电脑 → 路由器 → 规则集 → 分组 → 节点行 → 互联网）。
 *
 * ⑤ 改成「分组成员逐行」：一行 = 一个 (分组, 成员)，同一节点属于多个分组时各占一行；
 * 行数可能上百，画布按行数撑高，超出容器高度时 .flowcanvas 内部纵向滚动（列头随内容滚动）。
 *
 * 数据两路并行（口径见 docs/plan-flow-v2.md）：
 *  · 静态拓扑：`RouterService.config()` 读 config.json → `buildStatic()`，每 30s 刷新一次；
 *  · 实时流量：`ClashService.connections()` 每 1.5s 采样 → `buildFlow(conns, stat)` 合流成六列。
 *
 * 交互与性能：
 *  · 每条**新出现**的连接生成一个粒子，沿自己的列 key 路径走 1.8s 后淡出（上限 180）；
 *  · hover 节点 → 高亮它所有连线（其它连线 opacity 降到 0.08）+ 自绘 tooltip；
 *  · rAF 只推进粒子；几何随 ResizeObserver 重算；OnDestroy 清掉 interval/rAF/RO。
 *
 * 几何与列头文案都在 flow-model（纯函数，可在 node 里直接预览渲染）。
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
export class FlowAnim implements OnInit, AfterViewInit, OnDestroy {
  readonly backend = input.required<Backend>();

  private readonly clash = inject(ClashService);
  private readonly router = inject(RouterService);
  private readonly canvas = viewChild<ElementRef<HTMLDivElement>>('canvas');

  /** 静态结构（config 解析结果 + ②列名字） */
  readonly stat = signal<FlowStat>(emptyStatic());
  /** 六列布局（首帧空布局，采样后填充） */
  readonly flow = signal<FlowLayout>(buildFlow([], emptyStatic()));
  /** 连接采样错误（401 / CORS / 地址没填） */
  readonly err = signal('');
  /** config 通道错误（99 侧 /router/config 失败、或 JSON 坏掉）→ 降级成「仅实时」 */
  readonly cfgErr = signal('');
  /** 粒子渲染层（每帧重算，t 到 1 的粒子已被移除） */
  private readonly dotsSig = signal<Dot[]>([]);
  readonly dots = this.dotsSig.asReadonly();
  /** 当前 hover 的节点 key（空 = 没有） */
  readonly hover = signal<string | null>(null);
  private readonly pointer = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  private readonly size = signal<FlowSize>({ w: FALLBACK_W, h: FALLBACK_H });

  /** 粒子内部状态（原生数组，不进 signal：每帧只把投影结果写 dots） */
  private particles: Particle[] = [];
  /** 已见过的连接 id → 最近出现的时刻（毫秒），用于「新连接才生成粒子」 */
  private readonly seen = new Map<string, number>();
  /** 最近一次采样到的连接（config 刷新后要用它重建布局） */
  private lastConns: Connection[] = [];
  private seq = 0;
  private version = '';
  private started = false;
  private destroyed = false;
  private rafId = 0;
  private cfgTimer: ReturnType<typeof setInterval> | null = null;
  private connTimer: ReturnType<typeof setInterval> | null = null;
  private ro: ResizeObserver | null = null;
  private lastFrame = 0;

  readonly stats = computed(() => this.flow().stats);
  /**
   * 六列几何（列 / 节点块 / 连线 / 粒子锚点）。
   * `h` 是**内容高度**：⑤ 行数可能上百，画布按行数撑高，超出 .flowcanvas 时纵向滚动。
   */
  readonly geom = computed(() => buildLayout(this.flow(), this.size()));
  /** SVG viewBox 与内容像素 1:1（文字/圆点不缩放） */
  readonly vb = computed(() => {
    const g = this.geom();
    return `0 0 ${g.w} ${g.h}`;
  });

  /** 连线：hover 时只保留与该节点相关的线（其余降到 0.08） */
  readonly edgesView = computed<EdgeView[]>(() => {
    const h = this.hover();
    return this.geom().edges.map((e) => ({
      ...e,
      hi: !!h && (e.from === h || e.to === h),
      dim: !!h && e.from !== h && e.to !== h,
    }));
  });

  /** 节点块：hover 的节点与它的邻居高亮，其余变淡 */
  readonly nodesView = computed<NodeView[]>(() => {
    const h = this.hover();
    const near = new Set<string>();
    if (h) {
      near.add(h);
      for (const e of this.geom().edges) {
        if (e.from === h) near.add(e.to);
        if (e.to === h) near.add(e.from);
      }
    }
    return this.geom().nodes.map((n) => ({ ...n, hi: n.key === h, dim: !!h && !near.has(n.key) }));
  });

  /** tooltip（自绘 HTML 层，位置跟随指针，靠近右边/下边时收进来） */
  readonly tip = computed<{ x: number; y: number; text: string } | null>(() => {
    const key = this.hover();
    if (!key) return null;
    const node = this.geom().nodes.find((n) => n.key === key);
    if (!node) return null;
    const p = this.pointer();
    const g = this.geom();
    return {
      x: Math.min(p.x + 14, Math.max(6, g.w - 250)),
      y: Math.min(p.y + 16, Math.max(6, g.h - 90)),
      text: node.tip || node.label,
    };
  });

  constructor() {
    // 后端切换（含首次）：清空历史并重新拉配置/采样；首次由 ngOnInit 触发，避免视图未就绪时白跑
    effect(() => {
      const b = this.backend();
      untracked(() => {
        if (this.started && !this.destroyed) this.reset(b);
      });
    });
  }

  ngOnInit(): void {
    this.started = true;
    this.reset(this.backend());
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
    if (this.cfgTimer) clearInterval(this.cfgTimer);
    if (this.connTimer) clearInterval(this.connTimer);
    this.cfgTimer = null;
    this.connTimer = null;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.ro?.disconnect();
    this.ro = null;
    this.particles = [];
    this.seen.clear();
  }

  /* ────────────────────────── 生命周期 / 数据 ────────────────────────── */

  /** 后端切换：状态清零 + 立刻拉一次 config/version/连接（定时器与 rAF 只起一次） */
  private reset(b: Backend): void {
    this.seen.clear();
    this.particles = [];
    this.dotsSig.set([]);
    this.err.set('');
    this.cfgErr.set('');
    this.hover.set(null);
    this.lastConns = [];
    this.version = '';
    this.stat.set(emptyStatic(this.hostOf(b)));
    this.flow.set(buildFlow([], this.stat()));
    this.startLoops();
    void this.loadVersion(b);
    void this.loadConfig(b);
    void this.sample(b);
  }

  /** ②列名字：后端的 host（例如 192.168.31.32）；解析不出来退回后端名 */
  private hostOf(b: Backend): string {
    try {
      return this.router.host(b) || b.name || 'sing-box';
    } catch {
      return b.name || 'sing-box';
    }
  }

  /** 定时器与 rAF 循环都只启动一次（reset 可能被多次调用） */
  private startLoops(): void {
    if (!this.cfgTimer) {
      this.cfgTimer = setInterval(() => {
        if (document.hidden || this.destroyed) return;
        void this.loadConfig(this.backend());
      }, CFG_MS);
    }
    if (!this.connTimer) {
      this.connTimer = setInterval(() => {
        if (document.hidden || this.destroyed) return;
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

  /** 引擎版本（②列次行）；失败静默（不影响主功能） */
  private async loadVersion(b: Backend): Promise<void> {
    try {
      const v = await this.clash.version(b);
      if (this.destroyed) return;
      this.version = (v?.version ?? '').trim();
      if (!this.version) return;
      this.stat.set({ ...this.stat(), routerSub: this.versionLabel() });
      this.flow.set(buildFlow(this.lastConns, this.stat()));
    } catch {
      /* 版本拿不到就不显示，不打扰用户 */
    }
  }

  /** 拉一次 config.json → 静态结构（③④⑤ 的骨架）。失败降级成「仅实时」 */
  private async loadConfig(b: Backend): Promise<void> {
    const name = this.hostOf(b);
    try {
      const resp = await this.router.config(b);
      if (this.destroyed) return;
      const st = buildStatic(resp?.config ?? '');
      // 次行在 await 之后再取版本：/version 与 /router/config 谁先回来都不丢版本号
      this.stat.set({ ...st, routerName: name, routerSub: this.versionLabel() });
      this.cfgErr.set(st.ok ? '' : (st.err ?? '配置解析失败'));
      this.flow.set(buildFlow(this.lastConns, this.stat()));
    } catch (e) {
      if (this.destroyed) return;
      const msg = errMsg(e);
      this.stat.set({ ...emptyStatic(name, this.versionLabel()), err: msg });
      this.cfgErr.set(`配置读取失败：${msg}`);
      this.flow.set(buildFlow(this.lastConns, this.stat()));
    }
  }

  /** ②列次行文案：sing-box + 引擎版本（版本没拿到就只写 sing-box） */
  private versionLabel(): string {
    return this.version ? `sing-box ${this.version}` : 'sing-box';
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
      const conns = resp?.connections ?? [];
      this.lastConns = conns;
      this.apply(conns);
    } catch (e) {
      if (this.destroyed) return;
      const x = e as { status?: number };
      this.err.set(x?.status === 401 ? '密钥未填或错误（401）' : errMsg(e));
    }
  }

  /** 归并布局 + 给「第一次见到」的连接生成粒子 */
  private apply(conns: Connection[]): void {
    const flow = buildFlow(conns, this.stat());
    this.flow.set(flow);
    const now = Date.now();
    const live = new Set<string>();
    for (const s of flow.sample) {
      live.add(s.id);
      if (!this.seen.has(s.id)) this.spawn(s.path, s.kind);
      this.seen.set(s.id, now);
    }
    // 已经断开的连接：超过 SEEN_TTL_MS 没再出现就忘掉 id（防止 Map 无限增长）
    for (const [id, at] of [...this.seen]) {
      if (!live.has(id) && now - at > SEEN_TTL_MS) this.seen.delete(id);
    }
  }

  private spawn(keys: readonly string[], kind: FlowKind): void {
    if (keys.length < 2) return;
    this.particles.push({ n: ++this.seq, keys: [...keys], t: 0, kind });
    if (this.particles.length > MAX_PARTICLES) this.particles.splice(0, this.particles.length - MAX_PARTICLES);
  }

  /* ────────────────────────── 粒子推进 ────────────────────────── */

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
      const at = pointOnPath(p.keys, p.t, g);
      if (!at) continue;
      const t = p.t;
      const opacity = t < 0.08 ? t / 0.08 : t > 0.86 ? Math.max(0, (1 - t) / 0.14) : 1;
      out.push({ n: p.n, cx: round1(at.x), cy: round1(at.y), r: 2.6, opacity: round1(opacity), kind: p.kind });
    }
    this.dotsSig.set(out);
  }

  /* ────────────────────────── 交互 ────────────────────────── */

  /** 进入节点块：记下 hover + 指针位置（tooltip 立刻有位置，不用等 mousemove） */
  onEnter(key: string, ev: MouseEvent): void {
    this.hover.set(key);
    this.trackPointer(ev);
  }

  onMove(ev: MouseEvent): void {
    if (!this.hover()) return; // 没有 hover 节点时不必每帧写指针
    this.trackPointer(ev);
  }

  clearHover(): void {
    if (this.hover()) this.hover.set(null);
  }

  private trackPointer(ev: MouseEvent): void {
    const el = this.canvas()?.nativeElement;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // canvas 可纵向滚动：换算到内容坐标（tooltip 是 canvas 的绝对定位子元素，会跟着一起滚）
    this.pointer.set({
      x: Math.round(ev.clientX - r.left + el.scrollLeft),
      y: Math.round(ev.clientY - r.top + el.scrollTop),
    });
  }

  /* ────────────────────────── 尺寸 ────────────────────────── */

  /** 容器尺寸（ResizeObserver 回调里调用；变化超过 1px 才写 signal，避免抖动重排） */
  private measure(el: HTMLElement): void {
    const w = Math.max(360, Math.round(el.clientWidth));
    const h = Math.max(240, Math.round(el.clientHeight));
    const prev = this.size();
    if (Math.abs(prev.w - w) > 1 || Math.abs(prev.h - h) > 1) this.size.set({ w, h });
  }
}