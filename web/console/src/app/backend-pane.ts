/**
 * backend-pane —— 单路由面板：每个后端 tab 一个实例，持有该路由的 clash_api 状态与交互。
 *  - 头部：引擎版本 / 活跃连接 / 流量 / 分组 / 节点统计，401 与连接错误横幅，⚙ 后端配置表单；
 *  - 子 tab：概览 / 分组与节点 / 连接 / 流向 / 日志 / 规则 / 配置（概览与配置是独立组件）；
 *  - 全局待保存条：流向图 ③④ 弹窗的改动暂存在 ConfigDraftService，跨子 tab 可见，「保存并重启」才写回路由；
 *  - 编辑弹窗宿主：③ 规则集 / ④ 分组 / SSH 凭据弹窗以 fixed 遮罩挂在面板根部；
 *  - 连接子页：独立组件 Connections（三档视图 / 搜索 / 筛选 / 排序 / 分组 / 列设置 / 详情抽屉），
 *    连接数据与轮询都归它，本组件只接收它回传的「活跃条数 + 累计流量」喂头部统计条。
 */
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Backend, ConnectionsResp, PAGE_ORIGINS, ProxyNode, RuleEntry } from './models';
import { BackendsService } from './backends.service';
import { OverviewPane } from './overview';
import { ConfigPane } from './config-pane';
import { Connections } from './connections';
import { FlowAnim } from './flow-anim';
import { RuleSetDialog } from './rule-set-dialog';
import { GroupDialog } from './group-dialog';
import { SshCredDialog } from './ssh-cred-dialog';
import { ConfigDraftService } from './config-draft.service';
import { groups, validateDoc, serializeConfig } from './config-ops';
import { ClashService } from './clash.service';
import { fmtBytes, latClass, latText, runPool } from './util';
import { SaveProgressDialog } from './save-progress';

/** 后端子页签（App 也用它记住每个后端的当前子页） */
export type PaneTab = 'overview' | 'groups' | 'connections' | 'flow' | 'logs' | 'rules' | 'config';
/** 一条日志行：级别 + 文本 */
interface LogLine {
  type: string;
  text: string;
}

@Component({
  selector: 'app-backend-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SaveProgressDialog, 
    OverviewPane,
    ConfigPane,
    Connections,
    FlowAnim,
    RuleSetDialog,
    GroupDialog,
    SshCredDialog,
  ],
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
    /* 日志页：整页撑满，滚动交给 .logbox（只滚日志，工具条与页面外壳不动） */
    .bp-body.bp-fill {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .logpage {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .logpage > .bar { flex: 0 0 auto; }
  `,
})
/** 后端面板组件：其余五个子页（分组/连接/流向/日志/规则）的状态与 clash_api 交互都在本组件 */
export class BackendPane implements OnDestroy {
  /** 当前后端（名称 / 地址 / 密钥等） */
  readonly backend = input.required<Backend>();
  /** 该后端在列表中的序号（保存 / 删除配置时用） */
  readonly index = input.required<number>();
  /** 进入时要落在哪个子页（App 按后端记住当前子页，切后端回来不跳回概览） */
  readonly initialTab = input<PaneTab>('overview');
  /** 子页变化时回传（App 记住，供下次重建恢复） */
  readonly tabChange = output<PaneTab>();
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

  /** 保存进度弹窗：null = 未打开 */
  readonly saveState = signal<'running' | 'ok' | 'fail' | 'needCreds' | null>(null);
  /** 当前进行到第几步（0-based，对应 save-progress 的 SAVE_STEPS） */
  readonly saveStep = signal(0);
  /** 保存已用时（毫秒，弹窗里显示） */
  readonly saveElapsed = signal(0);
  /** 失败原文 / 标题 / 建议 */
  readonly saveError = signal('');
  readonly saveFailTitle = signal('保存失败');
  readonly saveFailHint = signal('');
  /** 成功摘要：写入字节数、是否实际变更 */
  readonly saveSize = signal(0);
  readonly saveChanged = signal<boolean | undefined>(undefined);
  private saveT0 = 0;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  /** 当前激活的子 tab（挂载后按 App 记住的子页同步一次：input 在构造时还没赋值） */
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
  /** 活跃连接条数与累计流量（头部统计条；由连接子页的 stats 事件与首屏加载共同更新） */
  readonly liveStat = signal({ count: 0, down: 0, up: 0 });
  /** 实际生效的规则表（规则子页，进入时才拉取） */
  readonly rules = signal<RuleEntry[]>([]);
  /** 首屏加载错误文案（横幅展示） */
  readonly loadErr = signal('');
  /** 401：密钥未填或错误（单独横幅提示） */
  readonly unauthorized = signal(false);
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
    // 组件因切后端被重建时，恢复 App 记住的子页（input 在构造时未赋值，故放到首帧之后）
    afterNextRender(() => {
      const t = this.initialTab();
      if (t !== this.tab()) this.tab.set(t);
      this.enterTab(t);
    });
  }

  /** 清理：断开日志 WebSocket（连接子页的定时器归它自己管） */
  ngOnDestroy(): void {
    this.stopLogs();
  }

  /** 连接子页回传的活跃条数与累计流量 → 头部统计条 */
  onConnStats(ev: { count: number; down: number; up: number }): void {
    this.liveStat.set(ev);
  }

  /** 首屏三连拉：版本 / 分组节点 / 连接（401 单独提示填密钥） */
  async load(): Promise<void> {
    this.loadErr.set('');
    this.unauthorized.set(false);
    if (!this.bsvc.valid(this.backend())) {
      this.loadErr.set(
        '该后端还没配置地址：点「⚙ 后端配置」填 http(s)://主机:9090 并保存（草稿不保存就刷新即消失）',
      );
      return;
    }
    try {
      const [ver, proxies, cons] = await Promise.all([
        this.clash.version(this.backend()),
        this.clash.proxies(this.backend()),
        this.clash.connections(this.backend()),
      ]);
      this.version.set(ver?.version ?? '');
      this.proxyMap.set(proxies?.proxies ?? {});
      // 首屏先给头部统计条一个数；之后由连接子页每 2s 的 stats 事件接管
      this.applyLiveStat(cons);
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err?.status === 401) this.unauthorized.set(true);
      else this.loadErr.set(err?.message ?? String(e));
    }
  }

  /** 首屏连接快照 → 头部统计条（活跃条数 / 累计上下行） */
  private applyLiveStat(resp: ConnectionsResp | undefined): void {
    const list = resp?.connections ?? [];
    let down = 0;
    let up = 0;
    for (const c of list) {
      down += c.download ?? 0;
      up += c.upload ?? 0;
    }
    this.liveStat.set({ count: list.length, down, up });
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

  /** 切换子 tab：日志按需连/断，规则懒加载（连接页自己轮询，挂载即拉）；变化回传给 App */
  setTab(t: PaneTab): void {
    this.tab.set(t);
    this.tabChange.emit(t);
    this.enterTab(t);
  }

  /** 某个子页被激活时的副作用（日志连 WS、规则懒拉；连接/流向/概览由各自组件挂载时自己取数） */
  private enterTab(t: PaneTab): void {
    if (t === 'logs') this.startLogs();
    else this.stopLogs();
    if (t === 'rules' && !this.rules().length) void this.loadRules();
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
      const groups = Object.values(map).filter(
        (p) => p.type === 'Selector' || p.type === 'URLTest',
      );
      const names = [...new Set(groups.flatMap((g) => g.all ?? []))].filter(
        (n) => map[n] && map[n].type !== 'Selector' && map[n].type !== 'URLTest',
      );
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
      return {
        ...m,
        [name]: {
          ...p,
          history: [...(p.history ?? []), { time: new Date().toISOString(), delay: d }],
        },
      };
    });
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

  /**
   * 执行保存；全程在进度弹窗里展示：
   *  · 阶段推进按耗时估计（后端 apply 是单条阻塞 SSH 调用，结束时以真实结果为准）；
   *  · 成功 → ok + 摘要；失败 → 停在出错步 + 原文 + 建议 + 重试；
   *  · 缺凭据 → needCreds，点「填写凭据」开 SSH 凭据框，填完自动续跑。
   */
  private async runSave(): Promise<void> {
    const text = this.draft.draft() ? serializeConfig(this.draft.draft()!, this.draft.originalText()) : '';
    this.saveSize.set(text.length);
    this.saveChanged.set(undefined);
    this.saveError.set('');
    this.saveStep.set(0);
    this.saveState.set('running');
    this.startSaveClock();

    const p = this.draft.save(this.backend());
    void this.advanceSaveSteps(); // 与真实请求并行跑进度
    await p;
    this.stopSaveClock();

    if (this.draft.needCreds()) {
      this.saveState.set('needCreds');
      this.saveError.set(this.draft.error());
      return;
    }
    const err = this.draft.error();
    if (err) {
      this.saveFailTitle.set(this.saveFailTitleOf(err));
      this.saveFailHint.set(this.saveFailHintOf(err));
      this.saveError.set(err);
      this.saveStep.set(this.saveFailStepOf(err)); // 红叉落在真正出错的那一步
      this.saveState.set('fail');
      return;
    }
    // 成功：草稿已被服务清空
    this.saveStep.set(5);
    this.saveState.set('ok');
  }

  /** 进度时钟：显示已用时 */
  private startSaveClock(): void {
    this.stopSaveClock();
    this.saveT0 = Date.now();
    this.saveElapsed.set(0);
    this.saveTimer = setInterval(() => this.saveElapsed.set(Date.now() - this.saveT0), 200);
  }

  private stopSaveClock(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = null;
  }

  /**
   * 按估计耗时推进阶段（总时长约 8–20 秒：凭据预检 0.3s → 读 sha 0.5s → 上传 0.5s
   * → check 1–3s → 重启 1–3s → 健康检查 2–6s）。只是视觉引导，不指示真实完成度。
   */
  private async advanceSaveSteps(): Promise<void> {
    const waits = [700, 900, 1800, 2500]; // 每次停留后推进到下一步
    for (let i = 0; i < waits.length; i++) {
      await new Promise((r) => setTimeout(r, waits[i]));
      if (this.saveState() !== 'running') return;
      this.saveStep.set(i + 1);
    }
  }

  /** 失败原文 → 标题（按后端 apply 的失败标记分类） */
  private saveFailTitleOf(err: string): string {
    if (/STALE/.test(err)) return '配置已被他人修改';
    if (/sing-box check 未通过|CHECK_FAILED/i.test(err)) return '语法校验未通过';
    if (/自动回滚|ROLLBACK_OK/i.test(err)) return '新配置不健康，已自动回滚';
    if (/凭据|Permission denied|ssh/i.test(err)) return 'SSH 凭据不可用';
    if (/上传失败/.test(err)) return '上传配置失败';
    return '保存失败';
  }

  /** 失败原文 → 出错的步骤序号（对应 SAVE_STEPS：0读取 1上传 2校验 3重启 4健康检查） */
  private saveFailStepOf(err: string): number {
    if (/STALE/.test(err)) return 0; // 基准版本不符：卡在读当前配置
    if (/上传失败/.test(err)) return 1;
    if (/sing-box check 未通过|CHECK_FAILED/i.test(err)) return 2;
    if (/自动回滚|ROLLBACK_OK/i.test(err)) return 4; // 重启过但健康检查没过 → 回滚
    if (/凭据|Permission denied|ssh/i.test(err)) return 1; // SSH 权限问题多发生在写/执行阶段
    return 2;
  }

  /** 失败原文 → 可操作建议 */
  private saveFailHintOf(err: string): string {
    if (/STALE/.test(err)) return '有人在这期间改过路由配置：点「重试」会先拉取最新版本，再重新应用你的改动。';
    if (/sing-box check 未通过|CHECK_FAILED/i.test(err)) return '新配置没通过 sing-box 语法检查，路由未被改动。按上面的报错修正后重试。';
    if (/自动回滚|ROLLBACK_OK/i.test(err)) return '新配置重启后不健康，系统已自动回滚到原配置，路由仍是可用状态。看上面的日志定位问题。';
    if (/凭据|Permission denied|ssh/i.test(err)) return '99 到路由的 SSH 登录失败：点「重试」并核对用户名/口令（NAS 的 credentials 文件里有登记）。';
    if (/上传失败/.test(err)) return '写临时文件到路由失败：多为路由磁盘满或 /tmp 只读，登录路由查一下空间。';
    return '按上面的错误原文排查；路由未被改坏时原配置保持不变。';
  }

  /** 进度弹窗「重试」：重新走一遍保存 */
  retrySave(): void {
    void this.runSave();
  }

  /** 进度弹窗「填写凭据」：开凭据框（填完 onCredSaved 会自动续跑） */
  openCredsForSave(): void {
    this.saveState.set(null);
    this.credOpen.set(true);
  }

  /** 关掉进度弹窗 */
  closeSaveProgress(): void {
    this.saveState.set(null);
  }

  /** 凭据保存成功：关窗 → 自动重试刚才的保存（不再重复确认） */
  onCredSaved(): void {
    this.credOpen.set(false);
    this.draft.needCreds.set(false);
    void this.runSave(); // 带上进度弹窗续跑
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
