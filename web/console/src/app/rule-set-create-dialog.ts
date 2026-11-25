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
  addRuleSet,
  addRuleSetRef,
  groups,
  nodes,
  previewRuleSetRef,
  routeRuleSets,
} from './config-ops';
import { VaultService } from './vault.service';

/** 命中框里的一行出站（分组 / 直连 / 拦截） */
interface OutboundOption {
  tag: string;
  label: string;
  special: boolean;
}

/**
 * ③ 列头「＋」新建规则集弹窗 — 写一条 route.rule_set 定义，并引用到某个出站。
 *
 * 为什么必须带「引用到出站」：流向 ③ 的卡片来自 route.rules（flow-model 只按 rules + final
 * 建有向图），只往 route rule_set 里塞定义不会出现在图上；所以这里一次把「定义」和
 * 「谁引用它」都写好，点保存并重启后才真正生效。
 *
 * 本组件只产出新文档（docChange），不直接写服务：流向页接 ConfigDraftService.stage，
 * 配置页接 enterReview —— 两条暂存链各自沿用原有语义。
 *
 * 桶文件本身（NAS 上的 <tag>.json/.srs）不在这里建：调用 /rule-set/index 查一下是否已存在，
 * 不存在就提示去「规则编辑」建好并发布，避免路由拉取 404。
 */
@Component({
  selector: 'app-rule-set-create-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rule-set-create-dialog.html',
})
export class RuleSetCreateDialog {
  /** 编辑基准（当前暂存草稿优先，没有则是刚读到的配置） */
  readonly base = input<ConfigDoc | null>(null);
  /** 新文档（调用方负责暂存） */
  readonly docChange = output<ConfigDoc>();
  readonly closed = output<void>();

  private readonly vault = inject(VaultService);

  /** 桶名 tag（与 NAS 桶同名，如 rs-openai） */
  readonly tag = signal('');
  /** remote = 从 url 定时拉；local = 读路由本机 path */
  readonly type = signal<'remote' | 'local'>('remote');
  /** remote 的格式：binary（.srs）/ source（.json） */
  readonly format = signal('binary');
  /** remote 下载地址 */
  readonly url = signal('');
  /** local 文件路径 */
  readonly path = signal('');
  /** remote 更新间隔 */
  readonly interval = signal('1m');
  /** remote 下载出站（可空） */
  readonly detour = signal('');
  /** 引用到哪个出站（分组 / 直连 / 拦截） */
  readonly outbound = signal('');
  /**
   * 引用插入位置：域名规则要排在 IP 规则（cn_ip / hk_ip）之前，否则 CN IP 先命中直连，
   * 新加的域名桶永远轮不到；IP 规则则相反。
   */
  readonly position = signal<RuleInsertPosition>('domain');
  /** 表单错误（红字） */
  readonly err = signal('');
  /** NAS 桶清单（null = 还没取到/接口不可用，此时不提示存在性） */
  readonly buckets = signal<string[] | null>(null);

  /** 用户是否手工改过 URL（改过就不再跟着 tag 自动生成） */
  private urlTouched = false;

  constructor() {
    // 打开时：默认引用第一个分组；顺带查一次 NAS 桶清单（失败静默，只影响提示）
    effect(() => {
      const d = this.base();
      const list = this.targets();
      untracked(() => {
        if (!d) return;
        if (!this.outbound() && list.length) this.outbound.set(list[0].tag);
      });
    });
    void this.loadBuckets();
  }

  /** 现有规则集 tag（重名检查） */
  readonly existingTags = computed(() => {
    const d = this.base();
    return new Set(d ? routeRuleSets(d).map((r) => String(r['tag'] ?? '')) : []);
  });

  /** 可引用的出站：全部分组在前，direct/block/dns 这类特殊出站垫底 */
  readonly targets = computed<OutboundOption[]>(() => {
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

  /** 现有 remote 规则的 URL 前缀（如 https://host/rule-set/）：新 URL 按它拼 */
  readonly urlPrefix = computed(() => {
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

  /** 按格式取的扩展名（binary=.srs / source=.json） */
  readonly urlExt = computed(() => (this.format() === 'source' ? '.json' : '.srs'));

  /** URL 占位提示：有模板时给出完整形态 */
  readonly urlPlaceholder = computed(() => {
    const p = this.urlPrefix();
    return p ? `${p}<桶名>${this.urlExt()}` : 'https://<域名>/rule-set/<桶名>.srs';
  });

  /** 落点预演文案：并入第几条 / 插到第几条（cn_ip 之前） */
  readonly insertHint = computed(() => {
    const d = this.base();
    const outbound = this.outbound().trim();
    if (!d || !outbound) return '';
    const pos = this.position();
    if (pos === 'auto') return '跟随现状：该出站已有 rule_set 规则就并入，否则插到最后（final 兜底之前）';
    try {
      const t = previewRuleSetRef(d, outbound, this.tag().trim() || '<新桶>', pos);
      if (t.mode === 'extend') return `并入 #${t.index}（该出站已有的规则，位置不变）`;
      if (t.where === 'end') return `插到 #${t.index}（final 兜底之前）`;
      return `插到 #${t.index}（${t.anchor || 'IP 规则'} ${t.where === 'before' ? '之前' : '之后'}）`;
    } catch {
      return '';
    }
  });

  /** NAS 上查不到该桶时的提醒（只在清单取到、且 tag 有意义时） */
  readonly bucketWarning = computed(() => {
    const name = this.tag().trim();
    const list = this.buckets();
    if (!name || !list || this.type() !== 'remote') return '';
    if (list.includes(name)) return '';
    return `NAS 桶清单里没有 ${name}：先到「规则编辑」建桶并发布 .srs，否则路由拉取会 404（不影响本次暂存）。`;
  });

  /** 取 NAS 桶清单（同源 /rule-set/index；失败保留 null） */
  private async loadBuckets(): Promise<void> {
    try {
      const list = await this.vault.listBuckets();
      this.buckets.set(list.map((b) => b.name));
    } catch {
      this.buckets.set(null);
    }
  }

  /** 改 tag：没手工改过 URL 时按模板同步生成 */
  setTag(v: string): void {
    this.tag.set(v);
    if (!this.urlTouched) this.syncAutoUrl();
  }

  /** 切格式：URL 扩展名跟着变（手工改过则不动） */
  setFormat(v: string): void {
    this.format.set(v);
    if (!this.urlTouched) this.syncAutoUrl();
  }

  /** 手工改 URL：之后不再自动覆盖 */
  setUrl(v: string): void {
    this.urlTouched = true;
    this.url.set(v);
  }

  setType(v: string): void {
    this.type.set(v === 'local' ? 'local' : 'remote');
  }

  /** 按「现有桶 URL 前缀 + tag + 扩展名」拼 URL */
  private syncAutoUrl(): void {
    const prefix = this.urlPrefix();
    const name = this.tag().trim();
    if (!prefix || !name) return;
    this.url.set(prefix + name + this.urlExt());
  }

  /** 提交：克隆基准 → 写定义 + 引用 → 抛给调用方暂存 */
  submit(): void {
    const base = this.base();
    if (!base) {
      this.err.set('配置还没读到，稍后再试');
      return;
    }
    const tag = this.tag().trim();
    if (!tag) {
      this.err.set('规则集 tag（桶名）不能为空');
      return;
    }
    if (this.existingTags().has(tag)) {
      this.err.set(`规则集 ${tag} 已经存在（同一个 tag 不能重复定义）`);
      return;
    }
    const outbound = this.outbound().trim();
    if (!outbound) {
      this.err.set('要选一个引用它的出站：没有分组就先去 ④ 新建分组');
      return;
    }
    const doc: ConfigDoc = structuredClone(base);
    try {
      addRuleSet(doc, {
        tag,
        type: this.type(),
        format: this.format(),
        url: this.url(),
        path: this.path(),
        updateInterval: this.interval(),
        downloadDetour: this.detour(),
      });
      addRuleSetRef(doc, outbound, tag, this.position());
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

  /** 点遮罩空白处关闭（点弹窗本体不关） */
  onMask(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.close();
  }
}