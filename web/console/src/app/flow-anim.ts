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
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { Backend, Connection } from './models';
import { BackendsService } from './backends.service';
import { ClashService } from './clash.service';
import { LiveStatService } from './live-stat.service';
import { RouterService } from './router.service';
import { errMsg, fmtBytes, fmtRate } from './util';
import { AreaChartComponent } from './area-chart';
import type { ChartSeries } from './area-chart';
import {
  buildFlow,
  buildLayout,
  buildStatic,
  emptyStatic,
  markActive,
  nameOfKey,
  pointOnPath,
  stepActivity,
  tangentOnPath,
  trafficTotal,
} from './flow-model';
import type { ActivityState } from './flow-model';
import type {
  ClientInfo,
  ClientMap,
  DelayMap,
  FlowEdgeGeom,
  FlowKind,
  FlowLayout,
  FlowNodeGeom,
  FlowSize,
  FlowStat,
} from './flow-model';

/** 连接采样间隔（clash_api /connections） */
const SAMPLE_MS = 1500;
/** 静态拓扑（config.json）刷新间隔：结构变化不频繁，30s 足够 */
const CFG_MS = 30_000;
/** 局域网名册（/router/clients → ip→MAC/主机名）刷新间隔：DHCP/ARP 变化慢，30s 足够 */
const CLIENTS_MS = 30_000;
/** 节点延时（clash_api /proxies 的 history 末次 delay）刷新间隔：测速本来就慢，5s 足够 */
const PROXIES_MS = 5000;
/** 边「活跃」的保持时长：最后一次看到字节增长后再亮这么久（≈2.7 次采样） */
const IDLE_MS = 4000;
/** 右下角微型图：滚动缓冲点数（1s 一个点 ≈ 1 分钟） */
const MINI_POINTS = 60;
/** 微型图 WS 断线重连间隔 */
const MINI_RETRY_MS = 3000;
/** 微型图高度（px） */
const MINI_H = 36;
/** 粒子走完全程的时长 */
const PARTICLE_MS = 1800;
/** 同时存在的粒子上限（超出丢最旧的） */
const MAX_PARTICLES = 180;
/** 长连接重复发鱼间隔：让稳态画面持续有鱼游，而不是只有新连接才发 */
const REEMIT_MS = 2600;
/** 已见过连接 id 的保留时长（超过就忘掉，避免 Map 无限增长） */
const SEEN_TTL_MS = 120_000;
/** 初始化尺寸（ResizeObserver 量到真实尺寸前用） */
const FALLBACK_W = 1080;
const FALLBACK_H = 520;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/* #mini-pure-start */
/** 追加一个点并裁剪到最近 cap 个（缓冲裁剪的唯一入口） */
export function pushCapped(arr: readonly number[], v: number, cap: number): number[] {
  const next = [...arr, Number.isFinite(v) ? v : 0];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** 左侧补 null 到 len（AreaChart 按窗口格数右对齐，没有数据的格子留空） */
export function padPoints(arr: readonly number[], len: number): (number | null)[] {
  if (arr.length >= len) return arr.slice(arr.length - len);
  return [...new Array<null>(len - arr.length).fill(null), ...arr];
}

/** clash `/traffic` 的一条消息 → {up, down}（字节/秒）；坏数据返回 null */
export function parseTrafficMsg(raw: string): { up: number; down: number } | null {
  try {
    const o = JSON.parse(raw) as { up?: unknown; down?: unknown };
    const up = Number(o?.up);
    const down = Number(o?.down);
    if (!Number.isFinite(up) && !Number.isFinite(down)) return null;
    return { up: Number.isFinite(up) ? Math.max(0, up) : 0, down: Number.isFinite(down) ? Math.max(0, down) : 0 };
  } catch {
    return null;
  }
}

/** clash `/memory` 的一条消息 → inuse 字节；坏数据返回 null */
export function parseMemoryMsg(raw: string): number | null {
  try {
    const o = JSON.parse(raw) as { inuse?: unknown };
    const n = Number(o?.inuse);
    return Number.isFinite(n) ? Math.max(0, n) : null;
  } catch {
    return null;
  }
}
/* #mini-pure-end */

/** `GET /router/clients` 的响应（service 侧新接口；这里只声明用到的字段） */
interface RouterClientsResp {
  ok?: boolean;
  host?: string;
  clients?: { ip?: string; mac?: string; name?: string }[];
  ms?: number;
}

/** 模板里用的节点块（几何 + hover/强调派生状态 + 是否可点开编辑弹窗） */
interface NodeView extends FlowNodeGeom {
  hi: boolean;
  dim: boolean;
  /** 强调视图里「有流量」的节点：额外加粗发光 */
  emp: boolean;
  /** ③④ 卡片且指向 config 里真实分组 → 可点击编辑（DIRECT/block 带不可编辑） */
  edit: boolean;
}

/** ③ 规则卡 key（`rule:分组名[桶 …]`）→ 分组 tag：取 '[' 前缀 */
function ruleGroupTag(key: string): string {
  const name = nameOfKey(key);
  const i = name.indexOf('[');
  return i > 0 ? name.slice(0, i) : name;
}

/** 模板里用的连线（几何 + hover/强调派生状态；opacity/width 已是最终渲染值） */
interface EdgeView extends FlowEdgeGeom {
  hi: boolean;
  dim: boolean;
  /** 强调视图里「有流量」的连线：额外加粗提亮 */
  emp: boolean;
}

/** 一帧里的一条小鱼（模板用）：位置 + 朝向角度 + 缩放 + 摆尾相位 */
interface Fish {
  n: number;
  x: number;
  y: number;
  /** 前进方向（度，0 = 朝 +x） */
  a: number;
  /** 缩放（0.85–1.1，直连/拦截略小） */
  s: number;
  opacity: number;
  kind: FlowKind;
  /** 摆尾动画的负延时（错开相位，单位 s） */
  delay: string;
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
  imports: [AreaChartComponent],
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
  /** 点 ③ 规则集卡 → 打开该分组的规则集编辑弹窗（参数 = 分组 tag） */
  readonly editRule = output<string>();
  /** 点 ④ 分组卡 → 打开该分组的成员/类型编辑弹窗（参数 = 分组 tag） */
  readonly editGroup = output<string>();

  private readonly clash = inject(ClashService);
  /** 全站唯一的连接快照轮询服务（本组件按 1.5s 订阅，取到就重排流向图） */
  private readonly live = inject(LiveStatService);
  private readonly router = inject(RouterService);
  private readonly http = inject(HttpClient);
  private readonly backends = inject(BackendsService);
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
  private readonly dotsSig = signal<Fish[]>([]);
  readonly dots = this.dotsSig.asReadonly();
  /** 当前 hover 的节点 key（空 = 没有） */
  readonly hover = signal<string | null>(null);
  private readonly pointer = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  private readonly size = signal<FlowSize>({ w: FALLBACK_W, h: FALLBACK_H });

  /** 粒子内部状态（原生数组，不进 signal：每帧只把投影结果写 dots） */
  private particles: Particle[] = [];
  /** 已见过的连接 id → 最近出现的时刻（毫秒），用于「新连接才生成粒子」 */
  private readonly seen = new Map<string, number>();
  /** 上次发鱼时间（与 seen 的存活 TTL 分开，否则每 tick 刷新导致永不重发） */
  private readonly emitted = new Map<string, number>();
  /** 最近一次采样到的连接（config 刷新后要用它重建布局） */
  private lastConns: Connection[] = [];
  private seq = 0;
  private version = '';
  private started = false;
  private destroyed = false;
  private rafId = 0;
  private cfgTimer: ReturnType<typeof setInterval> | null = null;
  /** LiveStatService 的退订函数（reset 时换订） */
  private unsubLive: (() => void) | null = null;
  /** 已应用快照的时间戳（同一份快照只重排一次） */
  private lastApplied = 0;
  private ro: ResizeObserver | null = null;
  /** ① 列名册：ip → {mac,name}（拿不到就是空表，① 回落到按源 IP） */
  private clients: ClientMap = new Map<string, ClientInfo>();
  private clientsTimer: ReturnType<typeof setInterval> | null = null;
  /** 活跃边：上一轮采样算出的「最近有字节增长」的边（绿色点线） */
  private activeEdges: ReadonlySet<string> = new Set<string>();
  /** 活跃节点：同一条路径上的 ①..⑥ 节点（绿色描边） */
  private activeNodes: ReadonlySet<string> = new Set<string>();
  /** 活跃度状态（id → 累计字节；边/节点 → 活跃截止时间） */
  private actState: ActivityState = { totals: new Map(), until: new Map(), nodeUntil: new Map() };
  /** 右下角微型图：速率（上=↑up / 下=↓down）与内存缓冲（1s 一点，最近 MINI_POINTS 点） */
  readonly miniUp = signal<number[]>([]);
  readonly miniDown = signal<number[]>([]);
  readonly miniMem = signal<number[]>([]);
  /** 全屏态：铺满整个 web 页面（Esc / ✕ / ⛶ 退出） */
  readonly fs = signal(false);
  /**
   * 图的自适应模式：
   *  · '100'（默认，保持原行为）＝ 内容像素 1:1，画布超出容器时内部滚动
   *  · 'fit' ＝ 整幅图（含全部 band）等比缩放进可视容器，不滚动
   */
  readonly scaleMode = signal<'fit' | '100'>('100');
  /**
   * 视图模式：
   *  · false（普通视图，默认）＝ 全部链路按原浓度画，仅 hover 时高亮相关链路；
   *  · true（强调视图）＝ 有流量的连线/节点加粗提亮、其余压暗，hover 仍然优先。
   */
  readonly emphasis = signal(false);
  /** 微型图的两条 WebSocket 及其重连定时器 */
  private miniSockets: { ws: WebSocket | null; path: string; timer: ReturnType<typeof setTimeout> | null }[] = [];
  /** ⑤ 节点延时：tag → 末次测速 delay（ms）；拿不到就是空表，方格不画点 */
  private delays: DelayMap = new Map<string, number>();
  private delayTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrame = 0;

  readonly stats = computed(() => this.flow().stats);

  /** 微型图：速率双系列（镜像，上=↑ 下=↓）+ 内存单系列；空数据时给空数组（图表显示「等待数据」） */
  readonly rateSeries = computed<ChartSeries[]>(() => [
    { points: padPoints(this.miniUp(), MINI_POINTS), color: '#2f6fd0' },
    { points: padPoints(this.miniDown(), MINI_POINTS), color: '#0f8f9a' },
  ]);
  readonly memSeries = computed<ChartSeries[]>(() => [
    { points: padPoints(this.miniMem(), MINI_POINTS), color: '#8a5cd0' },
  ]);
  /** 速率标签：当前 ↓x/s ↑x/s */
  readonly rateLabel = computed(() => {
    const last = (arr: number[]): number => (arr.length ? arr[arr.length - 1] : 0);
    return { down: fmtRate(last(this.miniDown())), up: fmtRate(last(this.miniUp())) };
  });
  /** 内存标签：当前 inuse（字节 → 人类可读；这里是占用不是速率，不用 fmtMib） */
  readonly memLabel = computed(() => {
    const arr = this.miniMem();
    return fmtBytes(arr.length ? arr[arr.length - 1] : 0);
  });
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

  /**
   * 连线：普通视图按原浓度画；强调视图里有流量的线提亮加粗、其余压暗；
   * hover 时一律以 hover 为准（相关线亮、其余 0.08）。
   */
  readonly edgesView = computed<EdgeView[]>(() => {
    const h = this.hover();
    const emp = this.emphasis();
    return this.geom().edges.map((e) => {
      const hovered = !!h;
      const related = hovered && (e.from === h || e.to === h);
      const on = !hovered && emp && !!e.active;
      const off = !hovered && emp && !e.active;
      let opacity = e.opacity;
      let width = e.width;
      if (hovered) {
        // hover 一律优先：相关线正常浓度、其余压到 0.08
        opacity = related ? e.opacity : 0.08;
        if (related) width = e.width + 0.8;
      } else if (on) {
        opacity = Math.min(1, Math.max(e.opacity, 0.55) * 1.35);
        width = e.width + 0.45;
      } else if (off) {
        opacity = 0.18;
      }
      return { ...e, hi: related, dim: hovered && !related, emp: on, opacity, width };
    });
  });

  /** 节点块：hover 的节点与它的邻居高亮，其余变淡；强调视图里只亮有流量的节点；③④ 真实分组卡片标记可编辑 */
  readonly nodesView = computed<NodeView[]>(() => {
    const h = this.hover();
    const emp = this.emphasis();
    const near = new Set<string>();
    if (h) {
      near.add(h);
      for (const e of this.geom().edges) {
        if (e.from === h) near.add(e.to);
        if (e.to === h) near.add(e.from);
      }
    }
    // 可编辑判定用 config 名册：只有真实分组才弹编辑窗（实时兜底卡 / DIRECT 带不弹）
    const groupTags = new Set(this.stat().groups.map((g) => g.tag));
    return this.geom().nodes.map((n) => ({
      ...n,
      hi: n.key === h,
      dim: h ? !near.has(n.key) : emp ? !n.active : false,
      emp: !h && emp && !!n.active,
      edit:
        n.mode === 'card' &&
        ((n.col === 'rule' && groupTags.has(ruleGroupTag(n.key))) ||
          (n.col === 'group' && groupTags.has(nameOfKey(n.key)))),
    }));
  });

  /** tooltip（自绘 HTML 层，位置跟随指针，靠近右边/下边时收进来） */
  readonly tip = computed<{ x: number; y: number; text: string } | null>(() => {
    const key = this.hover();
    if (!key) return null;
    const node = this.geom().nodes.find((n) => n.key === key);
    if (!node) return null;
    const p = this.pointer();
    const g = this.geom();
    // fit 模式下 svg 被等比缩放、画布不可滚动 → 收边按可视区算；100% 按内容尺寸算
    const el = this.canvas()?.nativeElement as HTMLElement | undefined;
    const fit = this.scaleMode() === 'fit';
    const bw = fit ? Math.max(120, el?.clientWidth ?? g.w) : g.w;
    const bh = fit ? Math.max(80, el?.clientHeight ?? g.h) : g.h;
    return {
      x: Math.min(p.x + 14, Math.max(6, bw - 250)),
      y: Math.min(p.y + 16, Math.max(6, bh - 90)),
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
    // 共享连接快照：新快照就重排流向图（轮询由 LiveStatService 统一做，这里按 1.5s 订阅）
    effect(() => {
      const s = this.live.snap();
      const e = this.live.err();
      if (this.destroyed) return;
      if (e) this.err.set(e);
      if (!s || s.api !== this.backend()?.api) return;
      if (s.at === this.lastApplied) return;
      this.lastApplied = s.at;
      this.err.set('');
      this.lastConns = s.conns;
      this.apply(s.conns);
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
    this.unsubLive?.();
    this.unsubLive = null;
    if (this.cfgTimer) clearInterval(this.cfgTimer);
    if (this.clientsTimer) clearInterval(this.clientsTimer);
    if (this.delayTimer) clearInterval(this.delayTimer);
    this.closeMini();
    this.cfgTimer = null;
    this.clientsTimer = null;
    this.delayTimer = null;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.ro?.disconnect();
    this.ro = null;
    this.particles = [];
    this.seen.clear();
    this.emitted.clear();
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
    this.clients = new Map<string, ClientInfo>();
    this.delays = new Map<string, number>();
    this.activeEdges = new Set<string>();
    this.activeNodes = new Set<string>();
    this.actState = { totals: new Map(), until: new Map(), nodeUntil: new Map() };
    this.rebuild();
    this.startLoops();
    this.restartMini();
    void this.loadVersion(b);
    void this.loadClients(b);
    void this.loadDelays(b);
    void this.loadConfig(b);
    this.unsubLive?.();
    this.lastApplied = 0;
    this.unsubLive = this.live.subscribe(b, SAMPLE_MS);
  }

  /** 全屏开关（⛶ / ✕ / Esc 都走这里） */
  toggleFs(): void {
    this.fs.update((v) => !v);
  }

  /** 图缩放模式切换：100% ⇄ 自适应（按钮点击） */
  toggleScale(): void {
    this.scaleMode.update((m) => (m === 'fit' ? '100' : 'fit'));
  }

  /** 视图模式切换：普通视图 ⇄ 强调视图 */
  toggleEmphasis(): void {
    this.emphasis.update((v) => !v);
  }

  /** 退出全屏（Esc 用；已经在嵌入态就什么都不做） */
  exitFs(): void {
    if (this.fs()) this.fs.set(false);
  }

  /* ────────────────────────── 右下角微型图（clash ws） ────────────────────────── */

  /** 打开一条微型图 WebSocket：消息交给 onMsg，坏数据/单条失败都静默 */
  private openMiniWs(path: string, onMsg: (raw: string) => void): void {
    const entry: { ws: WebSocket | null; path: string; timer: ReturnType<typeof setTimeout> | null } = {
      ws: null,
      path,
      timer: null,
    };
    this.miniSockets.push(entry);
    const connect = (): void => {
      if (this.destroyed || !this.backend()?.api) return;
      try {
        const ws = new WebSocket(this.clash.wsUrl(this.backend(), path));
        entry.ws = ws;
        ws.onmessage = (ev) => {
          try {
            onMsg(String(ev.data));
          } catch {
            /* 单条消息解析失败忽略 */
          }
        };
        ws.onerror = () => {
          try {
            ws.close();
          } catch {
            /* 已经关了 */
          }
        };
        ws.onclose = () => {
          entry.ws = null;
          if (this.destroyed) return;
          if (entry.timer) clearTimeout(entry.timer);
          // 断线 3s 后重连（后端切换时 closeMini 会把定时器清掉）
          entry.timer = setTimeout(() => {
            entry.timer = null;
            connect();
          }, MINI_RETRY_MS);
        };
      } catch {
        /* WebSocket 构造失败（地址非法等）不打扰用户 */
      }
    };
    connect();
  }

  /** 关掉微型图的所有 socket 与重连定时器（换后端 / OnDestroy） */
  private closeMini(): void {
    for (const e of this.miniSockets.splice(0)) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
      const ws = e.ws;
      e.ws = null;
      if (ws) {
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          /* 已关闭 */
        }
      }
    }
  }

  /** 重开微型图 ws 并清空缓冲（换后端时用） */
  private restartMini(): void {
    this.closeMini();
    this.miniUp.set([]);
    this.miniDown.set([]);
    this.miniMem.set([]);
    this.openMiniWs('/traffic', (raw) => {
      const t = parseTrafficMsg(raw);
      if (!t) return;
      this.miniUp.update((a) => pushCapped(a, t.up, MINI_POINTS));
      this.miniDown.update((a) => pushCapped(a, t.down, MINI_POINTS));
    });
    this.openMiniWs('/memory', (raw) => {
      const m = parseMemoryMsg(raw);
      if (m === null) return;
      this.miniMem.update((a) => pushCapped(a, m, MINI_POINTS));
    });
  }

  /** 用当前连接 + 静态结构 + 名册重建六列（唯一出口，避免各处漏传 clients） */
  private rebuild(): void {
    this.flow.set(
      buildFlow(
        this.lastConns,
        this.stat(),
        this.clients,
        this.delays,
        this.activeEdges,
        this.activeNodes,
      ),
    );
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
    if (!this.clientsTimer) {
      this.clientsTimer = setInterval(() => {
        if (document.hidden || this.destroyed) return;
        void this.loadClients(this.backend());
      }, CLIENTS_MS);
    }
    if (!this.delayTimer) {
      this.delayTimer = setInterval(() => {
        if (document.hidden || this.destroyed) return;
        void this.loadDelays(this.backend());
      }, PROXIES_MS);
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
      this.rebuild();
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
      this.rebuild();
    } catch (e) {
      if (this.destroyed) return;
      const msg = errMsg(e);
      this.stat.set({ ...emptyStatic(name, this.versionLabel()), err: msg });
      this.cfgErr.set(`配置读取失败：${msg}`);
      this.rebuild();
    }
  }

  /**
   * 拉一次局域网名册 `GET /router/clients?host=` → ip→{mac,name}。
   * 用与 `/router/config` 同一套鉴权头（X-Vault-Key = 该后端的 clash 密钥）。
   * 失败/后端未更新一律静默：名册为空时 ① 完全回落到按源 IP 的老行为。
   */
  private async loadClients(b: Backend): Promise<void> {
    if (!b?.api) return;
    try {
      const resp = await firstValueFrom(
        this.http.get<RouterClientsResp>('/router/clients', {
          headers: new HttpHeaders({ 'X-Vault-Key': this.backends.keyFor(b) }),
          params: { host: this.router.host(b) },
        }),
      );
      if (this.destroyed) return;
      const map = new Map<string, ClientInfo>();
      for (const c of resp?.clients ?? []) {
        const ip = (c?.ip ?? '').trim();
        // 后端已小写；这里再兜一次，MAC 用作 ① 的分组 key
        const mac = (c?.mac ?? '').trim().toLowerCase();
        if (!ip || !mac) continue;
        map.set(ip, { mac, name: (c?.name ?? '').trim() });
      }
      this.clients = map;
      this.rebuild();
    } catch {
      // 接口失败 / 未部署：保留上一次名册（没有就是空表），不报错、不影响其它列
    }
  }

  /**
   * 拉一次 `clash_api /proxies` → tag→末次 delay（ms）。
   * 每个出站的 `history` 是测速记录数组，取最后一条的 delay；<=0 或缺 history 视为未测速。
   * 失败静默：保留上一次的延时（首次为空表 → 方格不画点），不影响其它列。
   */
  private async loadDelays(b: Backend): Promise<void> {
    if (!b?.api) return;
    try {
      const resp = await this.clash.proxies(b);
      if (this.destroyed) return;
      const map = new Map<string, number>();
      for (const [tag, p] of Object.entries(resp?.proxies ?? {})) {
        const h = p?.history;
        const last = h && h.length ? Number(h[h.length - 1]?.delay) : NaN;
        if (Number.isFinite(last)) map.set(tag, last as number);
      }
      this.delays = map;
      this.rebuild();
    } catch {
      // /proxies 拿不到（旧版引擎 / 网络抖动）：保留旧延时，不报错
    }
  }

  /** ②列次行文案：sing-box + 引擎版本（版本没拿到就只写 sing-box） */
  private versionLabel(): string {
    return this.version ? `sing-box ${this.version}` : 'sing-box';
  }

  /** 归并布局 + 给「第一次见到」的连接生成粒子 */
  private apply(conns: Connection[]): void {
    const now = Date.now();
    // 先用本次连接 + 最新路径推活跃度（路径来自这次的 flow.sample，天然无延迟），再贴回 flow
    const base = buildFlow(conns, this.stat(), this.clients, this.delays);
    const paths = new Map(base.sample.map((s) => [s.id, s.path]));
    const prevTotals = this.actState.totals;
    const connById = new Map(conns.map((c) => [c.id, c]));
    const step = stepActivity(conns, paths, this.actState, now, IDLE_MS);
    this.actState = { totals: step.totals, until: step.until, nodeUntil: step.nodeUntil };
    this.activeEdges = step.active;
    this.activeNodes = step.activeNodes;
    // 活跃边（绿点线）+ 活跃节点（绿描边）一起贴；闲置的节点/边保持原样式
    const flow = markActive(base, { edges: step.active, nodes: step.activeNodes });
    this.flow.set(flow);
    const live = new Set<string>();
    for (const s of flow.sample) {
      live.add(s.id);
      // 只有「活跃」连接才发鱼：本次累计字节比上次增长（或首次见到）才发；
      // 闲置连接不再发鱼，存量鱼游完即消失 → 绿点活跃链路上才有鱼游
      const c = connById.get(s.id);
      const prev = prevTotals.get(s.id);
      const grew = prev === undefined ? true : !!c && trafficTotal(c) > prev;
      const le = this.emitted.get(s.id);
      if (grew && (le === undefined || now - le > REEMIT_MS)) {
        this.spawn(s.path, s.kind);
        // 首次发鱼给随机相位偏移，避免活跃连接同相位形成「一波一波」鱼群
        this.emitted.set(s.id, le === undefined ? now - Math.random() * REEMIT_MS : now);
      }
      this.seen.set(s.id, now);
    }
    // 已经断开的连接：超过 SEEN_TTL_MS 没再出现就忘掉 id（防止 Map 无限增长）
    for (const [id, at] of [...this.seen]) {
      if (!live.has(id) && now - at > SEEN_TTL_MS) {
        this.seen.delete(id);
        this.emitted.delete(id);
      }
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
    const out: Fish[] = [];
    for (const p of keep) {
      const at = pointOnPath(p.keys, p.t, g);
      if (!at) continue;
      const t = p.t;
      const opacity = t < 0.08 ? t / 0.08 : t > 0.86 ? Math.max(0, (1 - t) / 0.14) : 1;
      // 朝向 = 路径切线（鱼头朝前进方向）；直连/拦截画小一点，代理略大
      const a = round1(tangentOnPath(p.keys, t, g));
      const s = p.kind === 'proxy' ? 1 : 0.86;
      out.push({
        n: p.n,
        x: round1(at.x),
        y: round1(at.y),
        a,
        s,
        opacity: round1(opacity),
        kind: p.kind,
        // 负延时：同一帧里不同小鱼摆尾相位错开
        delay: `${-(p.n % 7) * 0.07}s`,
      });
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

  /**
   * 点 ③④ 卡片 → 抛编辑事件（backend-pane 接去开弹窗）。
   * 只处理「可编辑」节点（config 里真实分组的卡片）；hover 逻辑不受影响。
   * groupTag 从 key 解析（label 会被列宽截断，key 才是全名）：
   *  · ③ `rule:分组名[桶 …]` → '[' 前缀；④ `group:分组名` → 名即 tag。
   */
  onNodeClick(n: NodeView): void {
    if (!n.edit) return;
    if (n.col === 'rule') this.editRule.emit(ruleGroupTag(n.key));
    else if (n.col === 'group') this.editGroup.emit(nameOfKey(n.key));
  }

  private trackPointer(ev: MouseEvent): void {
    const el = this.canvas()?.nativeElement;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // tooltip 是 canvas 的绝对定位子元素：
    //  · 100%：canvas 可纵向滚动 → 换算到内容坐标（随滚动一起走）
    //  · fit：整图被等比缩放进可视区、不滚动 → 直接用画布可视坐标（不会因为缩放跑偏）
    const fit = this.scaleMode() === 'fit';
    this.pointer.set({
      x: Math.round(ev.clientX - r.left + (fit ? 0 : el.scrollLeft)),
      y: Math.round(ev.clientY - r.top + (fit ? 0 : el.scrollTop)),
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