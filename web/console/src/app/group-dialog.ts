import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { Backend } from './models';
import { AnyObj, ConfigDoc, GROUP_TYPES, groups, nodes } from './config-ops';
import { ConfigDraftService } from './config-draft.service';

/** urltest 缺省参数（sing-box 官方默认口径；切到 urltest 时补上，可再改） */
const URLTEST_DEFAULT_URL = 'https://www.gstatic.com/generate_204';
const URLTEST_DEFAULT_INTERVAL = '3m';
const URLTEST_DEFAULT_TOLERANCE = 50;

/** 候选成员行（checkbox 列表用） */
interface MemberCandidate {
  tag: string;
  type: string;
  /** 其它分组（可嵌套勾选） */
  isGroup: boolean;
  /** direct/block/dns 等特殊出站 */
  special: boolean;
}

/**
 * ④ 分组编辑弹窗 — 改一个 selector/urltest 分组的成员与类型。
 *
 *  · 成员 = 所有代理节点（含 direct/block 等特殊出站与 endpoints）+ 其它分组（可嵌套，排除自身）；
 *  · 类型 select：selector / urltest；urltest 显示 url / interval / tolerance 输入；
 *  · 每次改动克隆当前文档 → 改 outbounds[分组] → stage() 暂存；
 *    移除成员时联动修正 default（不在成员里 → 第一个成员；组空 → 删键），
 *    与 group-board-model / config-ops.updateNode 同一口径。
 */
@Component({
  selector: 'app-group-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  templateUrl: './group-dialog.html',
})
export class GroupDialog {
  readonly group = input.required<string>();
  readonly backend = input.required<Backend>();
  readonly closed = output<void>();

  private readonly draft = inject(ConfigDraftService);

  /** 工作文档：优先当前草稿（可连续编辑），没有则用只读基准 */
  readonly work = computed<ConfigDoc | null>(() => this.draft.draft() ?? this.draft.baseDoc());

  /** 目标分组对象（只读派生；修改一律走 mutate 克隆） */
  readonly groupObj = computed<AnyObj | null>(() => {
    const d = this.work();
    if (!d) return null;
    return groups(d).find((g) => String(g['tag']) === this.group()) ?? null;
  });

  readonly type = computed(() => String(this.groupObj()?.['type'] ?? 'selector'));
  readonly members = computed<string[]>(() => {
    const v = this.groupObj()?.['outbounds'];
    return Array.isArray(v) ? v.map(String) : [];
  });
  readonly url = computed(() => String(this.groupObj()?.['url'] ?? ''));
  readonly interval = computed(() => String(this.groupObj()?.['interval'] ?? ''));
  readonly tolerance = computed(() => {
    const v = this.groupObj()?.['tolerance'];
    return v === undefined || v === null ? '' : String(v);
  });

  /** 候选成员：全部非分组条目（代理节点 + 特殊出站 + endpoints）+ 其它分组 */
  readonly candidates = computed<MemberCandidate[]>(() => {
    const d = this.work();
    if (!d) return [];
    const self = this.group();
    const list: MemberCandidate[] = nodes(d).map((n) => ({
      tag: n.tag,
      type: n.type,
      isGroup: false,
      special: n.special,
    }));
    for (const g of groups(d)) {
      const tag = String(g['tag']);
      if (tag === self) continue;
      list.push({ tag, type: String(g['type']), isGroup: true, special: false });
    }
    return list;
  });

  isMember(tag: string): boolean {
    return this.members().includes(tag);
  }

  /** 克隆当前文档 → 找到分组 → 修改 → 暂存 */
  private mutate(fn: (g: AnyObj) => void): void {
    const base = this.work();
    if (!base || !this.groupObj()) return;
    const doc = structuredClone(base);
    const g = groups(doc).find((x) => String(x['tag']) === this.group());
    if (!g) return;
    fn(g);
    this.draft.stage(doc);
  }

  /** 勾选 / 取消一个成员（去重追加到末尾；移除时修正 default） */
  toggleMember(tag: string, on: boolean): void {
    this.mutate((g) => {
      const members = Array.isArray(g['outbounds']) ? (g['outbounds'] as unknown[]).map(String) : [];
      const i = members.indexOf(tag);
      if (on && i < 0) members.push(tag);
      if (!on && i >= 0) members.splice(i, 1);
      g['outbounds'] = members;
      this.fixDefault(g, members);
    });
  }

  /** 成员变化后修正 default：不在成员里 → 第一个成员；组空 → 删键（没有该键则不动） */
  private fixDefault(g: AnyObj, members: string[]): void {
    if (!Object.prototype.hasOwnProperty.call(g, 'default')) return;
    if (!members.length) {
      delete g['default'];
      return;
    }
    const cur = g['default'];
    if (typeof cur !== 'string' || !members.includes(cur)) g['default'] = members[0];
  }

  /** 切换类型：urltest 补默认参数并去掉 default；selector 清掉 urltest 专属字段 */
  setType(t: string): void {
    if (!GROUP_TYPES.has(t) || t === this.type()) return;
    this.mutate((g) => {
      g['type'] = t;
      if (t === 'urltest') {
        if (typeof g['url'] !== 'string' || !g['url']) g['url'] = URLTEST_DEFAULT_URL;
        if (typeof g['interval'] !== 'string' || !g['interval']) g['interval'] = URLTEST_DEFAULT_INTERVAL;
        if (typeof g['tolerance'] !== 'number') g['tolerance'] = URLTEST_DEFAULT_TOLERANCE;
        delete g['default']; // urltest 按延迟自动选，没有手动 default
      } else {
        delete g['url'];
        delete g['interval'];
        delete g['tolerance'];
      }
    });
  }

  /** urltest 参数：空串 = 删键（回落到 sing-box 默认） */
  setUrl(v: string): void {
    this.mutate((g) => {
      if (v.trim()) g['url'] = v.trim();
      else delete g['url'];
    });
  }

  setInterval(v: string): void {
    this.mutate((g) => {
      if (v.trim()) g['interval'] = v.trim();
      else delete g['interval'];
    });
  }

  setTolerance(v: string): void {
    this.mutate((g) => {
      const n = Number(v);
      if (v.trim() && Number.isFinite(n) && n >= 0) g['tolerance'] = Math.round(n);
      else delete g['tolerance'];
    });
  }

  close(): void {
    this.closed.emit();
  }

  /** 点遮罩空白处关闭（点弹窗本体不关） */
  onMask(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.close();
  }
}