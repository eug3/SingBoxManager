import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import {
  AnyObj,
  ConfigDoc,
  applyGroupRefs,
  detachGroupRefs,
  endpoints,
  groups,
  groupsWithRuleRefs,
  nodes,
  outbounds,
  parseConfig,
} from './config-ops';
import { Backend } from './models';
import { BackendsService } from './backends.service';
import { ConfigDraftService } from './config-draft.service';
import { RouterService } from './router.service';
import { RuleApplyBatchDialog } from './rule-apply-batch-dialog';
import { RuleApplyBatchService } from './rule-apply-batch.service';
import { BucketInfo, VaultService } from './vault.service';
import {
  GroupStatusPerRouter,
  PoolNode,
  PoolRules,
  SharedPoolService,
  groupStatus,
  sameRefSet,
  driftedRouters,
  unknownRouters,
  isAppliedEverywhere,
  nodeFingerprint,
  replaceSameNameNode,
} from './shared-pool.service';
import { errMsg } from './util';

/** 左栏「当前路由节点」行 */
interface SourceNode {
  tag: string;
  type: string;
  server: string;
  special: boolean;
  /** 来自 outbounds 还是 endpoints（masque-client 这类在 endpoints 里） */
  kind: 'outbound' | 'endpoint';
  raw: AnyObj;
}

/** 页内两个互不相干的子页：共享节点 / 共享规则（各有自己的路由 tab 与数据） */
type Section = 'nodes' | 'rules';

/** 每台路由在树里的视图状态（节点清单 / 组名清单 / 加载 / 错误），按 api 键 */
interface RouterView {
  nodes: SourceNode[];
  groups: { group: string; refs: string[]; rules: number }[];
  loading: boolean;
  err: string;
}

/**
 * 「共享编辑」整页 —— 两个子页签，各自独立：
 *   ① 共享节点：把某台路由的节点拖进池子，另一台路由「新增节点 → 共享池」一键导入；
 *   ② 共享规则：把某台路由的**组名**拖进池子（连带它挂的整套 rule_set），
 *      再在目标路由上「套用到本路由」——只统一 rule_set 引用，outbound / 组内节点各路由自留。
 *
 * 两个子页各有**自己的路由 tab**（甲 / 乙 …），互不影响；池子是全局的（localStorage）。
 */
@Component({
  selector: 'app-shared-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RuleApplyBatchDialog],
  templateUrl: './shared-panel.html',
})
export class SharedPanel implements OnInit {
  /** 打开时的默认后端（顶栏当前 tab） */
  readonly initialBackend = input<Backend | null>(null);

  private readonly router = inject(RouterService);
  private readonly bsvc = inject(BackendsService);
  /** 共享规则池的套用落到这个草稿服务（待保存条 / 应用并重启链路与流向图一致） */
  readonly draftSvc = inject(ConfigDraftService);
  /** 批量编排（预演/逐台执行/汇总） */
  private readonly batch = inject(RuleApplyBatchService);
  /** 后端规则桶清单（NAS 目录实时列，/rule-set/index） */
  private readonly vault = inject(VaultService);
  readonly pool = inject(SharedPoolService);

  readonly backends = this.bsvc.backends;
  /** 当前子页签 */
  readonly section = signal<Section>('nodes');

  /* ── 两个子页各自的路由选择 ── */
  readonly nodeBackend = signal<Backend | null>(null);
  readonly ruleBackend = signal<Backend | null>(null);

  private readonly views = signal<Record<string, RouterView>>({});
  /** 树的折叠状态：展开的路由 api 集合；每台路由下「节点」「规则」两个清单也各自可折叠 */
  readonly openRouters = signal<Set<string>>(new Set());
  readonly closedSections = signal<Set<string>>(new Set()); // key = `${api}|nodes` / `${api}|rules`

  private viewOf(api: string): RouterView {
    return this.views()[api] ?? { nodes: [], groups: [], loading: false, err: '' };
  }

  /** 展开某台路由（= 选中它作为当前操作目标，并按需加载配置） */
  toggleRouter(b: Backend): void {
    const api = b.api;
    const cur = this.openRouters();
    const next = new Set(cur);
    if (next.has(api)) {
      next.delete(api);
    } else {
      next.add(api);
      // 展开即选中：共享池「加入 / 套用」的默认目标跟着走
      this.nodeBackend.set(b);
      this.ruleBackend.set(b);
      void this.loadRouterView(b);
    }
    this.openRouters.set(next);
  }

  /** 某台路由下的「节点 / 规则」清单折叠 */
  toggleSection(api: string, sec: 'nodes' | 'rules'): void {
    const key = `${api}|${sec}`;
    const next = new Set(this.closedSections());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.closedSections.set(next);
  }

  isSectionOpen(api: string, sec: 'nodes' | 'rules'): boolean {
    return !this.closedSections().has(`${api}|${sec}`);
  }

  /** 加载某台路由的节点清单与组名清单（树展开时懒加载；带缓存 + 超时） */
  async loadRouterView(b: Backend): Promise<void> {
    const api = b.api;
    this.views.update((m) => ({ ...m, [api]: { ...this.viewOf(api), loading: true, err: '' } }));
    try {
      const doc = await this.fetchDoc(b);
      if (!doc) throw new Error('读不到配置');
      const v = this.buildView(doc);
      this.views.update((m) => ({ ...m, [api]: { ...v, loading: false, err: '' } }));
    } catch (e) {
      this.views.update((m) => ({ ...m, [api]: { ...this.viewOf(api), loading: false, err: errMsg(e) } }));
    }
  }

  /** 从配置算出节点清单（排除分组 / 内置）与组名清单 */
  private buildView(doc: ConfigDoc): { nodes: SourceNode[]; groups: { group: string; refs: string[]; rules: number }[] } {
    const ob = outbounds(doc);
    const ep = endpoints(doc);
    const gs = new Set(groups(doc).map((g) => String(g['tag'])));
    const rows = nodes(doc).map((n) => {
      const inOb = ob.find((o) => String(o['tag']) === n.tag);
      const inEp = inOb ? undefined : ep.find((o) => String(o['tag']) === n.tag);
      return {
        tag: n.tag,
        type: n.type,
        server: n.server,
        special: n.special,
        kind: (inEp ? 'endpoint' : 'outbound') as 'outbound' | 'endpoint',
        raw: inOb ?? inEp ?? {},
      };
    });
    return {
      nodes: rows.filter((r) => !r.special && !gs.has(r.tag)),
      groups: groupsWithRuleRefs(doc),
    };
  }

  readonly nodesOf = (api: string) => this.viewOf(api).nodes;
  readonly groupsOf = (api: string) => this.viewOf(api).groups;
  readonly viewLoading = (api: string) => this.viewOf(api).loading;
  readonly viewErr = (api: string) => this.viewOf(api).err;

  /** 配置缓存：同一台路由只拉一次（两个子页共用，切页签不重复请求） */
  private readonly docs = new Map<string, ConfigDoc>();
  private readonly loads = new Map<string, Promise<ConfigDoc | null>>();
  readonly nodeErr = signal('');
  readonly ruleErr = signal('');
  readonly nodeLoading = signal(false);
  readonly ruleLoading = signal(false);

  /** 节点池：当前路由的可共享节点（树展开某台路由 = 选中它；这里从视图 Map 取） */
  readonly src = computed(() => this.viewOf(this.nodeBackend()?.api ?? '').nodes);
  /** 规则池：当前路由里挂了规则集的组名 */
  readonly groupRows = computed(() => this.viewOf(this.ruleBackend()?.api ?? '').groups);

  /** 池内指纹集合：路由上同配置的节点要打 share 标记、且不能再拖进去 */
  readonly poolKeys = computed(() => this.pool.fingerprints());

  /** 这个节点是否已经在共享池里（同配置，tag 不同也算） */
  isShared(row: SourceNode): boolean {
    return this.poolKeys().has(nodeFingerprint(row.raw, row.kind));
  }

  /** 每台路由的配置（判定共享规则是否已应用到所有路由用；'' = 还没读） */
  private readonly allDocs = signal<Record<string, ConfigDoc | null>>({});
  readonly allDocsView = this.allDocs.asReadonly();

  /** 规则池里每条规则在各路由上的实际状态 */
  readonly ruleStatus = computed(() => {
    const docs = this.allDocs();
    const loaded = Object.keys(docs).length > 0;
    const map: Record<string, { per: GroupStatusPerRouter[]; applied: boolean }> = {};
    for (const r of this.pool.rules()) {
      const per = groupStatus(
        r.refs,
        r.group,
        this.backends().map((b) => ({
          tag: b.api,
          name: b.name || b.api,
          // 还没读到（undefined）≠ 读失败（null）：未读到的按「未知」处理，不能当成「不一致」
          doc: docs[b.api] === undefined ? null : docs[b.api],
          err: docs[b.api] === undefined ? '还没读到配置' : undefined,
        })),
      );
      map[r.id] = { per, applied: isAppliedEverywhere(per) };
    }
    return map;
  });

  readonly groups = computed(() => this.pool.bySource());
  readonly total = computed(() => this.pool.nodes().length);
  /** 规则池列表（不区分来源；未应用排在前面） */
  readonly rulesList = computed(() => this.pool.rulesList());
  readonly rulesTotal = computed(() => this.pool.rules().length);
  /** 页签徽标 / 头部统计：以「实时判定」为准（读不到路由时退回手动标记） */
  /** 路由器维度统计：一共几台、其中「所有共享规则都一致」的有几台 */
  readonly routerStats = computed(() => {
    const st = this.ruleStatus();
    const backs = this.backends();
    const routers = backs.length;
    let routersOk = 0;
    const unknown = new Set(this.unknownRouters());
    for (const b of backs) {
      const name = b.name || b.api;
      if (unknown.has(name)) continue; // 没核对到的不算「全部一致」也不算「不一致」
      let ok = true;
      for (const r of this.pool.rules()) {
        const per = st[r.id]?.per.find((p) => p.name === name);
        if (per && !per.err && per.hasOutbound && !per.same) {
          ok = false;
          break;
        }
      }
      if (ok) routersOk += 1;
    }
    return { routers, routersOk, routersUnknown: unknown.size };
  });

  readonly rulesStats = computed(() => {
    const st = this.ruleStatus();
    const all = this.pool.rules();
    const known = all.filter((r) => st[r.id] !== undefined);
    const rs = this.routerStats();
    if (!known.length) return { ...this.pool.rulesStats(), ...rs };
    const applied = known.filter((r) => st[r.id].applied).length;
    return { applied, pending: known.length - applied, ...rs };
  });

  /** 启动核对是否已完成（所有后端都读过一遍配置，不论成功失败） */
  readonly auditDone = computed(() => {
    const docs = this.allDocs();
    return this.backends().every((b) => docs[b.api] !== undefined);
  });

  /** 读不到配置的路由名（这些没法核对，要单独提示，不能混进「漂移」或「一致」） */
  readonly unknownRouters = computed(() => {
    const docs = this.allDocs();
    return this.backends().filter((b) => docs[b.api] === null).map((b) => b.name || b.api);
  });

  /**
   * 启动核对结果：池里**标了已应用**、但某台路由实际没跟上的（漂移）。
   * 这是用户最该先处理的：池说是共享的，路由却各行其是。
   */
  readonly drift = computed(() => {
    const st = this.ruleStatus();
    const out: { rule: PoolRules; routers: GroupStatusPerRouter[] }[] = [];
    for (const r of this.pool.rules()) {
      const marked = r.applied === true || st[r.id]?.applied === true;
      if (!marked) continue;
      const bad = driftedRouters(st[r.id]?.per ?? []);
      if (bad.length) out.push({ rule: r, routers: bad });
    }
    return out;
  });

  /** 某条规则当前是否「在漂移」（标了已应用但有路由没跟上） */
  isDrifted(r: PoolRules): boolean {
    return this.drift().some((d) => d.rule.id === r.id);
  }

  readonly note = signal('');
  /** 池里正在编辑的条目 id（null = 没在编辑） */
  readonly editingId = signal<string | null>(null);
  readonly editText = signal('');
  readonly editErr = signal('');
  /** 正在拖的池条目 id（池 → 同名节点覆盖） */
  readonly dragPoolId = signal<string | null>(null);
  /** 左栏某个节点行正被池条目悬停 */
  readonly overRow = signal<string | null>(null);
  /** 左栏里正在「查看配置」的节点 tag（null = 没展开） */
  readonly viewTag = signal<string | null>(null);

  /** 节点完整配置的只读 JSON 文本 */
  viewJson(row: SourceNode): string {
    return JSON.stringify(row.raw, null, 2);
  }

  toggleView(row: SourceNode, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.viewTag.set(this.viewTag() === row.tag ? null : row.tag);
  }

  copyView(row: SourceNode, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    void navigator.clipboard?.writeText(this.viewJson(row)).then(
      () => this.note.set(`已复制「${row.tag}」的配置 JSON`),
      () => this.note.set('复制失败：浏览器不允许剪贴板，手动选中复制即可'),
    );
  }
  readonly rulesNote = signal('');
  /** 批量弹窗：对哪条规则开着（null = 关）；mode 决定是「应用到全部」还是「解除应用」 */
  readonly batchFor = signal<PoolRules | null>(null);
  readonly batchMode = signal<'apply' | 'detach'>('apply');
  /** 后端规则桶清单（供「从规则集选」；空 = 还没拉或拉失败） */
  readonly buckets = signal<BucketInfo[]>([]);
  readonly bucketsErr = signal('');
  readonly bucketQuery = signal('');
  /** 新建共享规则：组名输入 + 正在挑的 refs */
  readonly newRuleOpen = signal(false);
  readonly newRuleGroup = signal('');
  readonly newRuleRefs = signal<string[]>([]);
  readonly newRuleErr = signal('');

  /** 按关键字过滤后的桶清单（不区分大小写） */
  readonly bucketsFiltered = computed(() => {
    const q = this.bucketQuery().trim().toLowerCase();
    const all = this.buckets();
    return q ? all.filter((b) => b.name.toLowerCase().includes(q)) : all;
  });

  /** 拉一次后端规则桶清单（进规则子页时拉；失败不致命，仍可手填） */
  async loadBuckets(): Promise<void> {
    this.bucketsErr.set('');
    try {
      this.buckets.set(await this.vault.listBuckets());
    } catch (e) {
      this.bucketsErr.set(errMsg(e));
    }
  }

  /** 规则条目编辑器正在用的 refs（以 textarea 文本为准，点选桶时同步写回文本） */
  private editRefsFromText(): string[] {
    return this.editRuleText()
      .split(/[\n,，]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  /** 编辑器里点一个桶：没在用就加，已在用就移除 */
  toggleBucketInEdit(name: string): void {
    const cur = this.editRefsFromText();
    const next = cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
    this.editRuleText.set(next.join('\n'));
  }

  bucketInEdit(name: string): boolean {
    return this.editRefsFromText().includes(name);
  }

  /** 新建共享规则时某桶是否已选 */
  bucketInNew(name: string): boolean {
    return this.newRuleRefs().includes(name);
  }

  /** 新建共享规则时点一个桶 */
  toggleBucketInNew(name: string): void {
    this.newRuleRefs.update((cur) => (cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name]));
  }

  /** 打开「新建共享规则」 */
  openNewRule(): void {
    this.newRuleOpen.set(true);
    this.newRuleGroup.set('');
    this.newRuleRefs.set([]);
    this.newRuleErr.set('');
    if (!this.buckets().length) void this.loadBuckets();
  }

  /** 保存新建的共享规则（组名必填；refs 可以全靠点选，不用手打） */
  saveNewRule(): void {
    const group = this.newRuleGroup().trim();
    if (!group) {
      this.newRuleErr.set('请填组名（= 路由上的出口 tag，如 🚀 节点选择）');
      return;
    }
    const res = this.pool.addRuleGroup(group, this.newRuleRefs());
    if (!res.ok) {
      this.newRuleErr.set(res.reason ?? '保存失败');
      return;
    }
    this.newRuleOpen.set(false);
    this.rulesNote.set(
      `已新建共享规则「${group}」（${this.newRuleRefs().length} 个规则集）。它是「未应用」状态——点「应用到全部」让各路由同步。`,
    );
    void this.refreshAllDocs(true);
  }

  /** 规则条目编辑：哪条在编、编辑中的 refs 文本（每行一个） */
  readonly editRuleId = signal<string | null>(null);
  readonly editRuleText = signal('');
  readonly editRuleErr = signal('');

  /** 「应用到所有路由」：打开预演弹窗 */
  openBatch(r: PoolRules): void {
    this.batchMode.set('apply');
    this.batchFor.set(r);
  }

  /** 解除应用：把这条共享规则从各路由撤掉（回到各自独立），同样走预演→逐台→汇总 */
  openDetach(r: PoolRules): void {
    this.batchMode.set('detach');
    this.batchFor.set(r);
  }

  /** 弹窗跑完：重新核对各路由状态；解除应用成功的话，把池里的「已应用」标记一并清掉 */
  onBatchFinished(): void {
    const r = this.batchFor();
    const sum = this.batch.summary();
    if (r && this.batchMode() === 'detach' && sum && sum.changed > 0) {
      this.pool.setRuleApplied(r.id, false);
      this.rulesNote.set(`已解除「${r.group}」的应用（${sum.changed} 台路由撤掉了共享规则）：这组回到各自独立管理`);
    } else {
      this.rulesNote.set('批量应用已结束，状态已按各路由实际配置重新核对');
    }
    void this.refreshAllDocs(true);
  }

  startEditRule(r: PoolRules): void {
    this.editRuleId.set(r.id);
    this.editRuleErr.set('');
    this.editRuleText.set(r.refs.join('\n'));
    if (!this.buckets().length) void this.loadBuckets();
  }

  cancelEditRule(): void {
    this.editRuleId.set(null);
    this.editRuleErr.set('');
  }

  /** 保存编辑：refs 变了就回到未应用，并提示去同步（未同步前各路由不受影响） */
  saveEditRule(r: PoolRules): void {
    const refs = this.editRuleText()
      .split(/[\n,，]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    const res = this.pool.updateRuleRefs(r.id, refs);
    if (!res.ok) {
      this.editRuleErr.set(res.reason ?? '保存失败');
      return;
    }
    const changed = !sameRefSet(refs, r.refs);
    this.editRuleId.set(null);
    if (changed) {
      this.rulesNote.set(
        `已修改「${r.group}」的规则集（${refs.length} 个）。它已回到「未应用」——点「应用到全部」让各路由同步；未同步前各路由保持原样、不受影响。`,
      );
    } else {
      this.rulesNote.set(`「${r.group}」没有变化`);
    }
  }

  /** 勾选待加入节点池的 tag */
  readonly picked = signal<string[]>([]);
  readonly importOpen = signal(false);
  readonly exportOpen = signal(false);
  readonly importText = signal('');
  /** 暂存草稿归属的路由（共享页里直接「保存并重启」用） */
  readonly draftTarget = signal<Backend | null>(null);

  ngOnInit(): void {
    const def = this.initialBackend() ?? this.bsvc.backends()[0] ?? null;
    if (def) {
      this.nodeBackend.set(def);
      this.ruleBackend.set(def);
    }
    void this.loadNodes();
    void this.loadRules();
    void this.refreshAllDocs();
  }

  /* ── 路由 tab ── */

  hostOf(b: Backend): string {
    return String(b.api ?? '')
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '');
  }

  isNode(b: Backend): boolean {
    return this.nodeBackend()?.api === b.api;
  }

  isRule(b: Backend): boolean {
    return this.ruleBackend()?.api === b.api;
  }

  pickNodeBackend(b: Backend): void {
    this.nodeBackend.set(b);
    this.picked.set([]);
    void this.loadNodes();
  }

  pickRuleBackend(b: Backend): void {
    this.ruleBackend.set(b);
    this.rulesNote.set('');
    void this.loadRules();
  }

  /** 切到规则子页时拉一次后端规则桶（选择器要用） */
  onSectionChange(sec: 'nodes' | 'rules'): void {
    this.section.set(sec);
    if (sec === 'rules' && !this.buckets().length) void this.loadBuckets();
  }

  /* ── 拉配置（带缓存 / 超时 / 防串台） ── */

  private seqNode = 0;
  private seqRule = 0;

  private withTimeout<T>(p: Promise<T>, ms = 12000): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error('读取配置超时（路由不可达？）')), ms)),
    ]);
  }

  private fetchDoc(b: Backend): Promise<ConfigDoc | null> {
    const key = b.api;
    const hit = this.docs.get(key);
    if (hit) return Promise.resolve(hit);
    const inflight = this.loads.get(key);
    if (inflight) return inflight;
    const p = this.withTimeout(this.router.config(b))
      .then((res) => {
        const doc = parseConfig(res.config);
        this.docs.set(key, doc);
        return doc;
      })
      .catch((e) => {
        this.loads.delete(key);
        throw e;
      })
      .finally(() => this.loads.delete(key));
    this.loads.set(key, p);
    return p;
  }

  /** 子页①：当前路由的节点清单（树形后：展开即加载；这里保留给刷新/切路由用） */
  async loadNodes(): Promise<void> {
    const b = this.nodeBackend();
    if (!b) return;
    this.nodeLoading.set(true);
    this.nodeErr.set('');
    await this.loadRouterView(b);
    this.nodeErr.set(this.viewErr(b.api));
    this.nodeLoading.set(false);
  }

  /** 子页②：当前路由的组名清单 */
  async loadRules(): Promise<void> {
    const b = this.ruleBackend();
    if (!b) return;
    this.ruleLoading.set(true);
    this.ruleErr.set('');
    await this.loadRouterView(b);
    this.ruleErr.set(this.viewErr(b.api));
    this.ruleLoading.set(false);
  }

  reload(): void {
    const b = this.section() === 'nodes' ? this.nodeBackend() : this.ruleBackend();
    if (b) this.docs.delete(b.api);
    if (this.section() === 'nodes') void this.loadNodes();
    else void this.loadRules();
  }

  /* ── ① 共享节点池 ── */

  /** 树里某一行被操作时：把它所属的路由设为「当前路由」，后续加入/拖拽都落到它上面 */
  focusRouter(b: Backend): void {
    if (this.nodeBackend()?.api !== b.api) {
      this.nodeBackend.set(b);
      this.ruleBackend.set(b);
      this.picked.set([]);
    }
  }

  togglePick(tag: string, on: boolean): void {
    // 已在共享池里的（同配置）不允许再勾选
    const row = this.src().find((r) => r.tag === tag);
    if (on && row && this.isShared(row)) {
      this.note.set(`「${tag}」的配置已经在共享池里了（标记 share），不用重复加入`);
      return;
    }
    this.picked.update((list) => (on ? [...new Set([...list, tag])] : list.filter((x) => x !== tag)));
  }

  isPicked(tag: string): boolean {
    return this.picked().includes(tag);
  }

  private addTags(tags: string[]): void {
    const b = this.nodeBackend();
    if (!b) return;
    const source = { api: b.api, name: b.name || b.api };
    const byTag = new Map(this.src().map((r) => [r.tag, r]));
    let added = 0;
    let dup = 0;
    const bad: string[] = [];
    for (const t of tags) {
      const row = byTag.get(t);
      if (!row) continue;
      const res = this.pool.addNode(source, row.raw, row.kind);
      if (!res.ok) bad.push(`${t}（${res.reason}）`);
      else if (res.dup) dup += 1;
      else added += 1;
    }
    this.picked.set([]);
    this.note.set(
      [added ? `已加入 ${added} 个` : '', dup ? `更新 ${dup} 个` : '', bad.length ? `跳过 ${bad.join('、')}` : '']
        .filter(Boolean)
        .join(' · ') || '没有变化',
    );
  }

  addPicked(): void {
    const shared = new Set(this.src().filter((r) => this.isShared(r)).map((r) => r.tag));
    this.addTags(this.picked().filter((t) => !shared.has(t)));
  }

  onDragStart(node: SourceNode, ev: DragEvent): void {
    if (this.isShared(node)) {
      ev.preventDefault();
      this.note.set(`「${node.tag}」的配置已经在共享池里了（标记 share），不用重复拖入`);
      return;
    }
    ev.dataTransfer?.setData('text/plain', node.tag);
    this.dragTag.set(node.tag);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
  }

  readonly dragTag = signal<string | null>(null);
  readonly over = signal(false);

  onDragOver(ev: DragEvent): void {
    if (!this.dragTag()) return;
    ev.preventDefault();
    this.over.set(true);
  }

  onDragLeave(): void {
    this.over.set(false);
  }

  onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.over.set(false);
    const tag = this.dragTag() ?? ev.dataTransfer?.getData('text/plain') ?? '';
    this.dragTag.set(null);
    if (tag) this.addTags([tag]);
  }

  /* ── 池条目：拖动覆盖同名节点 / 编辑 ── */

  startEdit(item: PoolNode): void {
    this.editingId.set(item.id);
    this.editErr.set('');
    this.editText.set(JSON.stringify(item.node, null, 2));
  }

  cancelEdit(): void {
    this.editingId.set(null);
    this.editErr.set('');
    this.editText.set('');
  }

  saveEdit(): void {
    const id = this.editingId();
    if (!id) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.editText());
    } catch (e) {
      this.editErr.set(`JSON 语法错误：${(e as Error).message}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.editErr.set('节点必须是一个 JSON 对象');
      return;
    }
    const res = this.pool.updateNode(id, parsed as AnyObj);
    if (!res.ok) {
      this.editErr.set(res.reason ?? '保存失败');
      return;
    }
    this.note.set('共享节点已更新（池内条目已替换）');
    this.cancelEdit();
  }

  onPoolDragStart(item: PoolNode, ev: DragEvent): void {
    ev.dataTransfer?.setData('text/plain', item.tag);
    this.dragPoolId.set(item.id);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
  }

  onRowDragOver(tag: string, ev: DragEvent): void {
    if (!this.dragPoolId()) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    if (this.overRow() !== tag) this.overRow.set(tag);
  }

  onRowDragLeave(tag: string): void {
    if (this.overRow() === tag) this.overRow.set(null);
  }

  /** 池里的节点拖到左栏某个节点上：只有同名可以覆盖（整体替换配置，保留 tag/位置） */
  async onRowDrop(targetTag: string, ev: DragEvent): Promise<void> {
    ev.preventDefault();
    this.overRow.set(null);
    const id = this.dragPoolId();
    this.dragPoolId.set(null);
    if (!id) return;
    const item = this.pool.nodes().find((n) => n.id === id);
    const b = this.nodeBackend();
    if (!item || !b) return;
    if (item.tag !== targetTag) {
      this.note.set(`只有同名节点可以覆盖：池里是「${item.tag}」，拖动的是「${targetTag}」`);
      return;
    }
    if (this.draftSvc.dirty()) {
      this.note.set('这台路由上还有未保存的草稿：先去「配置」页保存或还原，再覆盖同名节点');
      return;
    }
    this.note.set('覆盖中…');
    try {
      await this.draftSvc.load(b);
      const base = this.draftSvc.baseDoc();
      if (!base) {
        this.note.set(this.draftSvc.error() || '目标路由配置读不出来');
        return;
      }
      const doc: ConfigDoc = structuredClone(base);
      const res = replaceSameNameNode(doc, item, targetTag);
      if (!res.ok) {
        this.note.set(`未覆盖：${res.reason}`);
        return;
      }
      this.draftSvc.stage(doc);
      this.draftTarget.set(b);
      this.note.set(
        `已用共享池里「${item.tag}」的配置覆盖 ${b.name || b.api} 的同名节点（tag/位置不变）→ 点上面的「保存并重启」写回路由`,
      );
    } catch (e) {
      this.note.set(errMsg(e));
    }
  }

  remove(id: string): void {
    this.pool.removeNode(id);
    this.note.set('已从共享池移除');
  }

  clearAll(): void {
    this.pool.clear();
    this.note.set('共享池已清空');
  }

  openExport(): void {
    this.exportOpen.set(true);
    this.importOpen.set(false);
    this.importText.set(this.pool.exportJson());
  }

  openImport(): void {
    this.importOpen.set(true);
    this.exportOpen.set(false);
  }

  doExport(): void {
    void navigator.clipboard?.writeText(this.pool.exportJson()).then(
      () => this.note.set('已复制到剪贴板（也可以直接复制下面的文本）'),
      () => this.note.set('复制失败，请手动全选复制下面的文本'),
    );
  }

  doImport(): void {
    const res = this.pool.importJson(this.importText());
    this.note.set(res.ok ? `导入完成：新增 ${res.added} 个` : `导入失败：${res.error}`);
    if (res.ok) {
      this.importOpen.set(false);
      this.importText.set('');
    }
  }

  /* ── ② 共享规则池 ── */

  onGroupDragStart(b: Backend, row: { group: string; refs: string[] }, ev: DragEvent): void {
    ev.dataTransfer?.setData('text/plain', row.group);
    this.dragGroup.set({ api: b.api, group: row.group, refs: row.refs });
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
  }

  /** 正在被拖的组：连同它来自哪台路由、行上显示的那份 refs（行就是按这台路由的配置渲染的，直接用它） */
  readonly dragGroup = signal<{ api: string; group: string; refs: string[] } | null>(null);
  readonly overRules = signal(false);

  onRulesDragOver(ev: DragEvent): void {
    if (!this.dragGroup()) return;
    ev.preventDefault();
    this.overRules.set(true);
  }

  onRulesDragLeave(): void {
    this.overRules.set(false);
  }

  onRulesDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.overRules.set(false);
    const d = this.dragGroup();
    this.dragGroup.set(null);
    const plain = ev.dataTransfer?.getData('text/plain') ?? '';
    if (d) {
      const src = this.backends().find((x) => x.api === d.api) ?? null;
      if (src) this.addGroupToPool(src, d.group, d.refs);
    } else if (plain) {
      // 外部拖入（没有来源信息）：按当前路由兜底，refs 从它的视图里取
      const b = this.ruleBackend();
      if (b) this.addGroupToPool(b, plain);
    }
  }

  /**
   * 把某台路由上的一个组加入共享规则池。
   *
   * 必须按「这行来自哪台路由」取 refs，不能用 ruleDoc()：那是「最后一次展开的路由」的文档，
   * 多台同时展开时，在甲的行上点「＋」会拿到乙的配置算 refs，随后「应用到全部」把错的 refs 推到每台路由。
   * refs 优先用行上显示的那份（它就是从这台路由的配置渲染出来的）；没给再从该路由的缓存文档算。
   */
  addGroupToPool(b: Backend, group: string, refs?: string[]): void {
    if (!refs) {
      const view = this.viewOf(b.api).groups.find((g) => g.group === group);
      refs = view?.refs;
    }
    if (!refs) {
      this.rulesNote.set(`规则池：跳过「${group}」· 这台路由上没有这个组或它没挂规则集`);
      return;
    }
    const res = this.pool.addRuleGroup(group, refs, { api: b.api, name: b.name || b.api });
    this.rulesNote.set(
      res.ok
        ? `规则池：${res.dup ? '已更新' : '已加入'}「${group}」→ ${refs.length} 个规则集（状态：未应用）`
        : `规则池：跳过「${group}」· ${res.reason}`,
    );
    if (res.ok) void this.refreshAllDocs();
  }

  /** 读全部后端的配置（规则池要跨所有路由判断「已应用」） */
  async refreshAllDocs(force = false): Promise<void> {
    const list = this.backends();
    const next: Record<string, ConfigDoc | null> = { ...this.allDocs() };
    // force 的语义是「真去路由上重读」：必须先把每台的文档缓存丢掉，否则 fetchDoc 仍命中
    // apply 之前的旧配置，批量应用弹窗报「✓ 成功」而列表还显示「未应用 / 漂移」。
    if (force) for (const b of list) this.docs.delete(b.api);
    await Promise.all(
      list.map(async (b) => {
        if (!force && next[b.api]) return;
        try {
          next[b.api] = await this.fetchDoc(b);
        } catch {
          next[b.api] = null;
        }
      }),
    );
    this.allDocs.set(next);
  }

  /** 某条规则在各路由上的状态文字 */
  statusText(r: PoolRules): string {
    const st = this.ruleStatus()[r.id];
    if (!st) return '未应用';
    if (Object.keys(this.allDocs()).length === 0) return '正在核对各路由配置…';
    const used = st.per.filter((p) => p.hasOutbound || p.err);
    if (!used.length) return '未应用（没有路由有这个组名）';
    const unknown = unknownRouters(st.per);
    const bad = driftedRouters(st.per);
    if (!bad.length && unknown.length) return `已应用到 ${used.length - unknown.length} 台 · ${unknown.map((p) => p.name).join('、')} 没核对到`;
    if (!bad.length) return `已应用 · ${used.length} 台路由一致`;
    return `未应用 · ${bad.map((p) => p.name).join('、')} 未一致` + (unknown.length ? `（${unknown.map((p) => p.name).join('、')} 没核对到）` : '');
  }

  /** 手动把状态标成已应用（自动判定不成立时，用户确认用） */
  markApplied(r: PoolRules, applied: boolean): void {
    this.pool.setRuleApplied(r.id, applied);
    this.rulesNote.set(applied ? `已标记「${r.group}」为已应用` : `已把「${r.group}」改回未应用`);
  }

  addGroupRow(b: Backend, row: { group: string; refs: string[] }): void {
    this.addGroupToPool(b, row.group, row.refs);
  }

  /** 把规则池条目套用到当前（规则子页选中的）路由 */
  async applyRules(entry: { group: string; refs: string[] }): Promise<void> {
    const b = this.ruleBackend();
    if (!b) {
      this.rulesNote.set('先选一个目标路由');
      return;
    }
    if (this.draftSvc.dirty()) {
      this.rulesNote.set('这台路由上还有未保存的草稿：先去「配置」页保存或还原，再套用共享规则池');
      return;
    }
    this.rulesNote.set('套用中…');
    try {
      await this.draftSvc.load(b);
      const base = this.draftSvc.baseDoc();
      if (!base) {
        this.rulesNote.set(this.draftSvc.error() || '目标路由配置读不出来');
        return;
      }
      const doc: ConfigDoc = structuredClone(base);
      const res = applyGroupRefs(doc, entry.group, entry.refs);
      if (!res.ok) {
        this.rulesNote.set(`未套用：${res.reason}`);
        return;
      }
      this.draftSvc.stage(doc);
      this.draftTarget.set(b);
      const insertNote =
        res.insertedAt !== undefined
          ? `新加 1 条规则（落在 route.rules[${res.insertedAt}]，出口还是本路由自己的「${entry.group}」）`
          : `+${res.added.length} 规则集 / −${res.removed.length}` +
            (res.removedRules ? `，合并掉 ${res.removedRules} 条重复规则` : '');
      this.rulesNote.set(
        `已套用到 ${b.name || b.api} 的暂存草稿：「${entry.group}」${insertNote} → 点上面的「保存并重启」写回路由`,
      );
    } catch (e) {
      this.rulesNote.set(errMsg(e));
    }
  }

  async saveDraft(): Promise<void> {
    const b = this.draftTarget() ?? this.ruleBackend();
    if (!b) return;
    const setBoth = (msg: string): void => {
      this.rulesNote.set(msg);
      this.note.set(msg);
    };
    setBoth('保存中（备份 → 校验 → 替换 → 重启）…');
    await this.draftSvc.save(b);
    if (this.draftSvc.warn()) {
      setBoth(`⚠ ${this.draftSvc.warn()}`);
    } else if (this.draftSvc.needCreds()) {
      setBoth(`✗ ${this.draftSvc.error()}（先到「配置」页保存一次录入凭据）`);
    } else if (this.draftSvc.error()) {
      setBoth(`✗ ${this.draftSvc.error()}`);
    } else {
      setBoth(`✓ 已保存并重启 ${b.name || b.api}；草稿已清空`);
      this.draftTarget.set(null);
      this.docs.delete(b.api);
      this.allDocs.update((m) => ({ ...m, [b.api]: null }));
      await this.loadRules();
      await this.refreshAllDocs(true);
    }
  }

  async discardDraft(): Promise<void> {
    const b = this.draftTarget() ?? this.ruleBackend();
    this.draftTarget.set(null);
    this.rulesNote.set('已丢弃暂存修改');
    this.note.set('已丢弃暂存修改');
    if (b) await this.draftSvc.load(b);
  }
}
