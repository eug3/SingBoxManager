/**
 * overview —— 概览子页：单路由的实时曲线与网络状态（参考 zashboard 概览页）。
 *  - 三条曲线：速率（↓/↑ 上下镜像）/ 连接数 / 内存使用，clash WebSocket 1s 采样，
 *    每 2 秒聚成一格，窗口 1/5/10 分钟可选，曲线 / 柱形两种画法；
 *  - hist 缓存：四条曲线 + 视图偏好每 2s 写入 localStorage（按路由主机隔离），
 *    切 tab 回来即恢复不空白；超过 10 分钟的陈旧缓存整段丢弃；
 *  - 带宽可编辑：手填线路带宽（Mib/s）作为速率图固定满量程基准并持久化，
 *    也可切换为按窗口内峰值自适应；
 *  - 模式切换：Rule / Global / Direct（PATCH /configs，唯一运行时写操作，需确认）；
 *  - 分组延时速览：各分组当前节点与延迟，支持全部测速（并发 6）。
 */
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  WritableSignal,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { AreaChartComponent, ChartSeries } from './area-chart';
import { Backend, ProxyNode } from './models';
import { ClashService } from './clash.service';
import { fmtBytes, fmtMib, fmtRate, latClass, latText, mibToBytes, runPool } from './util';

const MAX_POINTS = 600; // 原始 1s 采样缓冲 = 10 分钟
const BUCKET_SECONDS = 2; // 图形窗口按 2 秒一格填充（10 分钟 = 300 格）
/** 速率图默认满量程带宽：1000 Mib/s（千兆，1 Mib = 2^20 bit） */
const DEFAULT_BANDWIDTH_MIB = 1000;
/** 手填带宽的 localStorage 持久化键 */
const BW_STORE_KEY = 'rateBandwidthMib';

/** 可选窗口时长（分钟） */
const WINDOW_OPTIONS = [1, 5, 10];

@Component({
  selector: 'app-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AreaChartComponent],
  templateUrl: './overview.html',
})
export class OverviewPane implements OnInit, OnDestroy {
  /** 当前后端（曲线数据源，也是 hist 缓存的隔离依据） */
  readonly backend = input.required<Backend>();

  /** clash_api 客户端：WebSocket 采样与 REST 读写 */
  private readonly clash = inject(ClashService);

  /** 下载速率原始采样（1s 一点，环形保留最近 MAX_POINTS 个） */
  readonly downPts = signal<number[]>([]);
  /** 上传速率原始采样 */
  readonly upPts = signal<number[]>([]);
  /** 连接数原始采样 */
  readonly connPts = signal<number[]>([]);
  /** 内存使用原始采样 */
  readonly memPts = signal<number[]>([]);
  /** 当前下载速率（字节/秒，主读数） */
  readonly rateDown = signal(0);
  /** 当前上传速率（字节/秒，主读数） */
  readonly rateUp = signal(0);
  /** 当前活跃连接数（主读数） */
  readonly connCount = signal(0);
  /** 当前内存占用（字节，主读数） */
  readonly memInuse = signal(0);
  /** 累计流量 ↓/↑（字节） */
  readonly totals = signal({ down: 0, up: 0 });
  /** 当前路由模式（Rule/Global/Direct） */
  readonly mode = signal('');
  /** 可选模式列表（默认三个，后端 mode-list 可覆盖） */
  readonly modeList = signal<string[]>(['Rule', 'Global', 'Direct']);
  /** 分组列表（Selector/URLTest，延时速览用） */
  readonly groups = signal<ProxyNode[]>([]);
  /** 当前图形窗口（分钟） */
  readonly windowMin = signal(10);
  /** 窗口时长选项（1/5/10 分钟） */
  readonly windowOptions = WINDOW_OPTIONS;
  /** 曲线 / 柱形 两种画法（速率图柱形模式以上下镜像呈现：上=下载、下=上传） */
  readonly chartMode = signal<'line' | 'bar'>('line');
  /** 速率图刻度：固定（按手填带宽满量程，默认千兆）或按窗口内峰值自适应 */
  readonly rateScale = signal<'fixed' | 'auto'>('fixed');
  /** 手填带宽，单位 Mib/s（1 Mib = 2^20 bit），持久化在 localStorage */
  readonly bandwidth = signal<number>(this.loadBandwidth());
  /** 固定满量程上限（字节/秒）：仅固定刻度时生效，自适应时为 undefined 交给图表 */
  readonly rateFixedMax = computed(() =>
    this.rateScale() === 'fixed' ? mibToBytes(Math.max(1, this.bandwidth())) : undefined,
  );
  /** 节点延迟表：名称 → 毫秒（history 尾部 + 手动测速结果） */
  readonly nodeLat = signal<Record<string, number>>({});
  /** 「全部测速」是否进行中 */
  readonly testing = signal(false);
  /** 测速进度文案（已完成/总数） */
  readonly testProgress = signal('');
  /** 错误横幅文案（WebSocket / REST 失败） */
  readonly err = signal('');
  /** 当前页面来源（网络信息展示） */
  readonly origin = location.origin;

  /** 已打开的 clash WebSocket（销毁时统一关闭） */
  private readonly sockets: WebSocket[] = [];
  /** 分组轮询定时器（5s 一次） */
  private timer: ReturnType<typeof setInterval> | null = null;
  /** hist 落盘定时器（2s 一次） */
  private histTimer: ReturnType<typeof setInterval> | null = null;

  /** 速率历史缓存键（按路由主机区分，存 localStorage，切 tab 不丢曲线） */
  private readonly histKey = computed(() => {
    try {
      return 'sbmHist:' + new URL(this.backend().api).hostname;
    } catch {
      return 'sbmHist:' + this.backend().api;
    }
  });

  /** 窗口格数 = 窗口秒数 / 2（10 分钟 → 300 格） */
  bucketCount = computed(() => Math.round((this.windowMin() * 60) / BUCKET_SECONDS));

  /**
   * 固定长度格数组：一上来就是「格数」个空位（10 分钟 = 300 格），
   * 原始 1s 采样每 2 秒聚成一格，**靠右填入**并随时间往前推（满窗后最左的格被挤出）。
   */
  private bucketize(raw: number[]): (number | null)[] {
    const n = this.bucketCount();
    const need = n * BUCKET_SECONDS;
    const slice = raw.slice(-need);
    const filled: number[] = [];
    for (let i = 0; i < slice.length; i += BUCKET_SECONDS) {
      const chunk = slice.slice(i, i + BUCKET_SECONDS);
      filled.push(chunk.reduce((a, b) => a + b, 0) / chunk.length);
    }
    const out: (number | null)[] = new Array<number | null>(n).fill(null);
    const start = n - filled.length;
    for (let i = 0; i < filled.length; i++) out[start + i] = filled[i];
    return out;
  }

  /** 下载速率曲线（分格聚合后） */
  private readonly downSeries = computed(() => this.bucketize(this.downPts()));
  /** 上传速率曲线（分格聚合后） */
  private readonly upSeries = computed(() => this.bucketize(this.upPts()));
  /** 连接数曲线（分格聚合后） */
  private readonly connSeriesPts = computed(() => this.bucketize(this.connPts()));
  /** 内存曲线（分格聚合后） */
  private readonly memSeriesPts = computed(() => this.bucketize(this.memPts()));

  /** 速率图系列：下载（蓝）/ 上传（绿），柱形模式上下镜像 */
  readonly rateSeries = computed<ChartSeries[]>(() => [
    { points: this.downSeries(), color: '#1f6fd0' },
    { points: this.upSeries(), color: '#0f8f68' },
  ]);
  /** 连接数图系列（紫） */
  readonly connSeries = computed<ChartSeries[]>(() => [{ points: this.connSeriesPts(), color: '#8a6bd1' }]);
  /** 内存图系列（棕） */
  readonly memSeries = computed<ChartSeries[]>(() => [{ points: this.memSeriesPts(), color: '#a8690a' }]);

  /** 窗口标签文案：近 N 分钟 */
  windowLabel(): string {
    return '近 ' + this.windowMin() + ' 分钟';
  }

  /** 已填入数据的格数（< bucketCount 时空格在左侧，数据贴右侧） */
  sampleCount(): number {
    return this.connSeriesPts().filter((v) => v !== null).length;
  }

  /** 分格说明文案：每 2 秒 1 格 × 格数 */
  bucketText(): string {
    return '每 2 秒 1 格 × ' + this.bucketCount();
  }

  /** 初始化：恢复 hist 缓存 → 拉静态信息 → 开三条采样 WebSocket → 启动分组轮询与 hist 落盘 */
  ngOnInit(): void {
    this.loadHist(); // 先恢复上次的曲线，切 tab 回来不空白
    void this.loadStatic();
    this.openWs('/traffic', (raw) => {
      const m = JSON.parse(raw) as { up?: number; down?: number };
      this.rateDown.set(m.down ?? 0);
      this.rateUp.set(m.up ?? 0);
      this.push(this.downPts, m.down ?? 0);
      this.push(this.upPts, m.up ?? 0);
    });
    this.openWs('/memory', (raw) => {
      const m = JSON.parse(raw) as { inuse?: number };
      this.memInuse.set(m.inuse ?? 0);
      this.push(this.memPts, m.inuse ?? 0);
    });
    this.openWs('/connections', (raw) => {
      const m = JSON.parse(raw) as { connections?: unknown[]; downloadTotal?: number; uploadTotal?: number };
      const n = m.connections?.length ?? 0;
      this.connCount.set(n);
      this.totals.set({ down: m.downloadTotal ?? 0, up: m.uploadTotal ?? 0 });
      this.push(this.connPts, n);
    });
    this.timer = setInterval(() => void this.loadGroups(), 5000);
    this.histTimer = setInterval(() => this.saveHist(), 2000); // 每 2s 落盘一次历史
  }

  /** 清理：再落盘一次 hist，停两个定时器，关闭全部 WebSocket 并解绑回调 */
  ngOnDestroy(): void {
    this.saveHist(); // 离开前再存一次，保证切 tab 时是最新的
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.histTimer) clearInterval(this.histTimer);
    this.histTimer = null;
    for (const ws of this.sockets.splice(0)) {
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* 忽略关闭异常 */
      }
    }
  }

  /**
   * 从 localStorage 恢复四条曲线（最近 MAX_POINTS=600 个 1s 采样 = 10 分钟 = 300 格）。
   * 超过 10 分钟的旧数据已整段滑出窗口，直接丢弃避免把陈旧数据当当前显示。
   */
  private loadHist(): void {
    try {
      const raw = localStorage.getItem(this.histKey());
      if (!raw) return;
      const h = JSON.parse(raw) as { t?: number; down?: number[]; up?: number[]; conn?: number[]; mem?: number[]; win?: number; mode?: 'line' | 'bar' };
      if (!h?.t || Date.now() - h.t > MAX_POINTS * 1000) return;
      const cap = (a?: number[]) => (Array.isArray(a) ? a.slice(-MAX_POINTS) : []);
      this.downPts.set(cap(h.down));
      this.upPts.set(cap(h.up));
      this.connPts.set(cap(h.conn));
      this.memPts.set(cap(h.mem));
      if (h.win !== undefined && WINDOW_OPTIONS.includes(h.win)) this.windowMin.set(h.win);
      if (h.mode === 'line' || h.mode === 'bar') this.chartMode.set(h.mode);
    } catch {
      /* 缓存损坏忽略，从空白开始 */
    }
  }

  /** 把四条曲线 + 视图偏好写入 localStorage（按主机隔离） */
  private saveHist(): void {
    try {
      localStorage.setItem(
        this.histKey(),
        JSON.stringify({
          t: Date.now(),
          down: this.downPts(),
          up: this.upPts(),
          conn: this.connPts(),
          mem: this.memPts(),
          win: this.windowMin(),
          mode: this.chartMode(),
        }),
      );
    } catch {
      /* 存储满 / 隐私模式忽略 */
    }
  }

  /** 追加一个 1s 采样点，环形保留最近 MAX_POINTS 个 */
  private push(target: WritableSignal<number[]>, v: number): void {
    target.update((arr) => [...arr, v].slice(-MAX_POINTS));
  }

  /** 打开一条 clash WebSocket（/traffic /memory /connections），单条解析失败不影响后续 */
  private openWs(path: string, onMessage: (msg: string) => void): void {
    try {
      const ws = new WebSocket(this.clash.wsUrl(this.backend(), path));
      ws.onmessage = (ev) => {
        try {
          onMessage(String(ev.data));
        } catch {
          /* 单条消息解析失败忽略 */
        }
      };
      ws.onerror = () => this.err.set(`无法连接 ${path} WebSocket（密钥 / 跨域 / 后端不可达？）`);
      this.sockets.push(ws);
    } catch (e) {
      this.err.set(`无法连接 ${path}：${(e as Error)?.message ?? e}`);
    }
  }

  /** 拉静态信息：当前模式与模式列表（GET /configs），随后拉一次分组 */
  private async loadStatic(): Promise<void> {
    try {
      const cfg = await this.clash.configs(this.backend());
      this.mode.set(cfg?.mode ?? '');
      if (cfg?.['mode-list']?.length) this.modeList.set(cfg['mode-list']);
      await this.loadGroups();
    } catch (e) {
      this.err.set((e as Error)?.message ?? String(e));
    }
  }

  /** 拉分组与各节点最新延迟（5s 轮询 + 手动刷新）；失败静默，不打断曲线 */
  async loadGroups(): Promise<void> {
    try {
      const res = await this.clash.proxies(this.backend());
      const map = res?.proxies ?? {};
      const lat: Record<string, number> = {};
      for (const p of Object.values(map)) {
        if (p.type === 'Selector' || p.type === 'URLTest') continue;
        const h = p.history ?? [];
        if (h.length) lat[p.name] = h[h.length - 1].delay ?? 0;
      }
      // 保留手动测速结果（比 history 新）
      for (const [name, d] of Object.entries(this.nodeLat())) if (lat[name] === undefined) lat[name] = d;
      this.nodeLat.set(lat);
      this.groups.set(Object.values(map).filter((p) => p.type === 'Selector' || p.type === 'URLTest'));
    } catch {
      /* 概览面板核心是曲线，分组失败不打断 */
    }
  }

  /** 切换路由模式（PATCH /configs）：需确认；失败弹窗提示且保持原模式 */
  async setMode(mode: string): Promise<void> {
    if (mode === this.mode()) return;
    if (!confirm(`把路由模式切到 ${mode}？（影响整台路由的全局分流，可随时切回）`)) return;
    try {
      await this.clash.setMode(this.backend(), mode);
      this.mode.set(mode);
    } catch (e) {
      alert('切换失败：' + ((e as Error)?.message ?? e));
    }
  }

  /** 全部测速：收集分组引用的全部非分组节点，并发 6 测延迟，结果存 nodeLat */
  async testAll(): Promise<void> {
    if (this.testing()) return;
    this.testing.set(true);
    try {
      const res = await this.clash.proxies(this.backend());
      const map = res?.proxies ?? {};
      const names = [...new Set(this.groups().flatMap((g) => g.all ?? []))].filter(
        (n) => map[n] && map[n].type !== 'Selector' && map[n].type !== 'URLTest',
      );
      // 并发 6 逐节点测延迟（runPool 见 util.ts），结果存 nodeLat
      let done = 0;
      await runPool(names, 6, async (name) => {
        let d = 0;
        try {
          d = await this.clash.delay(this.backend(), name);
        } catch {
          d = 0; // 超时/不可达记 0
        }
        this.nodeLat.update((m) => ({ ...m, [name]: d }));
        done++;
        this.testProgress.set(`${done}/${names.length}`);
      });
    } finally {
      this.testing.set(false);
      this.testProgress.set('');
    }
  }

  /** 取指定节点的延迟（未测过为 null） */
  lat(name: string | undefined): number | null {
    if (!name) return null;
    const d = this.nodeLat()[name];
    return d === undefined ? null : d;
  }

  /** 延迟着色 class（模板包装，实现见 util.latClass） */
  latClass(d: number | null): string {
    return latClass(d);
  }

  /** 延迟文案（模板包装，未测显示 —，实现见 util.latText） */
  latText(d: number | null): string {
    return latText(d, '—');
  }

  /** 字节/秒 → Mib/s 主读数（util.fmtMib） */
  rateTextMib(n: number): string {
    return fmtMib(n);
  }

  /** 从 localStorage 读手填带宽；缺失 / 非法时回退默认千兆 */
  private loadBandwidth(): number {
    const raw = Number(localStorage.getItem(BW_STORE_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BANDWIDTH_MIB;
  }

  /** 手填带宽（Mib/s）；空/非法值回退当前值 */
  setBandwidth(v: string): void {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return;
    const clamped = Math.min(1_000_000, Math.max(1, n));
    this.bandwidth.set(clamped);
    localStorage.setItem(BW_STORE_KEY, String(clamped));
    if (this.rateScale() === 'auto') this.rateScale.set('fixed');
  }

  /** 当前速率占带宽的百分比 */
  utilization(n: number): string {
    const bw = Math.max(1, this.bandwidth());
    const pct = ((n * 8) / (1024 * 1024) / bw) * 100;
    if (!pct) return '0%';
    return pct < 10 ? pct.toFixed(1) + '%' : Math.round(pct) + '%';
  }

  /** 速率文案（模板包装，实现见 util.fmtRate） */
  rateText(n: number): string {
    return fmtRate(n);
  }

  /** 内存主读数：字节 → MB（一位小数），0 显示 — */
  memText(): string {
    const n = this.memInuse();
    return n ? (n / 1024 / 1024).toFixed(1) + ' MB' : '—';
  }

  /** 字节数格式化（模板包装，实现见 util.fmtBytes） */
  fmtB(n: number): string {
    return fmtBytes(n);
  }

  /** 分组成员数 */
  groupCount(g: ProxyNode): number {
    return g.all?.length ?? 0;
  }
}