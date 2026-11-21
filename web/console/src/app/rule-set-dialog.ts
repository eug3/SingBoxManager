import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Backend } from './models';
import { AnyObj, ConfigDoc, groups } from './config-ops';
import { ConfigDraftService } from './config-draft.service';

/** rule_set 引用归一化：sing-box 允许字符串或字符串数组 */
function refTags(r: AnyObj): string[] {
  const v = r['rule_set'];
  if (typeof v === 'string') return v ? [v] : [];
  return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
}

/** 非匹配条件字段（与 flow-model 同一口径）：这些键不构成匹配条件 */
const NON_MATCH_KEYS = new Set(['outbound', 'action', 'rule_set', 'type', 'mode', 'rules', 'invert', 'method']);

/**
 * 「final 兜底规则」：带 outbound、没有任何匹配条件、也不是 logical 嵌套。
 * 新引用要插在它前面（route.final 是独立字段，天然在所有 rules 之后）。
 * 不带 outbound 的动作规则（sniff / hijack-dns）不算兜底，别插到它们前面去。
 */
function isFinalRule(r: AnyObj): boolean {
  if (typeof r['outbound'] !== 'string' || !r['outbound']) return false;
  if (refTags(r).length || Array.isArray(r['rules'])) return false;
  return Object.keys(r).every((k) => NON_MATCH_KEYS.has(k));
}

/**
 * ③ 规则集编辑弹窗 — 给一个分组增删 rule_set 引用。
 *
 *  · 已应用区：该分组当前引用的桶（chips，× 移除），也是拖拽的落点；
 *  · palette：config route.rule_set 里全部 tag（排除已应用），可拖拽 / 点 + 添加；
 *  · 添加 = 扩展该分组已有 rule_set 规则的数组；没有就在 final 兜底规则前
 *    插入 {rule_set:[tag], outbound:分组}；删除 = 从数组移除，空则删整条规则；
 *  · 不碰 rule_set 定义本身（桶还在）；每次改动克隆当前文档 → stage() 暂存，
 *    写回路由由顶部「待保存条」统一做。
 */
@Component({
  selector: 'app-rule-set-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  templateUrl: './rule-set-dialog.html',
})
export class RuleSetDialog {
  readonly group = input.required<string>();
  readonly backend = input.required<Backend>();
  readonly closed = output<void>();

  private readonly draft = inject(ConfigDraftService);

  /** 工作文档：优先当前草稿（可连续编辑多个分组），没有则用只读基准 */
  readonly work = computed<ConfigDoc | null>(() => this.draft.draft() ?? this.draft.baseDoc());

  /** 该分组是否存在于配置（DIRECT/block 这类非分组出站不可编辑） */
  readonly groupExists = computed(() => {
    const d = this.work();
    return !!d && groups(d).some((g) => String(g['tag']) === this.group());
  });

  private readonly rules = computed<AnyObj[]>(() => {
    const route = this.work()?.root['route'];
    const rules = route && typeof route === 'object' ? (route as AnyObj)['rules'] : undefined;
    return Array.isArray(rules) ? (rules as AnyObj[]) : [];
  });

  /** 已应用的桶 tag（该分组全部 rule_set 规则去重合并，保持出现顺序） */
  readonly applied = computed<string[]>(() => {
    const out: string[] = [];
    for (const r of this.rules()) {
      if (!r || r['outbound'] !== this.group()) continue;
      for (const t of refTags(r)) if (!out.includes(t)) out.push(t);
    }
    return out;
  });

  /** 可用规则集：route.rule_set 全部 tag 排除已应用（remote/local 都收） */
  readonly palette = computed<{ tag: string; type: string }[]>(() => {
    const route = this.work()?.root['route'];
    const list = route && typeof route === 'object' ? (route as AnyObj)['rule_set'] : undefined;
    if (!Array.isArray(list)) return [];
    const used = new Set(this.applied());
    const out: { tag: string; type: string }[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rs = item as AnyObj;
      const tag = String(rs['tag'] ?? '');
      if (!tag || used.has(tag)) continue;
      out.push({ tag, type: String(rs['type'] ?? 'local') });
    }
    return out;
  });

  /** 拖拽状态：落点高亮 + 被拖 chip 半透明 */
  readonly dragOver = signal(false);
  readonly dragging = signal('');

  /** 克隆当前文档 → 修改 → 暂存（绝不改 baseDoc / 上一份草稿的引用） */
  private mutate(fn: (doc: ConfigDoc) => void): void {
    const base = this.work();
    if (!base || !this.groupExists()) return;
    const doc = structuredClone(base);
    fn(doc);
    this.draft.stage(doc);
  }

  /** 添加引用：优先扩展该分组已有的 rule_set 规则，否则在 final 前插一条新规则 */
  add(tag: string): void {
    if (!tag || this.applied().includes(tag)) return;
    const group = this.group();
    this.mutate((doc) => {
      const route = this.ensureRoute(doc);
      const rules = this.ensureRules(route);
      const existing = rules.find((r) => r && r['outbound'] === group && refTags(r).length > 0);
      if (existing) {
        const refs = refTags(existing);
        if (!refs.includes(tag)) refs.push(tag);
        existing['rule_set'] = refs; // 字符串引用也归一化成数组
        return;
      }
      const at = rules.findIndex((r) => r && isFinalRule(r));
      const rule: AnyObj = { rule_set: [tag], outbound: group };
      if (at >= 0) rules.splice(at, 0, rule);
      else rules.push(rule);
    });
  }

  /** 移除引用：从该分组的 rule_set 数组里删 tag；数组空则删整条规则（桶定义不动） */
  remove(tag: string): void {
    const group = this.group();
    this.mutate((doc) => {
      const route = doc.root['route'];
      if (!route || typeof route !== 'object' || !Array.isArray((route as AnyObj)['rules'])) return;
      const rules = (route as AnyObj)['rules'] as AnyObj[];
      const keep: AnyObj[] = [];
      for (const r of rules) {
        if (!r || r['outbound'] !== group || !refTags(r).includes(tag)) {
          keep.push(r);
          continue;
        }
        const refs = refTags(r).filter((t) => t !== tag);
        if (refs.length) {
          r['rule_set'] = refs;
          keep.push(r);
        } // 引用空了：整条规则丢弃
      }
      (route as AnyObj)['rules'] = keep;
    });
  }

  private ensureRoute(doc: ConfigDoc): AnyObj {
    let route = doc.root['route'];
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      route = {};
      doc.root['route'] = route;
    }
    return route as AnyObj;
  }

  private ensureRules(route: AnyObj): AnyObj[] {
    if (!Array.isArray(route['rules'])) route['rules'] = [];
    return route['rules'] as AnyObj[];
  }

  /* ── 拖拽（palette chip → 已应用区） ── */

  onDragStart(tag: string, ev: DragEvent): void {
    ev.dataTransfer?.setData('text/plain', tag);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
    this.dragging.set(tag);
  }

  onDragEnd(): void {
    this.dragging.set('');
    this.dragOver.set(false);
  }

  onDragOver(ev: DragEvent): void {
    ev.preventDefault(); // 不拦默认行为就不触发 drop
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    this.dragOver.set(true);
  }

  onDragLeave(ev: DragEvent): void {
    // 在落点内部子元素间移动也会触发 dragleave：relatedTarget 还在区内就不灭灯
    const to = ev.relatedTarget as Node | null;
    if (to && (ev.currentTarget as Node | null)?.contains(to)) return;
    this.dragOver.set(false);
  }

  onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.dragOver.set(false);
    const tag = ev.dataTransfer?.getData('text/plain') || this.dragging();
    this.dragging.set('');
    if (tag) this.add(tag);
  }

  /* ── 关闭 ── */

  close(): void {
    this.closed.emit();
  }

  /** 点遮罩空白处关闭（点弹窗本体不关） */
  onMask(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.close();
  }
}