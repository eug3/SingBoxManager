/**
 * connections —— 连接子页：单路由的实时连接浏览器（复刻 zashboard /ui/#/connections 的浏览方式）。
 *
 * 结构：
 *  - 顶部：活跃 / 已关闭 / 全部 三档视图 + 搜索框（正则、空格 = AND）+ 源 IP / 网络 / 出口 / 分组 / 列 工具条；
 *  - 次行：存活档位、空转过滤、快速隐藏正则（默认 direct|dns-out）与命中统计；
 *  - 表格：列头点击排序、列显隐与顺序可配、命中片段高亮、右键复制单元格、点行开右侧详情抽屉；
 *  - 底部状态条：总数 / 命中 / 隐藏 / 老连接与空转候选 / 累计与实时速率 / 最后更新 / 拉取错误；
 *  - 数据：订阅 LiveStatService 的连接快照（全站唯一轮询者，2s 一拍；暂停只停「应用新快照」），
 *    相邻快照做差得到速率、空转与「已关闭」。
 *
 * 与其它消费者的分工：本组件只管列表/差分/视图状态；快照与「活跃条数 + 累计流量」由共享服务统一供给，
 * 头部统计条与流向图读的是同一份数据。
 */
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Backend, Connection } from './models';
import { BackendsService } from './backends.service';
import { ClashService } from './clash.service';
import {
  COL_BY_KEY,
  COLS,
  ConnCol,
  ConnField,
  ConnGroup,
  ConnRow,
  ConnTracker,
  DEFAULT_COLS,
  GROUP_KEYS,
  GROUP_LABELS,
  GroupKey,
  HlPart,
  SortState,
  ageSec,
  applyFilters,
  cellText,
  chainTags,
  countBy,
  groupRows,
  highlightParts,
  idleSec,
  outOf,
  sortRows,
  parseSearch,
  srcOf,
  sumStat,
} from './connections-model';
import { ageClass, ageText, errMsg, fmtBytes, fmtRate } from './util';
import { ConfirmService } from './confirm.service';
import { LiveStatService, LiveSnapshot } from './live-stat.service';

/** 年龄 / 空转的走秒间隔 */
const TICK_MS = 1000;

/** localStorage 键（视图偏好跨会话保留；按控制台而不是按路由） */
const K = {
  tab: 'connTab',
  cols: 'connColumns',
  sort: 'connSort',
  scope: 'connScopeAll',
  hide: 'connHideRe',
  hideOn: 'connHideOn',
  auto: 'connAuto',
  group: 'connGroupBy',
  chainDir: 'connChainDir',
  fullChain: 'connFullChain',
};

/** 读一个 JSON 化的本地偏好（坏数据/无痕模式一律回退） */
function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** 写本地偏好（配额满/无痕模式静默失败） */
function savePref(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 存不下就算了，不影响本页功能 */
  }
}

/** 详情抽屉里的一个小节：标题 + 若干「标签 / 值」行 */
interface DetailSection {
  title: string;
  rows: [string, string][];
}

/** 模板遍历用的一组：ConnGroup + 「有没有组头 / 是否展开」 */
interface ViewGroup extends ConnGroup {
  header: boolean;
  open: boolean;
}

@Component({
  selector: 'app-connections',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './connections.html',
  host: { '(document:keydown.escape)': 'closeOverlays()' },
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
  `,
})
export class Connections implements OnInit, OnDestroy {
  /** 当前后端（clash_api 地址与密钥都由它决定；地址/密钥改动会自动重拉） */
  readonly backend = input.required<Backend>();

  /** clash_api 客户端（断开连接；快照轮询已交给 LiveStatService） */
  private readonly clash = inject(ClashService);
  /** 后端服务（取该路由实际生效的密钥，密钥变更时触发重拉） */
  private readonly bsvc = inject(BackendsService);
  /** 页内确认框（取代原生 confirm） */
  private readonly ui = inject(ConfirmService);
  /** 全站唯一的连接快照轮询服务（本组件按快照做差更新列表） */
  private readonly live = inject(LiveStatService);

  /** 快照追踪器（速率 / 空转 / 已关闭的差分状态） */
  private readonly tracker = new ConnTracker();

  /** 三档视图 */
  readonly tab = signal<'active' | 'closed' | 'all'>(loadPref(K.tab, 'active'));
  /** 当前时刻（每秒推进，驱动存活/空转与速率衰减） */
  readonly now = signal(Date.now());
  /** 全部行（活跃 + 已关闭），每次快照整体替换 */
  readonly rows = signal<ConnRow[]>([]);

  /** 搜索词（空格 = 多个正则 AND） */
  readonly q = signal('');
  /** 搜索范围：false = 只看可见列，true = 全部字段 */
  readonly scopeAll = signal(loadPref(K.scope, false));
  /** 快速隐藏正则原文 */
  readonly hideRe = signal(loadPref(K.hide, 'direct|dns-out'));
  /** 快速隐藏开关 */
  readonly hideOn = signal(loadPref(K.hideOn, false));
  /** 源 IP 多选 */
  readonly srcSel = signal<ReadonlySet<string>>(new Set());
  /** 网络过滤 */
  readonly net = signal<'' | 'tcp' | 'udp'>('');
  /** 出口过滤（chains[0]） */
  readonly outSel = signal('');
  /** 存活下限（秒） */
  readonly minAge = signal(0);
  /** 只看空转 ≥60s */
  readonly idleOnly = signal(false);
  /** 分组字段（'' = 不分组） */
  readonly groupBy = signal<'' | GroupKey>(loadPref(K.group, ''));
  /** 排序（null = 保持快照顺序） */
  readonly sort = signal<SortState | null>(loadPref(K.sort, null));
  /** 显示列（顺序即表格顺序） */
  readonly cols = signal<ConnCol[]>(loadCols());
  /** 链方向：out = 出口 → 分组（sing-box 原始顺序），in = 分组 → 出口 */
  readonly chainDir = signal<'out' | 'in'>(loadPref(K.chainDir, 'out'));
  /** 是否显示完整链（>2 段时是否折叠成「出口 › … › 分组」） */
  readonly fullChain = signal(loadPref(K.fullChain, true));
  /** 收起的分组（存 group key） */
  readonly collapsed = signal<ReadonlySet<string>>(new Set());

  /** 自动刷新（false = 暂停，停轮询，列表冻结便于查看） */
  readonly auto = signal(loadPref(K.auto, true));
  /** 最近一次成功拉取的时刻 */
  readonly lastAt = signal(0);
  /** 拉取中（工具条上的刷新按钮 spinner） */
  readonly loading = signal(false);
  /** 拉取错误（401 单独给密钥提示） */
  readonly err = signal('');

  /** 打开中的浮层：列设置 / 源 IP 选择 */
  readonly pop = signal<'cols' | 'src' | null>(null);
  /** 详情抽屉里的连接（null = 关闭） */
  readonly detail = signal<ConnRow | null>(null);
  /** 轻提示（复制成功 / 断开结果），1.6s 自动消失 */
  readonly toast = signal('');

  /** 全部列（列设置里的「未显示」池） */
  readonly allCols = COLS;
  /** 分组下拉可选项 */
  readonly groupKeys = GROUP_KEYS;
  readonly groupLabels = GROUP_LABELS;

  /** 走秒定时器 / 轻提示定时器 */
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** 上一次的 api|key 指纹：地址或密钥变了就清空重拉 */
  private lastKey = '';
  /** 已应用快照的时间戳（同一份快照只做一次差分） */
  private lastApplied = 0;
  /** 手动刷新 / 切后端时绕过「暂停」闸门，只生效一次 */
  private force = false;
  /** LiveStatService 的退订函数 */
  private unsubLive: (() => void) | null = null;

  constructor() {
    // 视图偏好落盘：任何一个持久化信号变化就整体写一遍（键少，开销可忽略）
    effect(() => {
      savePref(K.tab, this.tab());
      savePref(K.cols, this.cols());
      savePref(K.sort, this.sort());
      savePref(K.scope, this.scopeAll());
      savePref(K.hide, this.hideRe());
      savePref(K.hideOn, this.hideOn());
      savePref(K.auto, this.auto());
      savePref(K.group, this.groupBy());
      savePref(K.chainDir, this.chainDir());
      savePref(K.fullChain, this.fullChain());
    });

    // 抽屉跟着快照刷新：同一条连接在下一轮快照里换成新对象后，抽屉里也换成新读数
    effect(() => {
      const d = this.detail();
      if (!d) return;
      const fresh = this.rows().find((r) => r.c.id === d.c.id);
      if (fresh && fresh !== d) this.detail.set(fresh);
    });

    // 后端（地址 / 密钥）变化：丢掉上一个后端的连接与差分基线，等下一份快照重建
    effect(() => {
      const b = this.backend();
      const key = `${b.api}|${this.bsvc.keyFor(b)}`;
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.tracker.reset();
      this.rows.set([]);
      this.detail.set(null);
      this.srcSel.set(new Set());
      this.outSel.set('');
      this.lastApplied = 0;
      this.force = true;
    });

    // 全站共享的连接快照：新快照就做一次差分（「暂停」只停应用新快照，不影响头部统计条）
    effect(() => {
      const s = this.live.snap();
      const e = this.live.err();
      if (e) this.err.set(e);
      if (!s || s.api !== this.backend().api) return;
      if (s.at === this.lastApplied) return;
      if (!this.auto() && !this.force) return;
      this.applySnap(s);
    });
  }

  ngOnInit(): void {
    this.unsubLive = this.live.subscribe(this.backend());
    this.tickTimer = setInterval(() => {
      if (document.hidden) return;
      this.now.set(Date.now()); // 存活 / 空转的读数与速率衰减
    }, TICK_MS);
  }

  ngOnDestroy(): void {
    this.unsubLive?.();
    this.unsubLive = null;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.tickTimer = null;
    this.toastTimer = null;
  }

  /* ── 数据 ── */

  /** 把一份快照交给差分追踪器并整体替换行（at 是服务的采样时间戳，天然去重） */
  private applySnap(s: LiveSnapshot): void {
    this.lastApplied = s.at;
    this.force = false;
    this.rows.set(this.tracker.apply(s.conns, s.at));
    this.lastAt.set(s.at);
    this.err.set('');
  }

  /** 手动刷新（暂停时也允许拉一发）：直接拉服务并同步应用，不等下一拍 */
  refresh(): void {
    this.loading.set(true);
    void this.pullNow().finally(() => this.loading.set(false));
  }

  /** 立刻拉一次并同步应用（刷新按钮、断开后的重算都走这里） */
  private async pullNow(): Promise<void> {
    await this.live.refresh();
    const s = this.live.snap();
    if (s && s.api === this.backend().api) this.applySnap(s);
  }

  /** 自动刷新开关：打开立刻补一拉 */
  setAuto(v: boolean): void {
    this.auto.set(v);
    if (v) this.refresh();
  }

  /* ── 视图派生 ── */

  /** 活跃行（快照里还在的） */
  readonly activeRows = computed(() => this.rows().filter((r) => !r.closed));
  /** 已关闭行（快照里消失的，最多 500 条） */
  readonly closedRows = computed(() => this.rows().filter((r) => r.closed));
  readonly activeCount = computed(() => this.activeRows().length);
  readonly closedCount = computed(() => this.closedRows().length);

  /** 当前视图的基础行（三档） */
  readonly baseRows = computed(() => {
    const t = this.tab();
    return t === 'active' ? this.activeRows() : t === 'closed' ? this.closedRows() : this.rows();
  });

  /** 显示列的定义（模板与宽度都从这里取；「已关闭」视图不显示断开列） */
  readonly visibleCols = computed(() => {
    const hideClose = this.tab() === 'closed';
    return this.cols()
      .filter((k) => !(hideClose && k === 'close'))
      .map((k) => COL_BY_KEY[k]);
  });
  /** 表格总宽（列宽之和；不足容器宽时由 CSS min-width 拉满） */
  readonly totalW = computed(() => this.visibleCols().reduce((n, c) => n + (c.w ?? 100), 0));

  /** 搜索正则（空数组 = 不过滤） */
  readonly regs = computed(() => parseSearch(this.q()));
  /** 快速隐藏正则 */
  readonly hideRegs = computed(() => (this.hideOn() ? parseSearch(this.hideRe()) : []));
  /** 搜索范围字段：只看可见列时取可见的文本列，否则空 = 全部字段 */
  readonly scopeFields = computed<ConnField[]>(() => {
    if (this.scopeAll()) return [];
    const out: ConnField[] = [];
    for (const k of this.cols()) {
      const f = COL_BY_KEY[k]?.text;
      if (f) out.push(f);
    }
    return out;
  });

  /** 筛选结果（含被快速隐藏掉的行数） */
  readonly filtered = computed(() =>
    applyFilters(this.baseRows(), {
      regs: this.regs(),
      scope: this.scopeFields(),
      hide: this.hideRegs(),
      src: this.srcSel(),
      net: this.net(),
      outbound: this.outSel(),
      minAge: this.minAge(),
      idleOnly: this.idleOnly(),
      now: this.now(),
    }),
  );
  /** 命中的行（排序前） */
  readonly filteredRows = computed(() => this.filtered().rows);
  /** 排序后的行 */
  readonly sortedRows = computed(() => sortRows(this.filteredRows(), this.sort(), this.now()));

  /** 分组视图（不分组时为 null，模板走平铺分支） */
  readonly groups = computed<ConnGroup[] | null>(() => {
    const by = this.groupBy();
    if (!by) return null;
    return groupRows(this.sortedRows(), by, this.now(), (r) => r.f[by]);
  });

  /** 模板真正遍历的行：统一成「组」结构（不分组时是唯一一个无组头的组），避免表格行标记写两遍 */
  readonly viewGroups = computed<ViewGroup[]>(() => {
    const gs = this.groups();
    if (!gs) {
      const rows = this.sortedRows();
      return [{ key: '', label: '', rows, dl: 0, ul: 0, oldest: 0, header: false, open: true }];
    }
    return gs.map((g) => ({ ...g, header: true, open: !this.collapsed().has(g.key) }));
  });

  /** 当前可批量断开的行（已关闭的连接不能再断） */
  readonly killTargets = computed(() => this.filteredRows().filter((r) => !r.closed));
  /** 源 IP 候选（按当前视图口径计数） */
  readonly srcOptions = computed(() => countBy(this.baseRows(), 'src'));
  /** 出口候选 */
  readonly outOptions = computed(() => countBy(this.baseRows(), 'outbound'));
  /** 命中行的汇总（状态条） */
  readonly stat = computed(() => sumStat(this.filteredRows(), this.now()));
  /** 全部活跃行的汇总（老连接 / 空转候选提示） */
  readonly activeStat = computed(() => sumStat(this.activeRows(), this.now()));

  /** 详情抽屉的小节内容 */
  readonly detailSections = computed<DetailSection[]>(() => {
    const r = this.detail();
    if (!r) return [];
    const now = this.now();
    const m = r.c.metadata ?? {};
    return [
      {
        title: '连接',
        rows: [
          ['ID', r.c.id],
          ['状态', r.closed ? '已关闭' : '活跃'],
          ['开始', clock(r.c.start)],
          ['存活', ageText(ageSec(r, now))],
          ['空转', r.closed ? '—' : ageText(idleSec(r, now))],
        ],
      },
      {
        title: '来源',
        rows: [
          ['来源地址', srcOf(r.c) || '—'],
          ['网络', m.network || '—'],
          ['入站', m.type || '—'],
          ['进程', m.processPath || m.process || '—'],
          ['用户', m.user || '—'],
        ],
      },
      {
        title: '目标',
        rows: [
          ['主机', this.hostText(r)],
          ['目标地址', this.destText(r)],
          ['DNS 模式', m.dnsMode || '—'],
          ['目标类型', this.destType(r.c)],
        ],
      },
      {
        title: '路由',
        rows: [
          ['规则', (r.c.rule || '').trim() || '—'],
          ['规则参数', (r.c.rulePayload || '').trim() || '—'],
          ['出口', outOf(r.c) || '—'],
          ['完整链', (r.c.chains ?? []).join(' › ') || '—'],
        ],
      },
      {
        title: '流量',
        rows: [
          ['↓ 累计', fmtBytes(r.dl)],
          ['↑ 累计', fmtBytes(r.ul)],
          ['↓ 速率', r.dlSpd > 0 ? fmtRate(r.dlSpd) : '—'],
          ['↑ 速率', r.ulSpd > 0 ? fmtRate(r.ulSpd) : '—'],
        ],
      },
    ];
  });

  /** 详情抽屉里的原始连接 JSON（sing-box 原样，便于对照字段） */
  readonly detailRaw = computed(() => {
    const r = this.detail();
    return r ? JSON.stringify(r.c, null, 2) : '';
  });

  /* ── 表格：文案 / 高亮 / 排序 ── */

  /** 单元格文案（close 列由模板单独渲染） */
  cell(row: ConnRow, key: ConnCol): string {
    return cellText(row, key, this.now(), this.fullChain());
  }

  /** 命中高亮片段（搜索为空返回 null，模板走纯文本分支，避免每秒分配无谓对象） */
  hlParts(row: ConnRow, key: ConnCol): HlPart[] | null {
    const regs = this.regs();
    if (!regs.length || key === 'close' || key === 'chains') return null;
    return highlightParts(cellText(row, key, this.now(), this.fullChain()), regs);
  }

  /** 链标签（含方向与折叠） */
  chainTags(row: ConnRow): { name: string; out: boolean }[] {
    return chainTags(row, this.chainDir(), this.fullChain());
  }

  /** 存活秒数（模板用） */
  ageOf(row: ConnRow): number {
    return ageSec(row, this.now());
  }

  /** 空转秒数（模板用） */
  idleOf(row: ConnRow): number {
    return idleSec(row, this.now());
  }

  /** 存活 / 空转着色 */
  ageClassOf(sec: number): string {
    return ageClass(sec);
  }

  /** 空转着色：≥5 分红、≥1 分黄 */
  idleClass(sec: number): string {
    return sec >= 300 ? 'r' : sec >= 60 ? 'y' : '';
  }

  /** 点列头排序：数值列先降序、文本列先升序，第三下取消排序 */
  toggleSort(key: ConnCol): void {
    if (key === 'close') return;
    const ascFirst = !COL_BY_KEY[key].num;
    const cur = this.sort();
    if (!cur || cur.key !== key) {
      this.sort.set({ key, dir: ascFirst ? 'asc' : 'desc' });
      return;
    }
    if (cur.dir === (ascFirst ? 'asc' : 'desc')) {
      this.sort.set({ key, dir: ascFirst ? 'desc' : 'asc' });
      return;
    }
    this.sort.set(null);
  }

  /** 排序指示：asc / desc / 空（未排序） */
  sortMark(key: ConnCol): '' | 'asc' | 'desc' {
    const s = this.sort();
    return s && s.key === key ? s.dir : '';
  }

  /* ── 列设置 ── */

  /** 隐藏一列 */
  hideCol(key: ConnCol): void {
    this.cols.set(this.cols().filter((k) => k !== key));
  }

  /** 显示一列（追加到末尾） */
  showCol(key: ConnCol): void {
    if (!this.cols().includes(key)) this.cols.set([...this.cols(), key]);
  }

  /** 上移 / 下移一列（列序即表格列序） */
  moveCol(key: ConnCol, delta: number): void {
    const list = [...this.cols()];
    const i = list.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    this.cols.set(list);
  }

  /** 恢复默认列（含顺序） */
  resetCols(): void {
    this.cols.set([...DEFAULT_COLS]);
  }

  /* ── 浮层 / 抽屉 ── */

  /** 开关浮层（再点同一个即收起） */
  togglePop(which: 'cols' | 'src'): void {
    this.pop.set(this.pop() === which ? null : which);
  }

  /** 关掉全部浮层与抽屉（Esc / 点遮罩） */
  closeOverlays(): void {
    this.pop.set(null);
    this.detail.set(null);
  }

  /** 打开某条连接的详情抽屉 */
  openDetail(row: ConnRow): void {
    this.detail.set(row);
  }

  /** 源 IP 多选（点一下切换） */
  toggleSrc(ip: string): void {
    const next = new Set(this.srcSel());
    if (next.has(ip)) next.delete(ip);
    else next.add(ip);
    this.srcSel.set(next);
  }

  /** 清空源 IP 过滤 */
  clearSrc(): void {
    this.srcSel.set(new Set());
  }

  /** 分组展开 / 收起 */
  toggleGroup(key: string): void {
    const next = new Set(this.collapsed());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.collapsed.set(next);
  }

  /** 全部展开 / 全部收起（有分组时才有意义） */
  toggleAllGroups(): void {
    const gs = this.groups();
    if (!gs?.length) return;
    const allClosed = gs.every((g) => this.collapsed().has(g.key));
    this.collapsed.set(allClosed ? new Set() : new Set(gs.map((g) => g.key)));
  }

  /* ── 断开 / 复制 ── */

  /** 断开单条（点行内 ✕，不触发打开详情） */
  async killOne(ev: Event, row: ConnRow): Promise<void> {
    ev.stopPropagation();
    await this.killRow(row);
  }

  /** 断开一条连接并从列表移除（连接可能已自行关闭，失败给轻提示） */
  async killRow(row: ConnRow): Promise<void> {
    if (row.closed) return;
    try {
      await this.clash.kill(this.backend(), row.c.id);
      this.drop([row.c.id]);
      this.detail.set(null);
      this.flash('已断开 1 条');
    } catch (e) {
      this.flash('断开失败：' + errMsg(e));
    }
  }

  /** 批量断开当前筛选命中的活跃连接（并发 6，逐条静默失败） */
  async killFiltered(): Promise<void> {
    const targets = this.killTargets();
    if (!targets.length) return;
    const noFilter =
      !this.q().trim() &&
      !this.srcSel().size &&
      !this.net() &&
      !this.outSel() &&
      !this.minAge() &&
      !this.idleOnly() &&
      !this.hideOn();
    const msg = noFilter
      ? `当前没有任何筛选条件，会断开全部 ${targets.length} 条活跃连接，确定？`
      : `断开当前筛选出的 ${targets.length} 条连接？`;
    const ok = await this.ui.ask({
      title: msg,
      body: noFilter ? '设备通常会被动重连，断开后列表会立刻出现新连接。' : undefined,
      okText: '断开',
      danger: true,
    });
    if (!ok) return;
    const ids = new Set<string>();
    for (const r of targets) {
      try {
        await this.clash.kill(this.backend(), r.c.id);
        ids.add(r.c.id);
      } catch {
        /* 连接可能已自行关闭 */
      }
    }
    await this.killAnimate([...ids]);
    this.flash(
      ids.size
        ? `已断开 ${ids.size} 条${ids.size < targets.length ? `（失败 ${targets.length - ids.size} 条）` : ''}`
        : '没有断开任何连接（可能已自行关闭）',
    );
  }

  /**
   * 断开全部连接（需确认；由路由侧执行后再刷一次）。
   *
   * 注意「断完立刻回涨」是正常现象：局域网设备（心跳 / DNS / APP 后台同步）会瞬间重连，
   * 实测断开 60 条后 4 秒内就重新建了 29 条、且全是新连接。所以这里不能只说「已断开」，
   * 而要告诉用户断了多少、以及现在列表里的是新连接，否则会被误认为没生效。
   */
  async killAll(): Promise<void> {
    const before = this.rows().filter((r) => !r.closed).length;
    const ok = await this.ui.ask({
      title: `断开全部 ${before} 条连接？`,
      body: '会立刻断开当前所有代理连接；设备通常会马上重连。',
      okText: '全部断开',
      danger: true,
    });
    if (!ok) return;
    try {
      const killedIds = this.rows().filter((r) => !r.closed).map((r) => r.c.id);
      await this.clash.killAll(this.backend());
      // 先标红淡出，再刷新：若先 poll，新快照会立刻替换 rows，动画根本来不及播
      await this.killAnimate(killedIds);
      await this.pullNow();
      const after = this.rows().filter((r) => !r.closed).length;
      // 断开后仍有余量 = 已经涌入新连接；把两个数字都说清楚
      this.flash(
        after === 0
          ? `已断开全部 ${before} 条`
          : `已断开 ${before} 条；设备正在重连（当前 ${after} 条为新连接）`,
      );
      this.flashLong(after === 0 ? 2600 : 4200); // 有重连说明时多留一会儿，够读完
    } catch (e) {
      this.flash('断开失败：' + errMsg(e));
    }
  }

  /** 同 flash，但指定停留时长（毫秒） */
  private flashLong(ms: number): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(''), ms);
  }

  /** 从当前列表里移除已断开的行（下一轮快照会把它们记成已关闭） */
  private drop(ids: string[]): void {
    const set = new Set(ids);
    this.rows.update((list) => list.filter((r) => !set.has(r.c.id)));
  }

  /** 复制单元格 / 详情里的值（右键或按钮） */
  async copy(text: string, label = ''): Promise<void> {
    if (!text || text === '—') return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 非 https / 无剪切板权限时的兜底：临时 textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        this.flash('复制失败（浏览器不允许）');
      }
      ta.remove();
    }
    this.flash(label ? `已复制 ${label}` : '已复制');
  }

  /** 右键单元格：复制该格文案（链按当前方向与折叠后的样子复制） */
  copyCell(ev: MouseEvent, row: ConnRow, key: ConnCol): void {
    ev.preventDefault();
    ev.stopPropagation();
    const text =
      key === 'chains'
        ? this.chainTags(row)
            .map((t) => t.name)
            .join(' › ')
        : cellText(row, key, this.now(), this.fullChain());
    void this.copy(text, COL_BY_KEY[key]?.label ?? '');
  }

  /** 详情抽屉里的复制按钮（整条 JSON） */
  copyRaw(): void {
    void this.copy(this.detailRaw(), 'JSON');
  }

  /** 正在被断开的行（id 集合）：行先标红淡出再移除，让「断开了」看得见 */
  readonly killing = signal<Set<string>>(new Set());

  /** 标记一批行为「断开中」，等动画播完再移除（0.5s） */
  private async killAnimate(ids: string[]): Promise<void> {
    if (!ids.length) return;
    this.killing.set(new Set(ids));
    await new Promise((r) => setTimeout(r, 480));
    this.drop(ids);
    this.killing.set(new Set());
  }

  /** 轻提示：1.6s 后自动消失 */
  flash(msg: string): void {
    this.toast.set(msg);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(''), 1600);
  }

  /** 分组是否全部收起 */
  allGroupsCollapsed(): boolean {
    const gs = this.groups();
    return !!gs?.length && gs.every((g) => this.collapsed().has(g.key));
  }

  /** 清空筛选（视图档位不动，分组与列设置也不动） */
  clearFilters(): void {
    this.q.set('');
    this.srcSel.set(new Set());
    this.net.set('');
    this.outSel.set('');
    this.minAge.set(0);
    this.idleOnly.set(false);
  }

  /** 列名（排序提示用） */
  colLabel(key: ConnCol): string {
    return COL_BY_KEY[key]?.label ?? key;
  }

  /** 秒数 → 时长文案（模板包装） */
  ageTextOf(sec: number): string {
    return ageText(sec);
  }

  /* ── 模板用的小包装 ── */

  /** 主机（兜底后的展示值） */
  hostText(row: ConnRow): string {
    return row.f.host || '—';
  }

  /** 目标（含端口） */
  destText(row: ConnRow): string {
    return row.f.dst || '—';
  }

  /** 目标类型：IPv4 / IPv6 / FQDN（取目标 IP 的形状） */
  destType(c: Connection): string {
    const ip = c.metadata?.destinationIP ?? '';
    if (!ip) return 'FQDN';
    if (ip.includes(':')) return 'IPv6';
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return 'IPv4';
    return 'FQDN';
  }

  /** 格式化：字节 / 速率 */
  fmtB(n: number): string {
    return fmtBytes(n);
  }
  fmtR(n: number): string {
    return fmtRate(n);
  }

  /** 最后更新时间（本地 HH:MM:SS） */
  lastText(): string {
    const t = this.lastAt();
    return t ? clock(new Date(t).toISOString()) : '尚未更新';
  }

  /** 分组是否收起 */
  isCollapsed(key: string): boolean {
    return this.collapsed().has(key);
  }
}

/** 显示列：过滤掉未知/重复 key，空则回退默认列 */
function loadCols(): ConnCol[] {
  const raw = loadPref<unknown>(K.cols, null);
  if (!Array.isArray(raw)) return [...DEFAULT_COLS];
  const out: ConnCol[] = [];
  for (const k of raw) {
    if (typeof k === 'string' && k in COL_BY_KEY && !out.includes(k as ConnCol)) {
      out.push(k as ConnCol);
    }
  }
  return out.length ? out : [...DEFAULT_COLS];
}

/** HH:MM:SS（本地时区） */
function clock(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
