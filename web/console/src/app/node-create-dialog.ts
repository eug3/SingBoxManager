import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { AnyObj, ConfigDoc, addNode, findNode, groups, updateNode } from './config-ops';
import { NODE_TYPES, NodeForm, buildNode, emptyForm, formFromNode } from './node-form';
import { ParsedNode, parseShareLinks } from './share-link';

/** 录入方式：表单单节点 / 分享链接批量 */
type EntryMode = 'form' | 'links';

/**
 * ⑤ 列头「＋」新建节点 / 配置页「新增/编辑节点」共用弹窗。
 *
 * 两个页签：
 *  · 表单：复用 node-form.ts（buildNode 校验 + 按协议组装；编辑时 formFromNode 回填）；
 *  · 分享链接：复用 share-link.ts 的 parseShareLinks（ss/vmess/vless/trojan/hy2/socks，逐行预览）。
 * 两个页签共用「加入分组」勾选，提交后即产出新文档（docChange），由调用方决定暂存链：
 *  · 流向页 → ConfigDraftService.stage（顶部待保存条）；
 *  · 配置页 → enterReview（暂存文本 + diff）。
 *
 * 编辑模式（editing 有值）只能改表单页，tag 不可改（updateNode 保留原 tag）。
 */
@Component({
  selector: 'app-node-create-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './node-create-dialog.html',
})
export class NodeCreateDialog {
  /** 编辑基准（当前暂存草稿优先） */
  readonly base = input<ConfigDoc | null>(null);
  /** 要编辑的节点 tag；null = 新增 */
  readonly editing = input<string | null>(null);
  readonly docChange = output<ConfigDoc>();
  readonly closed = output<void>();

  /** 当前页签（编辑模式恒为 form） */
  readonly mode = signal<EntryMode>('form');
  /** 表单字段（模型见 node-form.ts） */
  readonly form = signal<NodeForm>(emptyForm());
  /** 加入分组（表单页与链接页共用） */
  readonly groupsSel = signal<string[]>([]);
  /** 分享链接原文 */
  readonly linksText = signal('');
  /** 逐行解析结果 */
  readonly parsed = signal<ParsedNode[]>([]);
  /** 表单/导入错误 */
  readonly err = signal('');

  /** 类型下拉的协议清单 */
  readonly nodeTypes = NODE_TYPES;
  /** 是否编辑既有节点 */
  readonly isEdit = computed(() => !!this.editing());

  /** 现有分组名（勾选项） */
  readonly groupNames = computed(() => {
    const d = this.base();
    return d ? groups(d).map((g) => String(g['tag'])) : [];
  });

  /** 分享链接里可导入的条数 */
  readonly importable = computed(() => this.parsed().filter((r) => r.ok && r.node).length);

  constructor() {
    // 编辑模式：按 tag 回填表单 + 预勾当前分组；新增模式保持空表单
    effect(() => {
      const d = this.base();
      const tag = this.editing();
      if (!tag || !d) return;
      const n = findNode(d, tag);
      if (!n) return;
      untracked(() => {
        this.form.set(formFromNode(tag, n));
        this.groupsSel.set(
          groups(d)
            .filter((g) => Array.isArray(g['outbounds']) && (g['outbounds'] as string[]).includes(tag))
            .map((g) => String(g['tag'])),
        );
        this.mode.set('form');
      });
    });
  }

  /** 切页签（编辑模式不允许切到分享链接） */
  setMode(m: EntryMode): void {
    if (this.isEdit() && m === 'links') return;
    this.mode.set(m);
    this.err.set('');
  }

  /** 受控更新单个表单字段 */
  patch<K extends keyof NodeForm>(key: K, value: NodeForm[K]): void {
    this.form.update((f) => ({ ...f, [key]: value }));
  }

  /** 勾选 / 取消一个分组归属 */
  toggleGroup(name: string, on: boolean): void {
    this.groupsSel.update((list) => {
      const has = list.includes(name);
      if (on && !has) return [...list, name];
      if (!on && has) return list.filter((x) => x !== name);
      return list;
    });
  }

  isGroupOn(name: string): boolean {
    return this.groupsSel().includes(name);
  }

  /** 表单提交：buildNode 校验 → addNode / updateNode → 抛新文档 */
  submitForm(): void {
    const base = this.base();
    if (!base) {
      this.err.set('配置还没读到，稍后再试');
      return;
    }
    const built = buildNode(this.form());
    if (!built.ok) {
      this.err.set(built.error);
      return;
    }
    const doc: ConfigDoc = structuredClone(base);
    try {
      if (this.isEdit()) updateNode(doc, this.editing()!, built.node, this.groupsSel());
      else addNode(doc, built.node, this.groupsSel());
    } catch (e) {
      this.err.set((e as Error)?.message ?? String(e));
      return;
    }
    this.err.set('');
    this.docChange.emit(doc);
    this.closed.emit();
  }

  /** 解析粘贴的分享链接（每行一条） */
  onLinks(v: string): void {
    this.linksText.set(v);
    this.parsed.set(parseShareLinks(v));
  }

  /** 批量导入：把解析成功的节点逐个 addNode（同名 tag 自动加 -2） */
  submitLinks(): void {
    const base = this.base();
    if (!base) {
      this.err.set('配置还没读到，稍后再试');
      return;
    }
    const good = this.parsed().filter((r) => r.ok && r.node);
    if (!good.length) {
      this.err.set('没有可导入的链接（检查格式或协议是否支持）');
      return;
    }
    const doc: ConfigDoc = structuredClone(base);
    const added: string[] = [];
    try {
      for (const r of good) added.push(addNode(doc, r.node as AnyObj, this.groupsSel()));
    } catch (e) {
      this.err.set((e as Error)?.message ?? String(e));
      return;
    }
    this.err.set('');
    this.linksText.set('');
    this.parsed.set([]);
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