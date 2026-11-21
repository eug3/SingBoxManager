import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';
import { ConfigDoc } from './config-ops';
import { RuleModel, filterRouteRules, readRuleModel } from './rule-model';

/**
 * 分流规则选择器 — 配置页只读视图里的 route.rules 启用/停用开关。
 *
 * 重启语义（顶部图例同步展示）：
 *  · 改 remote 桶内容 → 免重启，路由约 60s 自动拉取（去「规则编辑」tab 改）；
 *  · 停用/启用 route.rules → 改的是 config 结构 → 需「应用并重启」才生效。
 *
 * base 固定来自原始配置（ConfigPane.origDoc，parseConfig(original())），不随暂存
 * 文本漂移，下标语义稳定。每次勾选变化都从 structuredClone(base.root) 过滤
 * route.rules 生成新 ConfigDoc，经 docChange 交给 ConfigPane.enterReview，
 * 由 serializeConfig 按原文缩进/行尾序列化后进入既有暂存复核流程。
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

  constructor() {
    // 原始配置被刷新/重载后下标语义可能变化，停用集合清零，避免拿旧下标误删新规则
    effect(() => {
      this.base();
      this.disabled.set(new Set());
    });
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