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
const BW_STORE_KEY = 'rateBandwidthMib';

const WINDOW_OPTIONS = [1, 5, 10];

/** 概览：速率 / 连接数 / 内存曲线 + 分组延时速览 + 网络信息（参考 zashboard 概览页） */
@Component({
  selector: 'app-overview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AreaChartComponent],
  templateUrl: './overview.html',
})
export class OverviewPane implements OnInit, OnDestroy {
  readonly backend = input.required<Backend>();

  private readonly clash = inject(ClashService);

  readonly downPts = signal<number[]>([]);
  readonly upPts = signal<number[]>([]);
  readonly connPts = signal<number[]>([]);
  readonly memPts = signal<number[]>([]);
  readonly rateDown = signal(0);
  readonly rateUp = signal(0);
  readonly connCount = signal(0);
  readonly memInuse = signal(0);
  readonly totals = signal({ down: 0, up: 0 });
  readonly mode = signal('');
  readonly modeList = signal<string[]>(['Rule', 'Global', 'Direct']);
  readonly groups = signal<ProxyNode[]>([]);
  readonly windowMin = signal(10);
  readonly windowOptions = WINDOW_OPTIONS;
  /** 曲线 / 柱形 两种画法（速率图柱形模式以上下镜像呈现：上=下载、下=上传） */
  readonly chartMode = signal<'line' | 'bar'>('line');
  /** 速率图刻度：固定（按手填带宽满量程，默认千兆）或按窗口内峰值自适应 */
  readonly rateScale = signal<'fixed' | 'auto'>('fixed');
  /** 手填带宽，单位 Mib/s（1 Mib = 2^20 bit），持久化在 localStorage */
  readonly bandwidth = signal<number>(this.loadBandwidth());
  readonly rateFixedMax = computed(() =>
    this.rateScale() === 'fixed' ? mibToBytes(Math.max(1, this.bandwidth())) : undefined,
  );
  readonly nodeLat = signal<Record<string, number>>({});
  readonly testing = signal(false);
  readonly testProgress = signal('');
  readonly err = signal('');
  readonly origin = location.origin;

  private readonly sockets: WebSocket[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
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

  private readonly downSeries = computed(() => this.bucketize(this.downPts()));
  private readonly upSeries = computed(() => this.bucketize(this.upPts()));
  private readonly connSeriesPts = computed(() => this.bucketize(this.connPts()));
  private readonly memSeriesPts = computed(() => this.bucketize(this.memPts()));

  readonly rateSeries = computed<ChartSeries[]>(() => [
    { points: this.downSeries(), color: '#1f6fd0' },
    { points: this.upSeries(), color: '#0f8f68' },
  ]);
  readonly connSeries = computed<ChartSeries[]>(() => [{ points: this.connSeriesPts(), color: '#8a6bd1' }]);
  readonly memSeries = computed<ChartSeries[]>(() => [{ points: this.memSeriesPts(), color: '#a8690a' }]);

  windowLabel(): string {
    return '近 ' + this.windowMin() + ' 分钟';
  }

  /** 已填入数据的格数（< bucketCount 时空格在左侧，数据贴右侧） */
  sampleCount(): number {
    return this.connSeriesPts().filter((v) => v !== null).length;
  }

  bucketText(): string {
    return '每 2 秒 1 格 × ' + this.bucketCount();
  }

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
        /* ignore */
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
      if (h.win === 1 || h.win === 5 || h.win === 10) this.windowMin.set(h.win);
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
          d = 0;
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

  lat(name: string | undefined): number | null {
    if (!name) return null;
    const d = this.nodeLat()[name];
    return d === undefined ? null : d;
  }

  latClass(d: number | null): string {
    return latClass(d);
  }

  latText(d: number | null): string {
    return latText(d, '—');
  }

  /** 字节/秒 → Mib/s 主读数（util.fmtMib） */
  rateTextMib(n: number): string {
    return fmtMib(n);
  }

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

  rateText(n: number): string {
    return fmtRate(n);
  }

  memText(): string {
    const n = this.memInuse();
    return n ? (n / 1024 / 1024).toFixed(1) + ' MB' : '—';
  }

  fmtB(n: number): string {
    return fmtBytes(n);
  }

  groupCount(g: ProxyNode): number {
    return g.all?.length ?? 0;
  }
}