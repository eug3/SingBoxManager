import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  effect,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Backend, Connection, PAGE_ORIGINS, ProxyNode, RuleEntry } from './models';
import { BackendsService } from './backends.service';
import { OverviewPane } from './overview';
import { ConfigPane } from './config-pane';
import { ClashService } from './clash.service';
import { fmtBytes, latClass, latText, runPool } from './util';

/** 后端子页签 */
type PaneTab = 'overview' | 'groups' | 'connections' | 'logs' | 'rules' | 'config';
interface LogLine {
  type: string;
  text: string;
}

@Component({
  selector: 'app-backend-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverviewPane, ConfigPane],
  templateUrl: './backend-pane.html',
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
    .bp-head {
      flex: 0 0 auto;
    }
    .bp-body {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
      padding-right: 2px;
    }
  `,
})
/**
 * 后端面板 — 一台路由的六个子页：概览 / 分组与节点 / 连接 / 日志 / 规则 / 配置。
 * 概览与配置是独立组件；本组件持有其余四个子页的状态与 clash_api 交互。
 */
export class BackendPane implements OnInit, OnDestroy {
  readonly backend = input.required<Backend>();
  readonly index = input.required<number>();
  readonly removed = output<void>();

  private readonly bsvc = inject(BackendsService);
  private readonly clash = inject(ClashService);

  readonly tab = signal<PaneTab>('overview');
  readonly tabs: { key: PaneTab; label: string }[] = [
    { key: 'overview', label: '概览' },
    { key: 'groups', label: '分组与节点' },
    { key: 'connections', label: '连接' },
    { key: 'logs', label: '日志' },
    { key: 'rules', label: '规则' },
    { key: 'config', label: '配置' },
  ];

  readonly version = signal('');
  readonly proxyMap = signal<Record<string, ProxyNode>>({});
  readonly conns = signal<Connection[]>([]);
  readonly rules = signal<RuleEntry[]>([]);
  readonly loadErr = signal('');
  readonly unauthorized = signal(false);

  readonly filter = signal('');
  /** 连接年龄过滤阈值（秒）：0=全部，其余=只看存活≥该秒数的（用来揪疑似僵死的老连接） */
  readonly ageFilter = signal(0);
  /** 当前时刻（每 3s 随刷新推进），用于实时计算连接存活时长 */
  readonly now = signal(Date.now());
  /** 只看「空转」连接（≥60s 没有任何字节增长） */
  readonly idleOnly = signal(false);
  /** 每条连接的「最近一次字节变化时刻」：id → 毫秒。用于区分长连接（仍在跑数据）与空转/僵死 */
  private readonly lastMove = new Map<string, number>();
  readonly autoRefresh = signal(true);
  readonly paused = signal(false);
  readonly level = signal('info');
  readonly logLines = signal<LogLine[]>([]);
  readonly testing = signal(false);
  readonly testProgress = signal('');
  readonly cfgOpen = signal(false);
  readonly cfgMsg = signal('');
  readonly origins = PAGE_ORIGINS;
  readonly levels = ['debug', 'info', 'warn', 'error'];

  readonly cfgName = linkedSignal(() => this.backend().name);
  readonly cfgApi = linkedSignal(() => this.backend().api);
  readonly cfgKey = linkedSignal(() => this.backend().key);

  private readonly logBox = viewChild<ElementRef<HTMLDivElement>>('logbox');
  private timer: ReturnType<typeof setInterval> | null = null;
  private ws: WebSocket | null = null;
  private stickToBottom = true;

  readonly groupList = computed(() =>
    Object.values(this.proxyMap()).filter((p) => p.type === 'Selector' || p.type === 'URLTest'),
  );
  readonly nodes = computed(() => Object.keys(this.proxyMap()).length);
  readonly totalDown = computed(() => this.conns().reduce((n, c) => n + (c.download ?? 0), 0));
  readonly totalUp = computed(() => this.conns().reduce((n, c) => n + (c.upload ?? 0), 0));
  /** 当前筛选命中的全部连接（不受 120 条显示上限影响，批量断开用） */
  readonly matchedConns = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const minAge = this.ageFilter();
    const now = this.now();
    let list = this.conns();
    if (minAge > 0) list = list.filter((c) => this.ageOf(c, now) >= minAge);
    if (this.idleOnly()) list = list.filter((c) => this.idleSec(c, now) >= 60);
    if (q) list = list.filter((c) => this.connText(c).includes(q));
    return list;
  });

  /** 表格显示用（最多 120 行） */
  readonly filteredConns = computed(() => this.matchedConns().slice(0, 120));

  /** 连接总览：总数 / 最老存活 / ≥5分钟的老连接数（疑似僵死候选） */
  readonly connStats = computed(() => {
    const now = this.now();
    const list = this.conns();
    let oldest = 0;
    let old = 0;
    let idleOld = 0;
    for (const c of list) {
      const a = this.ageOf(c, now);
      if (a > oldest) oldest = a;
      if (a >= 300) {
        old++;
        if (this.idleSec(c, now) >= 60) idleOld++;
      }
    }
    return { total: list.length, oldest, old, idleOld };
  });

  constructor() {
    // 密钥/后端地址变化时自动重新拉取（连接页填入全局密钥后也能立刻生效）
    effect(() => {
      const b = this.backend();
      this.bsvc.globalKey();
      if (this.bsvc.valid(b)) void this.load();
    });
  }

  ngOnInit(): void {
    this.timer = setInterval(() => {
      if (document.hidden) return;
      this.now.set(Date.now()); // 推进连接年龄
      if (this.tab() === 'connections' && this.autoRefresh()) void this.refreshConns();
    }, 3000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopLogs();
  }

  /** 首屏三连拉：版本 / 分组节点 / 连接（401 单独提示填密钥） */
  async load(): Promise<void> {
    this.loadErr.set('');
    this.unauthorized.set(false);
    if (!this.bsvc.valid(this.backend())) {
      this.loadErr.set('该后端还没配置地址：点「⚙ 后端配置」填 http(s)://主机:9090 并保存（草稿不保存就刷新即消失）');
      return;
    }
    try {
      const [ver, proxies, conns] = await Promise.all([
        this.clash.version(this.backend()),
        this.clash.proxies(this.backend()),
        this.clash.connections(this.backend()),
      ]);
      this.version.set(ver?.version ?? '');
      this.proxyMap.set(proxies?.proxies ?? {});
      this.applyConns(conns?.connections ?? []);
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err?.status === 401) this.unauthorized.set(true);
      else this.loadErr.set(err?.message ?? String(e));
    }
  }

  async refreshConns(): Promise<void> {
    try {
      const conns = await this.clash.connections(this.backend());
      this.applyConns(conns?.connections ?? []);
    } catch {
      /* 自动刷新失败不打扰用户 */
    }
  }

  /** 更新连接列表，同时刷新每条连接的「最近字节变化时刻」（空转判定依据） */
  private applyConns(list: Connection[]): void {
    const now = Date.now();
    const seen = new Set<string>();
    for (const c of list) {
      seen.add(c.id);
      const sig = (c.upload ?? 0) + (c.download ?? 0);
      const prev = this.lastMove.get(c.id);
      // 用「字节签名 + 首次出现」占位：第一次见到即算活跃；之后签名变化才更新
      const prevSig = this.lastSig.get(c.id);
      if (prev === undefined || prevSig === undefined) {
        // 首次见到：记为活跃起点
        this.lastMove.set(c.id, now);
        this.lastSig.set(c.id, sig);
      } else if (prevSig !== sig) {
        // 字节有增长：刷新活跃时刻
        this.lastMove.set(c.id, now);
        this.lastSig.set(c.id, sig);
      }
    }
    // 清掉已消失连接的记录，避免 Map 无限增长
    for (const id of [...this.lastMove.keys()]) if (!seen.has(id)) this.lastMove.delete(id);
    for (const id of [...this.lastSig.keys()]) if (!seen.has(id)) this.lastSig.delete(id);
    this.now.set(now);
    this.conns.set(list);
  }

  /** 字节签名表（配合 lastMove 判断是否还在跑数据） */
  private readonly lastSig = new Map<string, number>();

  async refreshAll(): Promise<void> {
    await this.load();
    if (this.tab() === 'rules') await this.loadRules();
  }

  setLevel(l: string): void {
    this.level.set(l);
    if (this.tab() === 'logs') this.startLogs();
  }

  setTab(t: PaneTab): void {
    this.tab.set(t);
    if (t === 'logs') this.startLogs();
    else this.stopLogs();
    if (t === 'rules' && !this.rules().length) void this.loadRules();
    if (t === 'connections') void this.refreshConns();
  }

  /* ── 分组 / 节点 ── */

  /** 最近一次延迟（history 尾部；未测为 null） */
  lastLat(name: string): number | null {
    const h = this.proxyMap()[name]?.history ?? [];
    return h.length ? (h[h.length - 1].delay ?? 0) : null;
  }

  latClass(d: number | null): string {
    return latClass(d);
  }

  latText(d: number | null): string {
    return latText(d);
  }

  async select(group: ProxyNode, member: string): Promise<void> {
    if (group.type !== 'Selector') return;
    try {
      await this.clash.select(this.backend(), group.name, member);
      this.proxyMap.update((m) => ({ ...m, [group.name]: { ...group, now: member } }));
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
      const groups = Object.values(map).filter((p) => p.type === 'Selector' || p.type === 'URLTest');
      const names = [
        ...new Set(groups.flatMap((g) => g.all ?? [])),
      ].filter((n) => map[n] && map[n].type !== 'Selector' && map[n].type !== 'URLTest');
      // 并发 6 逐节点测延迟，结果写回 history（runPool 见 util.ts）
      let done = 0;
      await runPool(names, 6, async (name) => {
        let d = 0;
        try {
          d = await this.clash.delay(this.backend(), name);
        } catch {
          d = 0; // 超时/不可达记 0，界面显示 ✗
        }
        this.patchLat(name, d);
        done++;
        this.testProgress.set(`${done}/${names.length}`);
      });
    } finally {
      this.testing.set(false);
      this.testProgress.set('');
    }
  }

  private patchLat(name: string, d: number): void {
    this.proxyMap.update((m) => {
      const p = m[name];
      if (!p) return m;
      return { ...m, [name]: { ...p, history: [...(p.history ?? []), { time: new Date().toISOString(), delay: d }] } };
    });
  }

  /* ── 连接 ── */
  private connText(c: Connection): string {
    const m = c.metadata ?? {};
    return [
      m.host,
      m.sniffHost,
      m.destinationIP,
      m.destinationPort,
      c.rule,
      c.rulePayload,
      ...(c.chains ?? []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  chainOf(c: Connection): string[] {
    return c.chains ?? [];
  }

  /** 连接存活秒数（now - start；start 缺失记 0） */
  ageOf(c: Connection, now = this.now()): number {
    const t = Date.parse(c.start);
    return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : 0;
  }

  /** 空转秒数：距最近一次字节增长的时间（新连接算 0） */
  idleSec(c: Connection, now = this.now()): number {
    const t = this.lastMove.get(c.id);
    return t === undefined ? 0 : Math.max(0, (now - t) / 1000);
  }

  ageText(sec: number): string {
    if (sec < 60) return Math.round(sec) + 's';
    if (sec < 3600) return Math.floor(sec / 60) + '分';
    return Math.floor(sec / 3600) + '时' + Math.floor((sec % 3600) / 60) + '分';
  }

  /** 年龄着色：≥30分钟红（很可能僵死）、≥5分钟黄（偏老）、其余正常 */
  ageClass(sec: number): string {
    if (sec >= 1800) return 'r';
    if (sec >= 300) return 'y';
    return '';
  }

  async kill(c: Connection): Promise<void> {
    try {
      await this.clash.kill(this.backend(), c.id);
      this.conns.update((list) => list.filter((x) => x.id !== c.id));
    } catch {
      /* 连接可能已关闭 */
    }
  }

  /** 批量断开当前筛选命中的连接（例：存活 ≥5 分钟的全部断开，清僵死） */
  async killMatched(): Promise<void> {
    const targets = this.matchedConns();
    if (!targets.length) return;
    if (!confirm(`断开当前筛选出的 ${targets.length} 条连接？`)) return;
    const ids = new Set(targets.map((c) => c.id));
    for (const c of targets) {
      try {
        await this.clash.kill(this.backend(), c.id);
      } catch {
        /* 连接可能已自行关闭 */
      }
    }
    this.conns.update((list) => list.filter((x) => !ids.has(x.id)));
    for (const id of ids) {
      this.lastMove.delete(id);
      this.lastSig.delete(id);
    }
  }

  async killAll(): Promise<void> {
    if (!confirm('断开全部连接？（会立刻断开当前所有代理连接）')) return;
    try {
      await this.clash.killAll(this.backend());
      await this.refreshConns();
    } catch {
      /* ignore */
    }
  }

  fmtB(n?: number): string {
    return fmtBytes(n ?? 0);
  }

  /* ── 日志 ── */
  /** 日志 WebSocket：token 走 query（sing-box 只认这种）；暂停时丢弃新行 */
  private startLogs(): void {
    this.stopLogs();
    this.logLines.set([]);
    try {
      this.ws = new WebSocket(this.clash.logsUrl(this.backend(), this.level()));
    } catch (e) {
      this.pushLog('error', '无法建立 WebSocket：' + ((e as Error)?.message ?? e));
      return;
    }
    this.pushLog('info', `— 已连接 ${this.level()} 日志 —`);
    this.ws.onmessage = (ev) => {
      if (this.paused()) return;
      let type = 'info';
      let text = String(ev.data);
      try {
        const m = JSON.parse(String(ev.data)) as { type?: string; payload?: string };
        type = m.type ?? 'info';
        text = m.payload ?? text;
      } catch {
        /* 纯文本行 */
      }
      this.pushLog(type, text);
    };
    this.ws.onerror = () => this.pushLog('error', '— 日志连接出错（密钥不对 / ws 被拦？）—');
    this.ws.onclose = () => this.pushLog('info', '— 连接已关闭 —');
  }

  private stopLogs(): void {
    if (!this.ws) return;
    this.ws.onmessage = null;
    this.ws.onerror = null;
    this.ws.onclose = null;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  /** 追加日志行（保留最近 300 行），贴底时自动滚动 */
  private pushLog(type: string, text: string): void {
    this.logLines.update((l) => [...l.slice(-299), { type, text }]);
    if (this.stickToBottom) {
      setTimeout(() => {
        const el = this.logBox()?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      }, 0);
    }
  }

  /** 用户上滚离开底部 30px 后停止自动贴底 */
  onLogScroll(): void {
    const el = this.logBox()?.nativeElement;
    if (!el) return;
    this.stickToBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  }

  /* ── 规则 ── */
  async loadRules(): Promise<void> {
    try {
      const res = await this.clash.rules(this.backend());
      this.rules.set(res?.rules ?? []);
    } catch (e) {
      this.rules.set([]);
      alert('规则拉取失败：' + ((e as Error)?.message ?? e));
    }
  }

  /* ── 后端配置 ── */
  saveCfg(): void {
    const ok = this.bsvc.save(this.index(), this.cfgName(), this.cfgApi(), this.cfgKey());
    this.cfgMsg.set(ok ? '已保存' : '地址必须形如 http(s)://主机:端口');
    if (ok) setTimeout(() => this.cfgMsg.set(''), 2000);
  }

  delCfg(): void {
    const b = this.backend();
    if (!b.draft && !confirm(`删除后端「${b.name}」？（只影响本浏览器配置）`)) return;
    this.bsvc.remove(this.index());
    this.removed.emit();
  }
}