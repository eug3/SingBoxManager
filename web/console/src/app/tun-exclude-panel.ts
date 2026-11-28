import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal, untracked } from '@angular/core';
import {
  ConfigDoc,
  TUN_EXCLUDE_PRESETS,
  applyTunExcludes,
  isValidAddressPrefix,
  normalizeAddressPrefixes,
  tunExcludeAddresses,
  tunInbounds,
} from './config-ops';

/**
 * TUN 私网排除面板 —— 管理 `inbounds[type=tun].route_exclude_address`。
 *
 * 为什么不在「规则」里（三个不同语义）：
 *  · 「🧩 规则编辑」改 NAS 规则桶（.srs，两台共享，发布后约 60s 自动拉取）；
 *  · 「配置 → 分流规则」改 route.rules 的顺序/启停；
 *  · 本面板改的是 **TUN 入站参数**——「哪些目标不被接管」，每台路由一份、不共享，
 *    改完必须「应用并重启」才生效。
 *
 * 交互口径：**本地累积勾选 → 一次性「应用到暂存」**。
 * 不能像 rule-selector 那样每点一下就 emit：父组件收到新文档会 enterReview()，
 * 把页面切到整份 JSON 编辑视图（因为改的是 config 结构，要走 diff 复核），
 * 那样勾第二个框时面板已经不在画面上了。
 */
@Component({
  selector: 'app-tun-exclude-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tun-exclude-panel.html',
})
export class TunExcludePanel {
  readonly base = input<ConfigDoc | null>(null);
  readonly docChange = output<ConfigDoc>();

  readonly presets = TUN_EXCLUDE_PRESETS;

  /** 本地待提交的选择（规范化排序后保存，便于与当前值比较） */
  private readonly picked = signal<string[]>([]);

  /** 这份配置里的当前值（文档里的真值） */
  readonly current = computed<string[]>(() => {
    const b = this.base();
    return b ? normalizeAddressPrefixes(tunExcludeAddresses(b)) : [];
  });

  readonly tunCount = computed(() => {
    const b = this.base();
    return b ? tunInbounds(b).length : 0;
  });

  /** 待应用的选择 */
  readonly selected = computed<string[]>(() => normalizeAddressPrefixes(this.picked()));

  /** 与文档不一致 = 有未应用的勾选 */
  readonly dirty = computed(() => JSON.stringify(this.selected()) !== JSON.stringify(this.current()));

  readonly custom = computed<string[]>(() => {
    const preset = new Set(this.presets.map((p) => p.cidr));
    return this.selected().filter((a) => !preset.has(a));
  });

  /** 空列表 = 不排除任何地址 = 所有流量都进 TUN */
  readonly willBeEmpty = computed(() => this.selected().length === 0);

  readonly msg = signal<{ kind: 'ok' | 'err'; text: string } | null>(null);
  readonly customInput = signal('');

  constructor() {
    // base 变化（读配置 / 应用成功 / 别的面板改了文档）时，选择回到文档真值
    effect(() => {
      const cur = this.current();
      untracked(() => this.picked.set(cur));
    });
  }

  isOn(cidr: string): boolean {
    return this.selected().includes(cidr);
  }

  /** 勾选/取消一个预设网段（只改本地选择，不 emit） */
  toggle(cidr: string): void {
    const cur = this.selected();
    this.picked.set(cur.includes(cidr) ? cur.filter((x) => x !== cidr) : [...cur, cidr]);
    this.msg.set(null);
  }

  /** 添加自定义 IP/CIDR（支持一次粘多条：空格 / 逗号 / 分号 / 换行） */
  addCustom(): void {
    const raw = this.customInput().trim();
    if (!raw) return;
    const parts = raw.split(/[\s,;]+/).filter(Boolean);
    const bad = parts.filter((p) => !isValidAddressPrefix(p));
    if (bad.length) {
      this.msg.set({ kind: 'err', text: `地址不合法：${bad.join('、')}（例：10.0.0.0/8、192.168.31.97/32、2603:c024::1/128）` });
      return;
    }
    this.customInput.set('');
    this.picked.set([...this.selected(), ...parts]);
    this.msg.set(null);
  }

  /** 从选择里删掉一条 */
  remove(cidr: string): void {
    this.picked.set(this.selected().filter((x) => x !== cidr));
    this.msg.set(null);
  }

  /** 补齐常用私网段（保留已有其它条目） */
  fillRecommended(): void {
    const recommended = ['10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16'];
    const cur = this.selected();
    const add = recommended.filter((r) => !cur.includes(r));
    if (!add.length) {
      this.msg.set({ kind: 'ok', text: '常用私网段已经都在了' });
      return;
    }
    this.picked.set([...cur, ...add]);
    this.msg.set({ kind: 'ok', text: `已补齐 ${add.length} 条（点「应用到暂存」生效）` });
  }

  /** 清空选择（提示后果） */
  clearAll(): void {
    if (!this.selected().length) return;
    this.picked.set([]);
    this.msg.set({ kind: 'ok', text: '已清空选择：应用后不排除任何地址（所有流量都进 TUN）' });
  }

  /** 把本地选择写进文档 → 交给父组件进暂存复核 */
  applyToDraft(): void {
    const b = this.base();
    if (!b || !this.dirty()) return;
    const doc: ConfigDoc = structuredClone(b);
    const r = applyTunExcludes(doc, this.selected());
    if (!r.ok) {
      this.msg.set({
        kind: 'err',
        text:
          r.reason === 'invalid'
            ? `地址不合法：${(r.invalid ?? []).join('、')}`
            : r.reason === 'no-tun'
              ? '这份配置里没有 TUN 入站（inbounds 中 type=tun），无法设置排除地址'
              : '写入失败',
      });
      return;
    }
    this.msg.set({ kind: 'ok', text: `已写入暂存（${r.before.length} → ${r.after.length} 条），点上方「应用并重启」生效` });
    this.docChange.emit(doc);
  }

  /** 放弃本地选择，回到文档真值 */
  resetPick(): void {
    this.picked.set(this.current());
    this.msg.set(null);
  }
}