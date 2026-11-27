import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import {
  AnyObj,
  ConfigDoc,
  applyGroupRefs,
  endpoints,
  groupRuleRefs,
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
import { PoolNode, SharedPoolService, nodeFingerprint, replaceSameNameNode } from './shared-pool.service';
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
  templateUrl: './shared-panel.html',
})
export class SharedPanel implements OnInit {
  /** 打开时的默认后端（顶栏当前 tab） */
  readonly initialBackend = input<Backend | null>(null);

  private readonly router = inject(RouterService);
  private readonly bsvc = inject(BackendsService);
  /** 共享规则池的套用落到这个草稿服务（待保存条 / 应用并重启链路与流向图一致） */
  readonly draftSvc = inject(ConfigDraftService);
  readonly pool = inject(SharedPoolService);

  readonly backends = this.bsvc.backends;
  /** 当前子页签 */
  readonly section = signal<Section>('nodes');

  /* ── 两个子页各自的路由选择 ── */
  readonly nodeBackend = signal<Backend | null>(null);
  readonly ruleBackend = signal<Backend | null>(null);

  /** 配置缓存：同一台路由只拉一次（两个子页共用，切页签不重复请求） */
  private readonly docs = new Map<string, ConfigDoc>();
  private readonly loads = new Map<string, Promise<ConfigDoc | null>>();
  readonly nodeDoc = signal<ConfigDoc | null>(null);
  readonly ruleDoc = signal<ConfigDoc | null>(null);
  readonly nodeErr = signal('');
  readonly ruleErr = signal('');
  readonly nodeLoading = signal(false);
  readonly ruleLoading = signal(false);

  /** 节点池左栏：当前路由的可共享节点 */
  readonly src = signal<SourceNode[]>([]);
  /** 规则池左栏：当前路由里挂了规则集的组名 */
  readonly groupRows = computed(() => {
    const d = this.ruleDoc();
    return d ? groupsWithRuleRefs(d) : [];
  });

  /** 池内指纹集合：路由上同配置的节点要打 share 标记、且不能再拖进去 */
  readonly poolKeys = computed(() => this.pool.fingerprints());

  /** 这个节点是否已经在共享池里（同配置，tag 不同也算） */
  isShared(row: SourceNode): boolean {
    return this.poolKeys().has(nodeFingerprint(row.raw, row.kind));
  }

  readonly groups = computed(() => this.pool.bySource());
  readonly total = computed(() => this.pool.nodes().length);
  readonly rulesGroups = computed(() => this.pool.rulesBySource());
  readonly rulesTotal = computed(() => this.pool.rules().length);

  readonly note = signal('');
  /** 池里正在编辑的条目 id（null = 没在编辑） */
  readonly editingId = signal<string | null>(null);
  readonly editText = signal('');
  readonly editErr = signal('');
  /** 正在拖的池条目 id（池 → 同名节点覆盖） */
  readonly dragPoolId = signal<string | null>(null);
  /** 左栏某个节点行正被池条目悬停 */
  readonly overRow = signal<string | null>(null);
  readonly rulesNote = signal('');
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

  /** 子页①：节点清单 */
  async loadNodes(): Promise<void> {
    const b = this.nodeBackend();
    if (!b) {
      this.nodeErr.set('没有后端：先在上面「＋ 添加后端」');
      return;
    }
    const seq = ++this.seqNode;
    this.nodeLoading.set(true);
    this.nodeErr.set('');
    this.src.set([]);
    try {
      const doc = await this.fetchDoc(b);
      if (seq !== this.seqNode || !doc) return;
      this.nodeDoc.set(doc);
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
      // 特殊出站（DIRECT/REJECT）不是「节点」，分组也不进共享候选
      this.src.set(rows.filter((r) => !r.special && !gs.has(r.tag)));
    } catch (e) {
      if (seq === this.seqNode) this.nodeErr.set(errMsg(e));
    } finally {
      if (seq === this.seqNode) this.nodeLoading.set(false);
    }
  }

  /** 子页②：组名清单 */
  async loadRules(): Promise<void> {
    const b = this.ruleBackend();
    if (!b) {
      this.ruleErr.set('没有后端：先在上面「＋ 添加后端」');
      return;
    }
    const seq = ++this.seqRule;
    this.ruleLoading.set(true);
    this.ruleErr.set('');
    this.ruleDoc.set(null);
    try {
      const doc = await this.fetchDoc(b);
      if (seq !== this.seqRule || !doc) return;
      this.ruleDoc.set(doc);
    } catch (e) {
      if (seq === this.seqRule) this.ruleErr.set(errMsg(e));
    } finally {
      if (seq === this.seqRule) this.ruleLoading.set(false);
    }
  }

  reload(): void {
    const b = this.section() === 'nodes' ? this.nodeBackend() : this.ruleBackend();
    if (b) this.docs.delete(b.api);
    if (this.section() === 'nodes') void this.loadNodes();
    else void this.loadRules();
  }

  /* ── ① 共享节点池 ── */

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

  onGroupDragStart(row: { group: string; refs: string[] }, ev: DragEvent): void {
    ev.dataTransfer?.setData('text/plain', row.group);
    this.dragGroup.set(row.group);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
  }

  readonly dragGroup = signal<string | null>(null);
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
    const g = this.dragGroup() ?? ev.dataTransfer?.getData('text/plain') ?? '';
    this.dragGroup.set(null);
    if (g) this.addGroupToPool(g);
  }

  addGroupToPool(group: string): void {
    const b = this.ruleBackend();
    const doc = this.ruleDoc();
    if (!b || !doc) return;
    const refs = groupRuleRefs(doc, group);
    const res = this.pool.addRuleGroup({ api: b.api, name: b.name || b.api }, group, refs);
    this.rulesNote.set(
      res.ok
        ? `规则池：${res.dup ? '已更新' : '已加入'}「${group}」→ ${refs.length} 个规则集`
        : `规则池：跳过「${group}」· ${res.reason}`,
    );
  }

  addGroupRow(row: { group: string }): void {
    this.addGroupToPool(row.group);
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
      await this.loadRules();
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
