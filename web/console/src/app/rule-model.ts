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
  summary: string; // 人类可读的匹配条件摘要
  ruleSetRefs: string[]; // 引用的 rule_set tag 列表
  outbound: string; // 出站 tag（无则空串）
  structural: true;
  /** 纯动作规则（sniff / hijack-dns / resolve…）：排序时钉住，不许挪动 */
  actionOnly: boolean;
  /** IP 维度规则（显式 IP 字段或引用全 IP 桶）：列表里打「IP」标记，方便和域名规则对照 */
  ipRule: boolean;
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

/** 单条规则 → 摘要 + rule_set 引用 + outbound */
function summarize(r: AnyObj): { summary: string; ruleSetRefs: string[]; outbound: string } {
  const ruleSetRefs = asArray(r['rule_set']).map(String);
  const parts: string[] = [];
  for (const [key, label] of FIELD_LABELS) {
    if (key === 'rule_set') continue; // 引用单独渲染成 chips，不进摘要文本
    const shown = displayList(r[key]);
    if (shown) parts.push(`${label}=${shown}`);
  }
  // 未识别字段兜底成紧凑 JSON，保证摘要不丢信息
  const known = new Set<string>([...FIELD_LABELS.map(([k]) => k), 'outbound']);
  const rest: AnyObj = {};
  for (const k of Object.keys(r)) if (!known.has(k)) rest[k] = r[k];
  if (Object.keys(rest).length) parts.push(JSON.stringify(rest));
  const outbound = typeof r['outbound'] === 'string' ? r['outbound'] : '';
  // 只有 rule_set 引用时条件渲染成 chips，但摘要文本也要如实体现，不能误标「无条件」
  const body = parts.length
    ? parts.join(' · ')
    : ruleSetRefs.length
      ? `规则集=${ruleSetRefs.join('、')}`
      : '（无条件匹配）';
  return { summary: outbound ? `${body} → ${outbound}` : body, ruleSetRefs, outbound };
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
        ruleSetRefs: [],
        outbound: '',
        structural: true,
        actionOnly: false,
        ipRule: false,
      });
      return;
    }
    const { summary, ruleSetRefs, outbound } = summarize(r);
    routeRules.push({
      index,
      summary,
      ruleSetRefs,
      outbound,
      structural: true,
      actionOnly: isActionRule(r),
      ipRule: isIpRule(r),
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