/**
 * backend-pane —— 单路由面板：每个后端 tab 一个实例，持有该路由的 clash_api 状态与交互。
 *  - 头部：引擎版本 / 活跃连接 / 流量 / 分组 / 节点统计，401 与连接错误横幅，⚙ 后端配置表单；
 *  - 子 tab：概览 / 分组与节点 / 连接 / 流向 / 日志 / 规则 / 配置（概览与配置是独立组件）；
 *  - 全局待保存条：流向图 ③④ 弹窗的改动暂存在 ConfigDraftService，跨子 tab 可见，「保存并重启」才写回路由；
 *  - 编辑弹窗宿主：③ 规则集 / ④ 分组 / SSH 凭据弹窗以 fixed 遮罩挂在面板根部；
 *  - 连接子页：年龄过滤（全部 / ≥1分 / ≥5分 / ≥30分）+ 空转过滤（≥60s 零字节增长），
 *    用于揪出疑似僵死的老连接并批量断开。
 */
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
import { FlowAnim } from './flow-anim';
import { RuleSetDialog } from './rule-set-dialog';
import { GroupDialog } from './group-dialog';
import { SshCredDialog } from './ssh-cred-dialog';
import { ConfigDraftService } from './config-draft.service';
import { groups, validateDoc } from './config-ops';
import { ClashService } from './clash.service';
import { fmtBytes, latClass, latText, runPool } from './util';

/** 后端子页签 */
type PaneTab = 'overview' | 'groups' | 'connections' | 'flow' | 'logs' | 'rules' | 'config';
/** 一条日志行：级别 + 文本 */
interface LogLine {
  type: string;
  text: string;
}

@Component({
  selector: 'app-backend-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverviewPane, ConfigPane, FlowAnim, RuleSetDialog, GroupDialog, SshCredDialog],
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
/** 后端面板组件：其余五个子页（分组/连接/流向/日志/规则）的状态与 clash_api 交互都在本组件 */
export class BackendPane implements OnInit, OnDestroy {
  /** 当前后端（名称 / 地址 / 密钥等） */
  readonly backend = input.required<Backend>();
  /** 该后端在列表中的序号（保存 / 删除配置时用） */
  readonly index = input.required<number>();
  /** 删除后端后通知根组件切换 tab */
  readonly removed = output<void>();

  /** 后端列表服务：保存 / 删除后端、全局密钥、有效性判断 */
  private readonly bsvc = inject(BackendsService);
  /** clash_api 客户端：版本 / 分组 / 连接 / 日志 / 规则 / 断开等 */
  private readonly clash = inject(ClashService);
  /** 流向图编辑的全局配置草稿（待保存条 + ③④ 弹窗共用） */
  readonly draft = inject(ConfigDraftService);

  /** ③ 规则集弹窗正在编辑的分组 tag（null = 弹窗关闭） */
  readonly editRuleTag = signal<string | null>(null);
  /** ④ 分组弹窗正在编辑的分组 tag（null = 弹窗关闭） */
  readonly editGroupTag = signal<string | null>(null);
  /** SSH 凭据弹窗（save 发现缺凭据时打开；saved 后自动重试保存） */
  readonly credOpen = signal(false);

  /** 当前激活的子 tab */
  readonly tab = signal<PaneTab>('overview');
  /** 子 tab 定义（数组顺序即渲染顺序） */
  readonly tabs: { key: PaneTab; label: string }[] = [
    { key: 'overview', label: '概览' },
    { key: 'groups', label: '分组与节点' },
    { key: 'connections', label: '连接' },
    { key: 'flow', label: '流向' },
    { key: 'logs', label: '日志' },
    { key: 'rules', label: '规则' },
    { key: 'config', label: '配置' },
  ];

  /** sing-box 引擎版本（头部统计条） */
  readonly version = signal('');
  /** 全量代理表：名称 → 节点（分组与节点子页的数据源） */
  readonly proxyMap = signal<Record<string, ProxyNode>>({});
  /** 活跃连接列表（连接子页） */
  readonly conns = signal<Connection[]>([]);
  /** 实际生效的规则表（规则子页，进入时才拉取） */
  readonly rules = signal<RuleEntry[]>([]);
  /** 首屏加载错误文案（横幅展示） */
  readonly loadErr = signal('');
  /** 401：密钥未填或错误（单独横幅提示） */
  readonly unauthorized = signal(false);

  /** 连接关键字过滤（域名 / 链 / 规则等，忽略大小写） */
  readonly filter = signal('');
  /** 连接年龄过滤阈值（秒）：0=全部，其余=只看存活≥该秒数的（用来揪疑似僵死的老连接） */
  readonly ageFilter = signal(0);
  /** 当前时刻（每 3s 随刷新推进），用于实时计算连接存活时长 */
  readonly now = signal(Date.now());
  /** 只看「空转」连接（≥60s 没有任何字节增长） */
  readonly idleOnly = signal(false);
  /** 每条连接的「最近一次字节变化时刻」：id → 毫秒。用于区分长连接（仍在跑数据）与空转/僵死 */
  private readonly lastMove = new Map<string, number>();
  /** 每条连接的字节签名（upload+download）：配合 lastMove 判断是否还在跑数据 */
  private readonly lastSig = new Map<string, number>();
  /** 连接子页自动刷新开关（3s 一次） */
  readonly autoRefresh = signal(true);
  /** 日志暂停开关：暂停时丢弃新日志行 */
  readonly paused = signal(false);
  /** 日志级别（debug/info/warn/error） */
  readonly level = signal('info');
  /** 日志行缓冲（最多保留最近 300 行） */
  readonly logLines = signal<LogLine[]>([]);
  /** 「全部测速」是否进行中 */
  readonly testing = signal(false);
  /** 测速进度文案（已完成/总数） */
  readonly testProgress = signal('');
  /** ⚙ 后端配置表单展开开关 */
  readonly cfgOpen = signal(false);
  /** 配置保存结果提示（成功 2s 后自动清空） */
  readonly cfgMsg = signal('');
  /** 受信来源清单（CORS 提示文案用） */
  readonly origins = PAGE_ORIGINS;
  /** 日志级别可选项 */
  readonly levels = ['debug', 'info', 'warn', 'error'];

  /** 配置表单：名称（随后端输入联动，可独立改写） */
  readonly cfgName = linkedSignal(() => this.backend().name);
  /** 配置表单：clash_api 地址 */
  readonly cfgApi = linkedSignal(() => this.backend().api);
  /** 配置表单：密钥（留空 = 用全局密钥） */
  readonly cfgKey = linkedSignal(() => this.backend().key);

  /** 日志滚动容器（自动贴底用） */
  private readonly logBox = viewChild<ElementRef<HTMLDivElement>>('logbox');
  /** 3s 心跳定时器：推进连接年龄 + 连接子页自动刷新 */
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 日志 WebSocket（仅在日志子页连接） */
  private ws: WebSocket | null = null;
  /** 日志是否贴底（用户上滚离开底部后停止自动滚动） */
  private stickToBottom = true;

  /** 分组列表：只取 Selector / URLTest（分组与节点子页） */
  readonly groupList = computed(() =>
    Object.values(this.proxyMap()).filter((p) => p.type === 'Selector' || p.type === 'URLTest'),
  );
  /** 节点总数（头部统计条） */
  readonly nodes = computed(() => Object.keys(this.proxyMap()).length);
  /** 全部连接的累计下载字节（头部统计条） */
  readonly totalDown = computed(() => this.conns().reduce((n, c) => n + (c.download ?? 0), 0));
  /** 全部连接的累计上传字节（头部统计条） */
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
    // 密钥/后端地址变化时自动重新拉取（连接页填入全局密钥后也能立刻生效）；
    // 配置草稿基准同步重读（load 会清掉旧草稿），并关掉属于上一后端的编辑弹窗
    effect(() => {
      const b = this.backend();
      this.bsvc.globalKey();
      this.editRuleTag.set(null);
      this.editGroupTag.set(null);
      this.credOpen.set(false);
      if (this.bsvc.valid(b)) {
        void this.load();
        void this.draft.load(b);
      }
    });
  }

  /** 启动 3s 心跳：页面隐藏时跳过；推进 now 让连接年龄实时走动，连接子页按需自动刷新 */
  ngOnInit(): void {
    this.timer = setInterval(() => {
      if (document.hidden) return;
      this.now.set(Date.now()); // 推进连接年龄
      if (this.tab() === 'connections' && this.autoRefresh()) void this.refreshConns();
    }, 3000);
  }

  /** 清理：停心跳定时器并断开日志 WebSocket */
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

  /** 只刷新连接列表（自动刷新 / 手动刷新；失败静默不打扰用户） */
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
      const prevSig = this.lastSig.get(c.id);
      // 首次见到记为活跃起点；之后字节签名有增长才刷新活跃时刻
      if (prev === undefined || prevSig !== sig) {
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

  /** 头部「刷新」：整体重拉；停在规则子页时顺带刷新规则表 */
  async refreshAll(): Promise<void> {
    await this.load();
    if (this.tab() === 'rules') await this.loadRules();
  }

  /** 切换日志级别：正停在日志子页时立即按新级别重连 WebSocket */
  setLevel(l: string): void {
    this.level.set(l);
    if (this.tab() === 'logs') this.startLogs();
  }

  /** 切换子 tab：日志按需连/断，规则懒加载，进入连接子页立即刷新一次 */
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

  /** 延迟着色 class（模板包装，实现见 util.latClass） */
  latClass(d: number | null): string {
    return latClass(d);
  }

  /** 延迟文案（模板包装，实现见 util.latText） */
  latText(d: number | null): string {
    return latText(d);
  }

  /** 点 Selector 组成员切换当前节点；URLTest 组只读，不响应 */
  async select(group: ProxyNode, member: string): Promise<void> {
    if (group.type !== 'Selector') return;
    try {
      await this.clash.select(this.backend(), group.name, member);
      this.proxyMap.update((m) => ({ ...m, [group.name]: { ...group, now: member } }));
    } catch (e) {
      alert('切换失败：' + ((e as Error)?.message ?? e));
    }
  }

  /** 全部测速：收集分组引用的全部非分组节点，并发 6 测延迟，结果写回各节点 history */
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

  /** 给指定节点的 history 追加一条延迟记录（测速结果写回） */
  private patchLat(name: string, d: number): void {
    this.proxyMap.update((m) => {
      const p = m[name];
      if (!p) return m;
      return { ...m, [name]: { ...p, history: [...(p.history ?? []), { time: new Date().toISOString(), delay: d }] } };
    });
  }

  /* ── 连接 ── */
  /** 连接的可搜索文本（主机 / 目标 / 规则 / 链，小写拼接），供关键字过滤 */
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

  /** 连接经过的代理链（缺失按空数组处理） */
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

  /** 年龄文案：<60s 显示秒，<1h 显示分，其余显示 时+分 */
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

  /** 断开单条连接并从列表移除（连接可能已自行关闭，失败静默） */
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

  /** 断开全部连接（需确认），成功后刷新连接列表 */
  async killAll(): Promise<void> {
    if (!confirm('断开全部连接？（会立刻断开当前所有代理连接）')) return;
    try {
      await this.clash.killAll(this.backend());
      await this.refreshConns();
    } catch {
      /* 忽略：断开或刷新失败 */
    }
  }

  /** 字节数格式化（模板包装，实现见 util.fmtBytes） */
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

  /** 断开日志 WebSocket 并解绑回调（切走日志子页 / 组件销毁时调用） */
  private stopLogs(): void {
    if (!this.ws) return;
    this.ws.onmessage = null;
    this.ws.onerror = null;
    this.ws.onclose = null;
    try {
      this.ws.close();
    } catch {
      /* 忽略关闭异常 */
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
  /** 拉取实际生效的规则表（GET /rules）；失败时清空并弹窗提示 */
  async loadRules(): Promise<void> {
    try {
      const res = await this.clash.rules(this.backend());
      this.rules.set(res?.rules ?? []);
    } catch (e) {
      this.rules.set([]);
      alert('规则拉取失败：' + ((e as Error)?.message ?? e));
    }
  }

  /* ── 流向图编辑：③④ 弹窗 + 全局待保存条 ── */

  /** 点 ③ 规则集卡：分组在当前配置里才开弹窗（DIRECT/block 带不弹） */
  openRule(tag: string): void {
    if (!this.hasGroup(tag)) return;
    this.editRuleTag.set(tag);
  }

  /** 点 ④ 分组卡：与 ③ 相同的前置存在性检查 */
  openGroup(tag: string): void {
    if (!this.hasGroup(tag)) return;
    this.editGroupTag.set(tag);
  }

  /** 当前配置（草稿优先，否则已保存基准）里是否存在该 tag 的分组 */
  private hasGroup(tag: string): boolean {
    const doc = this.draft.draft() ?? this.draft.baseDoc();
    return !!doc && groups(doc).some((g) => String(g['tag']) === tag);
  }

  /** 待保存条「保存并重启」：结构预检 + 确认后走草稿服务（内部备份/check/替换/重启/回滚） */
  saveDraft(): void {
    const doc = this.draft.draft();
    if (!doc || this.draft.saving()) return;
    const issues = validateDoc(doc);
    const msg = issues.length
      ? `结构校验有 ${issues.length} 条问题，仍要保存并重启？\n\n` + issues.slice(0, 8).join('\n')
      : `把修改写回 ${this.backend().name}（${this.backend().api}）并重启 sing-box？\n断流约 1 秒，失败会自动回滚。`;
    if (!confirm(msg)) return;
    void this.runSave();
  }

  /** 执行保存；被「缺 SSH 凭据」挡住时打开凭据弹窗 */
  private async runSave(): Promise<void> {
    await this.draft.save(this.backend());
    if (this.draft.needCreds()) this.credOpen.set(true);
  }

  /** 凭据保存成功：关窗 → 自动重试刚才的保存（不再重复确认） */
  onCredSaved(): void {
    this.credOpen.set(false);
    this.draft.needCreds.set(false);
    void this.runSave();
  }

  /** 待保存条「取消」：丢弃全部暂存改动 */
  cancelDraft(): void {
    this.draft.cancel();
  }

  /* ── 后端配置 ── */
  /** 保存后端配置（名称/地址/密钥）；成功提示 2s 后自动清空，失败提示地址格式 */
  saveCfg(): void {
    const ok = this.bsvc.save(this.index(), this.cfgName(), this.cfgApi(), this.cfgKey());
    this.cfgMsg.set(ok ? '已保存' : '地址必须形如 http(s)://主机:端口');
    if (ok) setTimeout(() => this.cfgMsg.set(''), 2000);
  }

  /** 删除本后端：已保存的需确认，草稿直接删；删除后通知根组件切 tab */
  delCfg(): void {
    const b = this.backend();
    if (!b.draft && !confirm(`删除后端「${b.name}」？（只影响本浏览器配置）`)) return;
    this.bsvc.remove(this.index());
    this.removed.emit();
  }
}