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

const MAX_POINTS = 600; // 原始 1s 采样缓冲 = 10 分钟
const BUCKET_SECONDS = 2; // 图形窗口按 2 秒一格填充（10 分钟 = 300 格）
const WINDOW_OPTIONS = [1, 5, 10];
const OK_GREEN = 400;
const OK_YELLOW = 800;

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
  readonly nodeLat = signal<Record<string, number>>({});
  readonly testing = signal(false);
  readonly testProgress = signal('');
  readonly err = signal('');
  readonly origin = location.origin;

  private readonly sockets: WebSocket[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 窗口格数 = 窗口秒数 / 2（10 分钟 → 300 格） */
  bucketCount = computed(() => Math.round((this.windowMin() * 60) / BUCKET_SECONDS));

  /**
   * 把原始 1s 采样填进 2 秒一格：先截最近「格数 × 2」个样本，
   * 再逐格取平均（末尾不足 2 个样本时用实际样本平均），保证格数与窗口严格对应。
   */
  private bucketize(raw: number[]): number[] {
    const need = this.bucketCount() * BUCKET_SECONDS;
    const slice = raw.slice(-need);
    const out: number[] = [];
    for (let i = 0; i < slice.length; i += BUCKET_SECONDS) {
      const chunk = slice.slice(i, i + BUCKET_SECONDS);
      out.push(chunk.reduce((a, b) => a + b, 0) / chunk.length);
    }
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

  /** 已填满的格数（尚未满窗时小于 bucketCount） */
  sampleCount(): number {
    return this.connSeriesPts().length;
  }

  bucketText(): string {
    return '每 2 秒 1 格 × ' + this.bucketCount();
  }

  ngOnInit(): void {
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
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  private push(target: WritableSignal<number[]>, v: number): void {
    target.update((arr) => [...arr, v].slice(-MAX_POINTS));
  }

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
      const queue = [...names];
      let done = 0;
      const work = async () => {
        for (;;) {
          const name = queue.shift();
          if (!name) return;
          let d = 0;
          try {
            d = await this.clash.delay(this.backend(), name);
          } catch {
            d = 0;
          }
          this.nodeLat.update((m) => ({ ...m, [name]: d }));
          done++;
          this.testProgress.set(`${done}/${names.length}`);
        }
      };
      await Promise.all(Array.from({ length: 6 }, () => work()));
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
    if (d === null) return 'na';
    if (d <= 0) return 'r';
    if (d < OK_GREEN) return 'g';
    if (d < OK_YELLOW) return 'y';
    return 'r';
  }

  latText(d: number | null): string {
    if (d === null) return '—';
    if (d <= 0) return '✗';
    return d >= 1000 ? (d / 1000).toFixed(1) + 's' : d + 'ms';
  }

  rateText(n: number): string {
    if (!n) return '0B/s';
    if (n < 1024) return n + 'B/s';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K/s';
    return (n / 1024 / 1024).toFixed(2) + 'M/s';
  }

  memText(): string {
    const n = this.memInuse();
    return n ? (n / 1024 / 1024).toFixed(1) + ' MB' : '—';
  }

  fmtB(n: number): string {
    if (!n || n < 0) return '0B';
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'K';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'M';
    return (n / 1024 / 1024 / 1024).toFixed(2) + 'G';
  }

  groupCount(g: ProxyNode): number {
    return g.all?.length ?? 0;
  }
}