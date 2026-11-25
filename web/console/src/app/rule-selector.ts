import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import { ConfigDoc, moveRule } from './config-ops';
import { RuleModel, filterRouteRules, readRuleModel } from './rule-model';

/**
 * 分流规则选择器 — 配置页只读视图里的 route.rules 顺序与启停。
 *
 * 重启语义（顶部图例同步展示）：
 *  · 改 remote 桶内容 → 免重启，路由约 60s 自动拉取（去「规则编辑」tab 改）；
 *  · 停用/启用 route.rules、调整规则顺序 → 改的是 config 结构 → 需「应用并重启」才生效。
 *
 * 顺序即优先级：sing-box 自上而下第一条命中即停。TUN 进来时目标还是 IP，域名靠
 * 第 0 条 `action: sniff` 嗅出来 —— 所以域名规则必须排在 IP 规则（cn_ip / hk_ip 等）前面，
 * 否则解析后的 CN IP 会先命中直连，后面的域名桶永远轮不到。↑↓ 就是给这件事用的。
 *
 * base 固定来自原始配置（ConfigPane.origDoc，parseConfig(original())），不随暂存
 * 文本漂移，下标语义稳定。每次勾选/移动都从 structuredClone(base.root) 生成新 ConfigDoc，
 * 经 docChange 交给 ConfigPane.enterReview，由 serializeConfig 按原文缩进/行尾序列化。
 */
@Component({
  selector: 'app-rule-selector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rule-selector.html',
})
export class RuleSelector {
  readonly base = input<ConfigDoc | null>(null);
  readonly docChange = output<ConfigDoc>();

  /** 停用的 route.rules 下标集合（勾选=启用=不在集合里；取消=停用=从 config 移除） */
  readonly disabled = signal<Set<number>>(new Set());

  readonly model = computed<RuleModel>(() => {
    const b = this.base();
    return b ? readRuleModel(b) : { ruleSets: [], routeRules: [] };
  });

  /** 头部连续的纯动作规则（sniff / hijack-dns / resolve）钉住在最前，不允许被挪动或跨过 */
  readonly minMovable = computed(() => {
    let n = 0;
    for (const r of this.model().routeRules) {
      if (r.actionOnly) n++;
      else break;
    }
    return n;
  });

  constructor() {
    // 原始配置被刷新/重载后下标语义可能变化，停用集合清零，避免拿旧下标误删新规则
    effect(() => {
      this.base();
      this.disabled.set(new Set());
    });
  }

  /** 能上移：不是钉住的头部动作规则，且上面还有可动的位置 */
  canUp(index: number): boolean {
    return index > this.minMovable();
  }

  /** 能下移：不是最后一条 */
  canDown(index: number): boolean {
    return index < this.model().routeRules.length - 1;
  }

  /**
   * 上移 / 下移一条规则（dir=-1 上移，+1 下移）：产出新文档 → 暂存复核 → 应用并重启才生效。
   * 停用勾选是「未应用的临时态」，移动后下标全变，这里一并清空。
   */
  move(index: number, dir: -1 | 1): void {
    const b = this.base();
    if (!b) return;
    const to = index + dir;
    if (to < this.minMovable() || to >= this.model().routeRules.length) return;
    const doc: ConfigDoc = structuredClone(b);
    try {
      moveRule(doc, index, to);
    } catch {
      return;
    }
    this.disabled.set(new Set());
    this.docChange.emit(doc);
  }

  /** checkbox 变化：enabled=勾选（启用），否则停用；随后基于 base 生成新文档发出 */
  toggle(index: number, enabled: boolean): void {
    this.disabled.update((prev) => {
      const next = new Set(prev);
      if (enabled) next.delete(index);
      else next.add(index);
      return next;
    });
    const b = this.base();
    if (!b) return;
    this.docChange.emit(filterRouteRules(b, this.disabled()));
  }
}