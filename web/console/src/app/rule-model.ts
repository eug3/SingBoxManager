/** rule-model — 纯函数读取分流规则（route.rule_set / route.rules），不修改传入文档 */

import { AnyObj, ConfigDoc, isActionRule, isIpRule } from './config-ops';

/**
 * 规则集（桶）摘要。
 * 重启语义：remote 桶的内容在 NAS 上，路由定时拉取（约 60s），改内容免重启；
 * local 桶的内容就写在 config 里，改它 = 改 config = 需重启。
 */
export interface RuleSetInfo {
  tag: string;
  type: string; // 'remote' | 'local'（原样透传，未知类型按 local 对待）
  url: string; // remote 的下载地址（local 为空）
  path: string; // local 的文件路径（remote 为空）
  contentRestartFree: boolean; // remote=true（改内容免重启），local=false
}

/**
 * route.rules 单条摘要。
 * 重启语义：rules 是 config 结构的一部分，停用/启用/修改任何一条都需重启，
 * 因此 structural 恒为 true。
 */
export interface RouteRuleInfo {
  index: number; // 在 route.rules 数组里的原始下标（停用=按此下标移除）
  summary: string; // 人类可读的匹配条件摘要（含 → 出口）
  /** 匹配条件文本（不含出口；动作规则为空串） */
  condition: string;
  ruleSetRefs: string[]; // 引用的 rule_set tag 列表
  outbound: string; // 出站 tag（无则空串）
  /** 规则动作（sniff / hijack-dns / resolve / reject…）；普通选路规则为空串 */
  action: string;
  structural: true;
  /** 纯动作规则（sniff / hijack-dns / resolve…）：排序时钉住，不许挪动 */
  actionOnly: boolean;
  /** IP 维度规则（显式 IP 字段或引用全 IP 桶）：列表里打「IP」标记，方便和域名规则对照 */
  ipRule: boolean;
  /** 逻辑规则（type: logical） */
  logical: boolean;
  /** sing-box rule.String() 的近似（纯 rule_set 规则才有值），用于和 /connections 的 rule 字段精确比对 */
  payloadHint: string;
  /** sing-box Action().String() 的近似：route(出站) / sniff / hijack-dns / reject */
  actionHint: string;
}

export interface RuleModel {
  ruleSets: RuleSetInfo[];
  routeRules: RouteRuleInfo[];
}

function asObj(v: unknown): AnyObj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 常见匹配字段 → 中文标签（按 sing-box 路由顺序展示；rule_set 单独提取成引用 chips） */
const FIELD_LABELS: [string, string][] = [
  ['rule_set', '规则集'],
  ['domain', '域名'],
  ['domain_suffix', '域名后缀'],
  ['domain_keyword', '域名关键词'],
  ['domain_regex', '域名正则'],
  ['ip_cidr', 'IP段'],
  ['ip_is_private', '私有IP'],
  ['source_ip_cidr', '来源IP'],
  ['source_ip_is_private', '来源私有IP'],
  ['port', '端口'],
  ['port_range', '端口段'],
  ['source_port', '来源端口'],
  ['source_port_range', '来源端口段'],
  ['network', '网络'],
  ['protocol', '协议'],
  ['inbound', '入站'],
  ['auth_user', '认证用户'],
  ['client', '客户端'],
  ['clash_mode', 'Clash模式'],
  ['package_name', '包名'],
  ['process_name', '进程名'],
  ['process_path', '进程路径'],
  ['wifi_ssid', 'WiFi'],
  ['wifi_bssid', 'WiFi BSSID'],
  ['action', '动作'],
];

/** 字符串/数组/标量 → 展示文本（长清单截断，避免几百个域名撑爆一行） */
function displayList(v: unknown, max = 3): string {
  const items = Array.isArray(v)
    ? v.map(String)
    : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
      ? [String(v)]
      : [];
  if (!items.length) return '';
  const head = items.slice(0, max).map((s) => (s.length > 48 ? s.slice(0, 48) + '…' : s));
  return head.join('、') + (items.length > max ? ` …共${items.length}项` : '');
}

/** 单条规则 → 摘要 + 条件 + 动作 + rule_set 引用 + outbound（+ 命中匹配用的 sing-box 字符串近似） */
function summarize(r: AnyObj): {
  summary: string;
  condition: string;
  ruleSetRefs: string[];
  outbound: string;
  action: string;
  payloadHint: string;
  actionHint: string;
} {
  const rawRefs = r['rule_set'];
  const ruleSetRefs = (typeof rawRefs === 'string' ? [rawRefs] : asArray(rawRefs))
    .map(String)
    .filter(Boolean);
  const parts: string[] = [];
  for (const [key, label] of FIELD_LABELS) {
    if (key === 'rule_set') continue; // 引用单独渲染成 chips，不进摘要文本
    const shown = displayList(r[key]);
    if (shown) parts.push(`${label}=${shown}`);
  }
  // 未识别字段兜底成紧凑 JSON，保证摘要不丢信息
  const known = new Set<string>([
    ...FIELD_LABELS.map(([k]) => k),
    'outbound',
    'action',
    'type',
    'mode',
    'rules',
    'invert',
    'method',
  ]);
  const rest: AnyObj = {};
  for (const k of Object.keys(r)) if (!known.has(k)) rest[k] = r[k];
  if (Object.keys(rest).length) parts.push(JSON.stringify(rest));
  const outbound = typeof r['outbound'] === 'string' ? r['outbound'] : '';
  const action = typeof r['action'] === 'string' ? r['action'] : '';
  // 只有 rule_set 引用时条件渲染成 chips，但摘要文本也要如实体现，不能误标「无条件」
  const body = parts.length
    ? parts.join(' · ')
    : ruleSetRefs.length
      ? `规则集=${ruleSetRefs.join('、')}`
      : '（无条件匹配）';
  /**
   * sing-box 侧渲染的近似（用于和 /connections 的 rule 字段比对算命中）：
   *  · payload = rule.String()：纯 rule_set 规则就是 `rule_set=<tag>` / `rule_set=[a b]`；
   *    带其它条件时 sing-box 的字段顺序与拼法无法在前端可靠复现 → 留空（该行不统计命中）。
   *  · action = Action().String()：route(<出站>) / sniff / hijack-dns / reject。
   */
  const onlyRuleSet = Object.keys(r).every(
    (k) => k === 'rule_set' || k === 'outbound' || k === 'action',
  );
  const payloadHint =
    onlyRuleSet && ruleSetRefs.length
      ? ruleSetRefs.length === 1
        ? `rule_set=${ruleSetRefs[0]}`
        : `rule_set=[${ruleSetRefs.join(' ')}]`
      : '';
  const actionHint = outbound ? `route(${outbound})` : action;
  return {
    summary: outbound ? `${body} → ${outbound}` : body,
    condition: body,
    ruleSetRefs,
    outbound,
    action,
    payloadHint,
    actionHint,
  };
}

/** 从整份配置读分流规则模型；route 缺失/形状不对时返回空列表，不抛错 */
export function readRuleModel(doc: ConfigDoc): RuleModel {
  const route = asObj(doc.root['route']);
  const ruleSets: RuleSetInfo[] = [];
  for (const item of asArray(route?.['rule_set'])) {
    const rs = asObj(item);
    if (!rs) continue;
    const type = String(rs['type'] ?? '');
    ruleSets.push({
      tag: String(rs['tag'] ?? '?'),
      type,
      url: typeof rs['url'] === 'string' ? rs['url'] : '',
      path: typeof rs['path'] === 'string' ? rs['path'] : '',
      contentRestartFree: type === 'remote',
    });
  }
  const routeRules: RouteRuleInfo[] = [];
  asArray(route?.['rules']).forEach((item, index) => {
    const r = asObj(item);
    if (!r) {
      // 非对象条目也保留下标，保证停用集合与数组位置一一对应
      routeRules.push({
        index,
        summary: String(item),
        condition: String(item),
        ruleSetRefs: [],
        outbound: '',
        action: '',
        structural: true,
        actionOnly: false,
        ipRule: false,
        logical: false,
        payloadHint: '',
        actionHint: '',
      });
      return;
    }
    const { summary, condition, ruleSetRefs, outbound, action, payloadHint, actionHint } = summarize(r);
    routeRules.push({
      index,
      summary,
      condition,
      ruleSetRefs,
      outbound,
      action,
      structural: true,
      actionOnly: isActionRule(r),
      ipRule: isIpRule(r),
      logical: String(r['type'] ?? '').toLowerCase() === 'logical',
      payloadHint,
      actionHint,
    });
  });
  return { ruleSets, routeRules };
}

/**
 * 按停用集合生成新配置：structuredClone(base.root) 后从 route.rules 移除对应下标。
 * 不改动 base；返回的 ConfigDoc 由 ConfigPane.enterReview 用 serializeConfig
 * 按原文缩进/行尾序列化回文本（停用/启用 = 改 config 结构 = 应用时需重启）。
 */
export function filterRouteRules(base: ConfigDoc, disabled: ReadonlySet<number>): ConfigDoc {
  const root = structuredClone(base.root);
  const route = asObj(root['route']);
  if (route && Array.isArray(route['rules'])) {
    route['rules'] = (route['rules'] as unknown[]).filter((_, i) => !disabled.has(i));
  }
  return { root };
}
/** /connections 里一条连接的最小形状（只用到 rule 字段） */
export interface ConnRuleLike {
  rule?: string;
}

/** 命中统计结果 */
export interface RuleHitStats {
  /** 规则下标 → 命中条数（只统计能精确对上的规则；0 不出现） */
  hits: Map<number, number>;
  /** 命中 route.final 的连接数（connection.rule === "final"） */
  final: number;
  /** 规则串对不上任何配置规则（逻辑规则 / 带多条件规则）的条数 */
  unmatched: number;
}

/**
 * 按「配置规则」统计当前活动连接的命中数（纯函数）。
 *
 * sing-box 的 connection.rule = `<rule.String()> => <action.String()>`，例如
 * `rule_set=rs-tg => route(📲 电报信息)`；route.final 命中时是字面量 `final`。
 * 我们只能精确复现「纯 rule_set 规则」的字符串（`rule_set=<tag>` / `rule_set=[a b]`），
 * 其余规则（带 domain/ip_cidr/port 等条件、逻辑规则）payload 拼法不可靠复现 → 记 unmatched，
 * 不做猜测性归并（宁可显示 —，也不把命中算到错的行上）。
 */
export function countRuleHits(
  rows: readonly RouteRuleInfo[],
  conns: readonly ConnRuleLike[],
): RuleHitStats {
  // 同一 payload+action 出现多次时取求值顺序上的第一条（与 sing-box 一致）
  const byKey = new Map<string, number>();
  for (const r of rows) {
    if (!r.payloadHint || !r.actionHint) continue;
    const key = `${r.payloadHint} => ${r.actionHint}`;
    if (!byKey.has(key)) byKey.set(key, r.index);
  }
  const hits = new Map<number, number>();
  let final = 0;
  let unmatched = 0;
  for (const c of conns) {
    const rule = String(c.rule ?? '').trim();
    if (!rule) {
      unmatched++;
      continue;
    }
    if (rule === 'final') {
      final++;
      continue;
    }
    const idx = byKey.get(rule);
    if (idx === undefined) unmatched++;
    else hits.set(idx, (hits.get(idx) ?? 0) + 1);
  }
  return { hits, final, unmatched };
}
