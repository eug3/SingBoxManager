import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import {
  ConfigDoc,
  RuleInsertPosition,
  addGroup,
  addRuleSet,
  addRuleSetRefs,
  groups,
  nodes,
  previewRuleSetRef,
  routeRuleSets,
} from './config-ops';
import { VaultService } from './vault.service';

/** 可引用/可选的出站 */
interface OutboundOption {
  tag: string;
  label: string;
  special: boolean;
}

/** 新分组的成员候选 */
interface MemberCandidate {
  tag: string;
  type: string;
  special: boolean;
  isGroup: boolean;
}

/**
 * ③ 列头「＋」：给一个分组（出口）配若干规则集桶（入口）。
 *
 * 语义（用户口径）：
 *  · 出口可以选现有分组，也可以**内联新建**一个分组（不需要先去 ④ 建）；
 *  · 入口可以多选现有桶，也可以**批量新建**（一行一个/逗号分隔，共用同一 URL 前缀与格式）；
 *  · 提交后写一条 `{rule_set:[a,b,…], outbound:分组}` —— 引用数组在 sing-box 里是 OR；
 *    落点仍按「域名规则排到 IP 桶之前 / IP 规则排到其后」预览。
 *
 * 只写 config（定义 + 引用），不建 NAS 桶文件；桶内容去「规则编辑」改并发布。
 * 产出新文档（docChange），由调用方 stage 到 ConfigDraftService 或进入配置页复核。
 */
@Component({
  selector: 'app-rule-set-create-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rule-set-create-dialog.html',
})
export class RuleSetCreateDialog {
  readonly base = input<ConfigDoc | null>(null);
  readonly docChange = output<ConfigDoc>();
  readonly closed = output<void>();

  private readonly vault = inject(VaultService);

  /* ── 出口（分组） ── */
  /** existing = 选已有分组；new = 内联新建 */
  readonly groupMode = signal<'existing' | 'new'>('existing');
  readonly groupTag = signal('');
  readonly newGroupTag = signal('');
  readonly newGroupType = signal<'selector' | 'urltest'>('selector');
  /** 新分组成员（按勾选顺序） */
  readonly newGroupMembers = signal<string[]>([]);

  /* ── 入口（桶） ── */
  /** 勾选到的现有桶 */
  readonly picked = signal<string[]>([]);
  /** 批量新建：逗号 / 空格 / 换行分隔 */
  readonly newTagsText = signal('');
  /** 新建桶的类型与格式（remote 才有 format/interval/detour） */
  readonly type = signal<'remote' | 'local'>('remote');
  readonly format = signal('binary');
  readonly interval = signal('1m');
  readonly detour = signal('');
  readonly path = signal('');
  /** 手工改过 URL 前缀（默认取 config 里第一个 remote 桶的前缀） */
  private prefixTouched = false;
  readonly prefixInput = signal('');

  /* ── 落点 ── */
  readonly position = signal<RuleInsertPosition>('domain');

  readonly err = signal('');
  /** NAS 桶清单（null = 没取到，不提示存在性） */
  readonly buckets = signal<string[] | null>(null);

  constructor() {
    effect(() => {
      const d = this.base();
      const list = this.groupOptions();
      untracked(() => {
        if (!d) return;
        if (!this.groupTag() && list.length) this.groupTag.set(list[0].tag);
      });
    });
    void this.loadBuckets();
  }

  /* ── 计算 ── */

  /** 现有 rule_set 定义（tag + 被引用次数） */
  readonly bucketList = computed<{ tag: string; refs: number }[]>(() => {
    const d = this.base();
    if (!d) return [];
    const counts = new Map<string, number>();
    const route = d.root['route'] as Record<string, unknown> | undefined;
    for (const r of (route?.['rules'] as Record<string, unknown>[]) ?? []) {
      const v = r?.['rule_set'];
      const tags = typeof v === 'string' ? [v] : Array.isArray(v) ? v.map(String) : [];
      for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return routeRuleSets(d).map((r) => {
      const tag = String(r['tag'] ?? '');
      return { tag, refs: counts.get(tag) ?? 0 };
    });
  });

  readonly existingTags = computed(() => new Set(this.bucketList().map((b) => b.tag)));

  /** 出口候选：分组在前，直连/拦截等特殊出站垫底 */
  readonly groupOptions = computed<OutboundOption[]>(() => {
    const d = this.base();
    if (!d) return [];
    const gs = groups(d).map((g) => ({
      tag: String(g['tag']),
      label: `${String(g['tag'])}（分组 · ${String(g['type'])}）`,
      special: false,
    }));
    const sp = nodes(d)
      .filter((n) => n.special)
      .map((n) => ({ tag: n.tag, label: `${n.tag}（${n.type}）`, special: true }));
    return [...gs, ...sp];
  });

  /** 新分组成员候选：节点 + 现有分组 */
  readonly memberCandidates = computed<MemberCandidate[]>(() => {
    const d = this.base();
    if (!d) return [];
    const out: MemberCandidate[] = nodes(d).map((n) => ({
      tag: n.tag,
      type: n.type,
      special: n.special,
      isGroup: false,
    }));
    for (const g of groups(d)) {
      out.push({ tag: String(g['tag']), type: String(g['type']), special: false, isGroup: true });
    }
    return out;
  });

  /** 批量新建的 tag（去重、过滤空） */
  readonly parsedNew = computed<string[]>(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of this.newTagsText().split(/[,，\s]+/)) {
      const t = raw.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  });

  /** 真正要新建的（配置里没有的） */
  readonly toCreate = computed(() => this.parsedNew().filter((t) => !this.existingTags().has(t)));

  /** 输入里已经存在、会被“改为引用”的 tag */
  readonly alreadyThere = computed(() => this.parsedNew().filter((t) => this.existingTags().has(t)));

  /** 最终引用到该分组的全部桶（勾选 + 输入） */
  readonly allTags = computed(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [...this.picked(), ...this.parsedNew()]) {
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  });

  /* ── URL 前缀（新建 remote 桶共用） ── */
  readonly urlPrefix = computed(() => {
    if (this.prefixTouched) return this.prefixInput();
    const d = this.base();
    if (!d) return '';
    for (const rs of routeRuleSets(d)) {
      const u = String(rs['url'] ?? '');
      if (!u) continue;
      const i = u.lastIndexOf('/');
      return i >= 0 ? u.slice(0, i + 1) : '';
    }
    return '';
  });
  readonly urlExt = computed(() => (this.format() === 'source' ? '.json' : '.srs'));
  readonly urlPlaceholder = computed(() =>
    this.urlPrefix() ? `${this.urlPrefix()}<桶名>${this.urlExt()}` : 'https://<域名>/rule-set/<桶名>.srs',
  );
  /** 新建桶的 URL 示例（第一条） */
  readonly urlSample = computed(() => {
    const t = this.toCreate()[0];
    return t ? `${this.urlPrefix()}${t}${this.urlExt()}` : '';
  });

  /** 出口 tag（新建时用输入值） */
  readonly outboundTag = computed(() =>
    (this.groupMode() === 'new' ? this.newGroupTag() : this.groupTag()).trim(),
  );

  /** 落点预演 */
  readonly insertHint = computed(() => {
    const d = this.base();
    const outbound = this.outboundTag();
    const tag = this.allTags()[0];
    if (!d || !outbound || !tag) return '';
    const pos = this.position();
    if (pos === 'auto') return '跟随现状：该出站已有 rule_set 规则就并入，否则插到最后（final 兜底之前）';
    try {
      const t = previewRuleSetRef(d, outbound, tag, pos);
      if (t.mode === 'extend') return `并入 #${t.index}（该出站已有的规则，位置不变）`;
      if (t.where === 'end') return `插到 #${t.index}（final 兜底之前）`;
      return `插到 #${t.index}（${t.anchor || 'IP 规则'} ${t.where === 'before' ? '之前' : '之后'}）`;
    } catch {
      return '';
    }
  });

  /** NAS 上缺哪些新桶 */
  readonly bucketWarning = computed(() => {
    const list = this.buckets();
    if (!list) return '';
    const missing = this.toCreate().filter((t) => !list.includes(t));
    if (!missing.length) return '';
    return `NAS 桶清单里没有：${missing.join('、')} —— 先去「规则编辑」建桶并发布，否则路由拉取会 404（不影响本次暂存）。`;
  });

  /* ── 交互 ── */

  togglePick(tag: string, on: boolean): void {
    this.picked.update((list) => (on ? [...new Set([...list, tag])] : list.filter((t) => t !== tag)));
  }

  isPicked(tag: string): boolean {
    return this.picked().includes(tag);
  }

  toggleMember(tag: string, on: boolean): void {
    this.newGroupMembers.update((list) => (on ? [...new Set([...list, tag])] : list.filter((t) => t !== tag)));
  }

  isMember(tag: string): boolean {
    return this.newGroupMembers().includes(tag);
  }

  setPrefix(v: string): void {
    this.prefixTouched = true;
    this.prefixInput.set(v);
  }

  private async loadBuckets(): Promise<void> {
    try {
      const list = await this.vault.listBuckets();
      this.buckets.set(list.map((b) => b.name));
    } catch {
      this.buckets.set(null);
    }
  }

  /* ── 提交 ── */

  submit(): void {
    const base = this.base();
    if (!base) {
      this.err.set('配置还没读到，稍后再试');
      return;
    }
    const tags = this.allTags();
    if (!tags.length) {
      this.err.set('至少要选一个现有桶，或填一个新桶名');
      return;
    }
    const mode = this.groupMode();
    const group = this.outboundTag();
    if (!group) {
      this.err.set(mode === 'new' ? '新分组的 tag 不能为空' : '要选一个出口分组');
      return;
    }
    if (mode === 'new') {
      if (this.groupOptions().some((g) => g.tag === group)) {
        this.err.set(`分组 ${group} 已存在：把出口改回「选现有分组」即可`);
        return;
      }
      if (!this.newGroupMembers().length) {
        this.err.set('新分组至少要勾一个成员（节点或分组）');
        return;
      }
    }
    if (this.type() === 'local' && this.toCreate().length > 1) {
      this.err.set('local 类型一次只能建一个桶（路径各不相同）：批量新建请用 remote');
      return;
    }
    if (this.type() === 'remote' && !this.urlPrefix().trim()) {
      this.err.set('配置里没有可参考的 remote URL 前缀：请先在「URL 前缀」里填 https://…/rule-set/');
      return;
    }
    const doc: ConfigDoc = structuredClone(base);
    try {
      if (mode === 'new') {
        addGroup(doc, { tag: group, type: this.newGroupType(), members: this.newGroupMembers() });
      }
      for (const tag of this.toCreate()) {
        addRuleSet(doc, {
          tag,
          type: this.type(),
          format: this.format(),
          url: this.type() === 'remote' ? `${this.urlPrefix()}${tag}${this.urlExt()}` : '',
          path: this.type() === 'local' ? this.path() : '',
          updateInterval: this.interval(),
          downloadDetour: this.detour(),
        });
      }
      addRuleSetRefs(doc, group, tags, this.position());
    } catch (e) {
      this.err.set((e as Error)?.message ?? String(e));
      return;
    }
    this.err.set('');
    this.docChange.emit(doc);
    this.closed.emit();
  }

  close(): void {
    this.closed.emit();
  }

  onMask(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.close();
  }
}