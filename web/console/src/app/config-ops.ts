/**
 * config-ops.ts — 整份 sing-box config.json 的结构化操作纯函数库。
 *
 * 约定：所有函数直接 mutate 传入的 ConfigDoc（调用方负责先 structuredClone），
 * 不做网络/存储；序列化 serializeConfig 保持原文缩进与 CRLF/LF 风格，避免无谓 diff。
 * 供 config-pane / group-dialog / group-board-model / flow 等共用，口径单一。
 */

/** 宽松 JSON 对象（config 节点字段不定型） */
export type AnyObj = Record<string, unknown>;

/** 解析后的配置文档：root 为整份 config 对象 */
export interface ConfigDoc {
  root: AnyObj;
}

/** 节点摘要（只读表/表单/看板用）：tag/协议/服务器/所属分组/被 route 引用数/是否特殊 */
export interface NodeSummary {
  tag: string;
  type: string;
  server: string;
  groups: string[];
  routeRefs: number;
  special: boolean;
}

/** 分组类型（selector 手动 / urltest 自动） */
export const GROUP_TYPES = new Set(['selector', 'urltest']);
/** 特殊出站（direct/block/dns），不可删、单独着色 */
export const SPECIAL_TYPES = new Set(['direct', 'block', 'dns']);
/** 特殊出站（direct/block/dns），不可删、单独着色 */

/** 解析 config 文本；根非对象直接抛错 */
export function parseConfig(raw: string): ConfigDoc {
  const root = JSON.parse(raw) as unknown;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('配置根节点必须是对象');
  return { root: root as AnyObj };
}

/** 探测原文缩进宽度（取第二行前导空格），默认 2 */
function detectIndent(raw: string): number {
  const line = raw.split(/\r?\n/)[1] ?? '';
  const m = line.match(/^( +)/);
  return m ? m[1].length : 2;
}

/** 序列化回文本：沿用 like 的缩进/行尾/末尾换行，保持最小 diff */
export function serializeConfig(doc: ConfigDoc, like: string): string {
  const crlf = like.includes('\r\n');
  const indent = detectIndent(like);
  let out = JSON.stringify(doc.root, null, indent);
  if (crlf) out = out.replace(/\n/g, '\r\n');
  return out + (like.endsWith('\n') ? (crlf ? '\r\n' : '\n') : '');
}

/** outbounds 数组（缺省空） */
function outbounds(doc: ConfigDoc): AnyObj[] {
  return Array.isArray(doc.root['outbounds']) ? (doc.root['outbounds'] as AnyObj[]) : [];
}

/** endpoints 数组（masque 等，缺省空） */
function endpoints(doc: ConfigDoc): AnyObj[] {
  return Array.isArray(doc.root['endpoints']) ? (doc.root['endpoints'] as AnyObj[]) : [];
}

/** route.rules 数组（缺省空；只读，不改文档） */
export function routeRules(doc: ConfigDoc): AnyObj[] {
  const route = doc.root['route'] as AnyObj | undefined;
  return Array.isArray(route?.['rules']) ? (route!['rules'] as AnyObj[]) : [];
}

/** 是否分组（selector/urltest） */
export function isGroup(o: AnyObj): boolean {
  return GROUP_TYPES.has(String(o['type']));
}

/** 全部分组对象 */
export function groups(doc: ConfigDoc): AnyObj[] {
  return outbounds(doc).filter(isGroup);
}

/** 全部非分组条目摘要（代理+特殊+endpoints），特殊排最后、其余按 tag 排序 */
export function nodes(doc: ConfigDoc): NodeSummary[] {
  const all = [...outbounds(doc), ...endpoints(doc)];
  const routeRefs = new Map<string, number>();
  for (const r of routeRules(doc)) {
    const ref = r['outbound'];
    if (typeof ref === 'string') routeRefs.set(ref, (routeRefs.get(ref) ?? 0) + 1);
  }
  const list: NodeSummary[] = [];
  for (const o of all) {
    if (isGroup(o)) continue;
    const tag = String(o['tag'] ?? '?');
    const type = String(o['type'] ?? '?');
    const host = o['server'] ?? '';
    const port = o['server_port'] ?? '';
    list.push({
      tag,
      type,
      server: host ? `${host}${port ? ':' + port : ''}` : '—',
      groups: groups(doc)
        .filter((g) => Array.isArray(g['outbounds']) && (g['outbounds'] as string[]).includes(tag))
        .map((g) => String(g['tag'])),
      routeRefs: routeRefs.get(tag) ?? 0,
      special: SPECIAL_TYPES.has(type),
    });
  }
  return list.sort((a, b) => (a.special === b.special ? a.tag.localeCompare(b.tag) : a.special ? 1 : -1));
}

/** 按 tag 找节点（outbounds+endpoints） */
export function findNode(doc: ConfigDoc, tag: string): AnyObj | undefined {
  return [...outbounds(doc), ...endpoints(doc)].find((o) => String(o['tag']) === tag);
}

/** 删除前的影响面分析 */
export interface DeleteImpact {
  tag: string;
  groups: string[];
  routeRefs: { where: string; index: number }[];
  isDefault: { group: string; value: string }[];
  blocked: boolean;
  reasons: string[];
}

/** 删除影响面：所属分组/route 引用/作为 default/是否禁止删（特殊或被 route 引用） */
export function deleteImpact(doc: ConfigDoc, tag: string): DeleteImpact {
  const groupsHit = groups(doc)
    .filter((g) => Array.isArray(g['outbounds']) && (g['outbounds'] as string[]).includes(tag))
    .map((g) => String(g['tag']));
  const refs: { where: string; index: number }[] = [];
  routeRules(doc).forEach((r, i) => {
    if (r['outbound'] === tag) refs.push({ where: 'route.rules', index: i });
  });
  const defaults: { group: string; value: string }[] = [];
  for (const d of outbounds(doc)) {
    if (d['default'] === tag) defaults.push({ group: String(d['tag'] ?? '?'), value: String(d['default']) });
  }
  const reasons: string[] = [];
  if (refs.length) reasons.push(`被 ${refs.length} 条 route 规则直接引用（需先改这些规则的 outbound）`);
  if (SPECIAL_TYPES.has(String(findNode(doc, tag)?.['type'] ?? ''))) reasons.push('该条目是 direct/block 等特殊出站，不允许删除');
  return { tag, groups: groupsHit, routeRefs: refs, isDefault: defaults, blocked: reasons.length > 0, reasons };
}

/** 生成不重复 tag（base、base-2…base-99、兜底时间戳） */
function uniqueTag(doc: ConfigDoc, base: string): string {
  const used = new Set([...outbounds(doc), ...endpoints(doc)].map((o) => String(o['tag'] ?? '')));
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const t = `${base}-${i}`;
    if (!used.has(t)) return t;
  }
  return `${base}-${Date.now()}`;
}

/** 新增节点：写入 outbounds，并加入指定分组 */
export function addNode(doc: ConfigDoc, node: AnyObj, groupTags: string[]): string {
  const tag = uniqueTag(doc, String(node['tag'] ?? node['type'] ?? 'node'));
  node['tag'] = tag;
  const ob = outbounds(doc);
  ob.push(node);
  doc.root['outbounds'] = ob;
  for (const g of groups(doc)) {
    if (!groupTags.includes(String(g['tag']))) continue;
    const members = Array.isArray(g['outbounds']) ? (g['outbounds'] as string[]) : [];
    if (!members.includes(tag)) members.push(tag);
    g['outbounds'] = members;
  }
  return tag;
}

/** 修改节点：保留 tag，替换字段；可选调整分组归属 */
export function updateNode(doc: ConfigDoc, tag: string, patch: AnyObj, groupTags?: string[]): void {
  const node = findNode(doc, tag);
  if (!node) throw new Error(`找不到节点 ${tag}`);
  for (const k of Object.keys(patch)) {
    if (patch[k] === undefined) delete node[k];
    else node[k] = patch[k];
  }
  node['tag'] = tag;
  if (groupTags) {
    for (const g of groups(doc)) {
      const members = Array.isArray(g['outbounds']) ? (g['outbounds'] as string[]) : [];
      const want = groupTags.includes(String(g['tag']));
      const has = members.includes(tag);
      if (want && !has) members.push(tag);
      if (!want && has) {
        const i = members.indexOf(tag);
        members.splice(i, 1);
        // 顺手避免 default 指向被移出的节点
        if (g['default'] === tag && members.length) g['default'] = members[0];
      }
      g['outbounds'] = members;
    }
  }
}

/** 删除节点：从 outbounds/endpoints 移除，并从所有分组里摘掉 */
export function deleteNode(doc: ConfigDoc, tag: string): void {
  const impact = deleteImpact(doc, tag);
  if (impact.blocked) throw new Error(impact.reasons.join('；'));
  const ob = outbounds(doc).filter((o) => String(o['tag']) !== tag);
  doc.root['outbounds'] = ob;
  doc.root['endpoints'] = endpoints(doc).filter((o) => String(o['tag']) !== tag);
  for (const g of groups(doc)) {
    const members = Array.isArray(g['outbounds']) ? (g['outbounds'] as string[]) : [];
    const i = members.indexOf(tag);
    if (i >= 0) {
      members.splice(i, 1);
      if (g['default'] === tag && members.length) g['default'] = members[0];
    }
    g['outbounds'] = members;
  }
}

/* ─────────────────────── 规则集（route.rule_set）与引用 ─────────────────────── */

/** route.rule_set 数组（缺省空） */
export function routeRuleSets(doc: ConfigDoc): AnyObj[] {
  const route = doc.root['route'] as AnyObj | undefined;
  return Array.isArray(route?.['rule_set']) ? (route!['rule_set'] as AnyObj[]) : [];
}

/** rule_set 引用归一化：sing-box 允许字符串或字符串数组 */
export function ruleSetRefs(r: AnyObj): string[] {
  const v = r['rule_set'];
  if (typeof v === 'string') return v ? [v] : [];
  return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
}

/** 非匹配条件字段：这些键不构成匹配条件（与 flow-model / rule-set-dialog 同一口径） */
const NON_MATCH_KEYS = new Set([
  'outbound',
  'action',
  'rule_set',
  'type',
  'mode',
  'rules',
  'invert',
  'method',
]);

/**
 * 「final 兜底规则」：带 outbound、没有任何匹配条件、也不是 logical 嵌套。
 * 新引用要插在它前面（route.final 是独立字段，天然在所有 rules 之后）。
 * 不带 outbound 的动作规则（sniff / hijack-dns）不算兜底。
 */
export function isFinalRule(r: AnyObj): boolean {
  if (typeof r['outbound'] !== 'string' || !r['outbound']) return false;
  if (ruleSetRefs(r).length || Array.isArray(r['rules'])) return false;
  return Object.keys(r).every((k) => NON_MATCH_KEYS.has(k));
}

/** 取（必要时创建）route 对象 */
function ensureRoute(doc: ConfigDoc): AnyObj {
  let route = doc.root['route'];
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    route = {};
    doc.root['route'] = route;
  }
  return route as AnyObj;
}

/** 取（必要时创建）route.rules 数组 */
function ensureRouteRules(route: AnyObj): AnyObj[] {
  if (!Array.isArray(route['rules'])) route['rules'] = [];
  return route['rules'] as AnyObj[];
}

/** 新规则集定义（route.rule_set 的一条） */
export interface RuleSetDefInput {
  /** 规则集 tag（桶名，如 rs-openai） */
  tag: string;
  /** remote = 从 url 定时下载；local = 读路由本机 path */
  type: 'remote' | 'local';
  /** remote 的格式：binary（.srs）/ source（.json），缺省 binary */
  format?: string;
  /** remote 的下载地址 */
  url?: string;
  /** local 的文件路径 */
  path?: string;
  /** remote 的更新间隔，如 1m */
  updateInterval?: string;
  /** remote 的下载出站（可空 = 走 default） */
  downloadDetour?: string;
}

/**
 * 新增一条规则集定义到 route.rule_set（只写定义，不建引用、不碰文件）。
 * tag 重复 / 必填缺失直接抛错（调用方负责展示）。
 */
export function addRuleSet(doc: ConfigDoc, def: RuleSetDefInput): void {
  const tag = String(def.tag ?? '').trim();
  if (!tag) throw new Error('规则集 tag 不能为空');
  if (def.type !== 'remote' && def.type !== 'local') throw new Error('规则集类型只能是 remote / local');
  const route = ensureRoute(doc);
  if (!Array.isArray(route['rule_set'])) route['rule_set'] = [];
  const list = route['rule_set'] as AnyObj[];
  if (list.some((x) => x && String(x['tag']) === tag)) throw new Error(`规则集 ${tag} 已存在`);
  const obj: AnyObj = { type: def.type, tag };
  if (def.type === 'remote') {
    const url = String(def.url ?? '').trim();
    if (!url) throw new Error('remote 规则集必须填 url');
    obj['format'] = def.format || 'binary';
    obj['url'] = url;
    const iv = String(def.updateInterval ?? '').trim();
    if (iv) obj['update_interval'] = iv;
    const detour = String(def.downloadDetour ?? '').trim();
    if (detour) obj['download_detour'] = detour;
  } else {
    const path = String(def.path ?? '').trim();
    if (!path) throw new Error('local 规则集必须填 path');
    obj['path'] = path;
  }
  list.push(obj);
}

/** 引用的插入位置（③ 新建 / 规则集弹窗用） */
export type RuleInsertPosition = 'auto' | 'domain' | 'ip';

/**
 * 规则集 tag 是不是「IP 类」——只按名字判定（远端 .srs 内容读不到）：
 *  · cn_ip / hk_ip 这类「国别_IP」；
 *  · rs-ip-aws / geoip-cn / xxx-ip 这类带 ip 段的；
 *  · iplc-ss、geosite-cn 之类不会误判（iplc 不是 ip 边界）。
 */
export function isIpRuleSetTag(tag: string): boolean {
  const t = String(tag ?? '').trim().toLowerCase();
  if (!t) return false;
  if (t === 'cn_ip' || t === 'hk_ip') return true;
  return /(^|[-_])ip([-_]|$)|^geoip[-_]|[-_]ip[-_]/.test(t);
}

/** 该条规则是否带 IP 维度条件：显式 IP 字段，或引用的桶全是 IP 桶（混合桶算域名规则，保持靠前） */
export function isIpRule(r: AnyObj): boolean {
  for (const k of ['ip_cidr', 'source_ip_cidr', 'ip_is_private', 'source_ip_is_private', 'geoip', 'source_geoip']) {
    if (r[k] !== undefined) return true;
  }
  const refs = ruleSetRefs(r);
  return refs.length > 0 && refs.every(isIpRuleSetTag);
}

/** 「纯动作规则」：只有 action（sniff / hijack-dns / resolve …），不选路、不引用桶 —— 排序时不许跨过它们 */
export function isActionRule(r: AnyObj): boolean {
  if (typeof r['action'] !== 'string' || !r['action']) return false;
  if (typeof r['outbound'] === 'string' && r['outbound']) return false;
  return ruleSetRefs(r).length === 0 && !Array.isArray(r['rules']);
}

/** 插入点：插到 index 之前；anchor 是参照规则（用于 UI 文案「cn_ip 之前」） */
export interface RuleInsertPoint {
  index: number;
  anchor: string;
  where: 'before' | 'after' | 'end';
}

/** route.rules 的下标查找：最后一条非 final 规则之后的插入位（= final 之前） */
function finalInsertIndex(rules: AnyObj[]): number {
  const at = rules.findIndex((r) => r && isFinalRule(r));
  return at >= 0 ? at : rules.length;
}

/** IP 桶规则（引用的桶全是 IP 类）的下标 */
function ipBucketRuleIndexes(rules: AnyObj[], limit: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < limit; i++) {
    const r = rules[i];
    if (!r) continue;
    const refs = ruleSetRefs(r);
    if (refs.length && refs.every(isIpRuleSetTag)) out.push(i);
  }
  return out;
}

/**
 * 计算域名 / IP 引用的插入点（只读，不改文档；弹窗用它显示「将插到 #24 cn_ip 之前」）：
 *  · domain：插到第一条「IP 桶规则」之前（= 现有域名块尾部、cn_ip 之前）；没有 IP 桶就 final 前；
 *  · ip：插到最后一条「IP 桶规则」之后；没有就 final 前。
 * 只认 IP 桶（cn_ip / hk_ip / rs-ip-*），不认 ip_is_private / 单 IP 直连这些安全钉，避免把域名规则插到它们前面。
 */
export function ruleInsertPoint(doc: ConfigDoc, position: Exclude<RuleInsertPosition, 'auto'>): RuleInsertPoint {
  const rules = routeRules(doc);
  const end = finalInsertIndex(rules);
  const ipIdx = ipBucketRuleIndexes(rules, end);
  if (position === 'domain') {
    if (ipIdx.length) {
      const i = ipIdx[0];
      return { index: i, anchor: String(ruleSetRefs(rules[i])[0] ?? ''), where: 'before' };
    }
    return { index: end, anchor: 'final', where: 'end' };
  }
  if (ipIdx.length) {
    const i = ipIdx[ipIdx.length - 1];
    return { index: i + 1, anchor: String(ruleSetRefs(rules[i])[0] ?? ''), where: 'after' };
  }
  return { index: end, anchor: 'final', where: 'end' };
}

/** 预演 addRuleSetRef 会落到哪：弹窗用它显示「将插到 #24（cn_ip 之前）」 */
export interface RuleRefTarget {
  /** 承载该引用的规则下标（extend=并入这一条；insert=插在这个位置） */
  index: number;
  mode: 'extend' | 'insert';
  /** 参照规则（insert 时的 UI 文案），extend 时为插入点参照 */
  anchor: string;
  where: 'before' | 'after' | 'end';
}

/**
 * 给某个出站加 rule_set 引用的落点预演（只读）：
 *  · auto：该出站已有带 rule_set 的规则 → 并入它；否则插到 final 兜底之前；
 *  · domain：优先并入「插入点之前」的出站规则（保持域名优先），没有就插到 IP 桶之前；
 *  · ip：优先并入「插入点之后」的出站规则，没有就插到最后一条 IP 桶之后。
 */
export function previewRuleSetRef(
  doc: ConfigDoc,
  group: string,
  tag: string,
  position: RuleInsertPosition = 'auto',
): RuleRefTarget {
  const g = String(group ?? '').trim();
  const t = String(tag ?? '').trim();
  if (!g) throw new Error('引用目标出站不能为空');
  if (!t) throw new Error('规则集 tag 不能为空');
  const rules = routeRules(doc);
  if (position === 'auto') {
    const i = rules.findIndex((r) => r && r['outbound'] === g && ruleSetRefs(r).length > 0);
    if (i >= 0) return { index: i, mode: 'extend', anchor: '', where: 'end' };
    return { index: finalInsertIndex(rules), mode: 'insert', anchor: 'final', where: 'end' };
  }
  const point = ruleInsertPoint(doc, position);
  const i = rules.findIndex(
    (r, k) =>
      !!r &&
      r['outbound'] === g &&
      ruleSetRefs(r).length > 0 &&
      (position === 'domain' ? k < point.index : k >= point.index),
  );
  if (i >= 0) return { index: i, mode: 'extend', anchor: point.anchor, where: point.where };
  return {
    index: Math.max(0, Math.min(point.index, finalInsertIndex(rules))),
    mode: 'insert',
    anchor: point.anchor,
    where: point.where,
  };
}

/**
 * 给某个出站加一条 rule_set 引用，返回「最终承载该引用的规则下标」。
 * 落点由 previewRuleSetRef 决定（弹窗预览与实际写入同一口径）；字符串引用归一化成数组，
 * 不删定义、不动其它出站的引用。
 */
export function addRuleSetRef(
  doc: ConfigDoc,
  group: string,
  tag: string,
  position: RuleInsertPosition = 'auto',
): number {
  return addRuleSetRefs(doc, group, [tag], position);
}

/**
 * 一次把**多个桶**引用到同一个出站：写一条 `{rule_set:[a,b,…], outbound}`（sing-box 里 OR）。
 * 落点与单桶版本一致（previewRuleSetRef 用第一个 tag 预演）：能并入该出站已有规则就并入，
 * 否则按「域名桶之前 / IP 桶之后」插入。返回承载这些引用的规则下标。
 */
export function addRuleSetRefs(
  doc: ConfigDoc,
  group: string,
  tags: string[],
  position: RuleInsertPosition = 'auto',
): number {
  const g = String(group ?? '').trim();
  const list: string[] = [];
  for (const raw of tags ?? []) {
    const t = String(raw ?? '').trim();
    if (t && !list.includes(t)) list.push(t);
  }
  if (!g) throw new Error('引用目标出站不能为空');
  if (!list.length) throw new Error('至少要选/建一个规则集 tag');
  const target = previewRuleSetRef(doc, g, list[0], position);
  const rules = ensureRouteRules(ensureRoute(doc));
  const i = Math.max(0, Math.min(target.index, rules.length));
  if (target.mode === 'extend' && i < rules.length) {
    const refs = ruleSetRefs(rules[i]);
    for (const t of list) if (!refs.includes(t)) refs.push(t);
    rules[i]['rule_set'] = refs;
    return i;
  }
  rules.splice(i, 0, { rule_set: [...list], outbound: g });
  return i;
}

/** 把一条规则从 from 挪到 to（原地移动，越界抛错），返回新下标 */
export function moveRule(doc: ConfigDoc, from: number, to: number): number {
  const rules = ensureRouteRules(ensureRoute(doc));
  if (from < 0 || from >= rules.length || to < 0 || to >= rules.length) {
    throw new Error(`规则下标越界：${from} → ${to}（共 ${rules.length} 条）`);
  }
  if (from === to) return to;
  const [moved] = rules.splice(from, 1);
  rules.splice(to, 0, moved);
  return to;
}

/** 新分组的输入 */
export interface NewGroupInput {
  tag: string;
  /** selector 手动选择 / urltest 按延迟自动 */
  type: 'selector' | 'urltest';
  /** 成员 tag（节点 / 其它分组 / DIRECT 等），按勾选顺序 */
  members: string[];
  /** urltest 的测试 URL（空 = sing-box 默认） */
  url?: string;
  /** urltest 的测试间隔（空 = 默认） */
  interval?: string;
  /** urltest 的容差 ms（空 = 默认） */
  tolerance?: number | null;
}

/**
 * 新增一个分组出站（selector / urltest），追加到 outbounds 末尾。
 * 校验：tag 非空且不重复、类型合法、成员至少一个且都在现有 tag 名册里。
 * 返回最终落库的 tag（重名时会自动加 -2 后缀，与新增节点同一口径）。
 */
export function addGroup(doc: ConfigDoc, input: NewGroupInput): string {
  const raw = String(input.tag ?? '').trim();
  if (!raw) throw new Error('分组 tag 不能为空');
  if (!GROUP_TYPES.has(input.type)) throw new Error('分组类型只能是 selector / urltest');
  const members = (input.members ?? []).map(String).filter(Boolean);
  if (!members.length) throw new Error('分组至少要有一个成员');
  const known = new Set([...outbounds(doc), ...endpoints(doc)].map((o) => String(o['tag'] ?? '')));
  const missing = members.filter((m) => !known.has(m));
  if (missing.length) throw new Error(`成员不存在：${missing.join('、')}`);
  const tag = uniqueTag(doc, raw);
  const g: AnyObj = { type: input.type, tag, outbounds: members };
  if (input.type === 'urltest') {
    const url = String(input.url ?? '').trim();
    const iv = String(input.interval ?? '').trim();
    if (url) g['url'] = url;
    if (iv) g['interval'] = iv;
    if (typeof input.tolerance === 'number' && Number.isFinite(input.tolerance) && input.tolerance >= 0) {
      g['tolerance'] = Math.round(input.tolerance);
    }
  }
  const ob = outbounds(doc);
  ob.push(g);
  doc.root['outbounds'] = ob;
  return tag;
}

/** 结构校验（前端预检，最终仍以路由上的 sing-box check 为准） */
export function validateDoc(doc: ConfigDoc): string[] {
  const issues: string[] = [];
  const all = [...outbounds(doc), ...endpoints(doc)];
  const counter = new Map<string, number>();
  for (const o of all) {
    const t = String(o['tag'] ?? '');
    if (!t) issues.push('存在没有 tag 的条目');
    counter.set(t, (counter.get(t) ?? 0) + 1);
  }
  for (const [t, n] of counter) if (n > 1) issues.push(`tag 重复：${t} ×${n}`);
  // sing-box 内置出站（无需在 outbounds 里声明）：不要把 direct/block/dns 当成悬空引用
  const tags = new Set([...counter.keys(), 'direct', 'block', 'dns']);
  for (const g of groups(doc)) {
    const members = Array.isArray(g['outbounds']) ? (g['outbounds'] as string[]) : [];
    for (const m of members) if (!tags.has(m)) issues.push(`组 ${String(g['tag'])} 引用了不存在的 ${m}`);
    if (g['default'] && !members.includes(String(g['default']))) {
      issues.push(`组 ${String(g['tag'])} 的 default(${String(g['default'])}) 不在成员里`);
    }
  }
  routeRules(doc).forEach((r, i) => {
    const ref = r['outbound'];
    if (typeof ref === 'string' && !tags.has(ref)) issues.push(`route.rules[${i}] 引用了不存在的 ${ref}`);
  });
  return issues;
}
/* ────────────────── 规则集分组（拆解 / 合并） ────────────────── */

/** 「拆解与合并」弹窗里的一组 = 一条引用 rule_set 的 route.rules 条目 */
export interface RuleSetGroup {
  /** 该规则在 route.rules 里的下标（新增组为 null） */
  index: number | null;
  /** 这组引用指向的出站（分组 / DIRECT / block …） */
  outbound: string;
  /** 这组里引用的桶 tag（拖进拖出的对象） */
  tags: string[];
}


/**
 * 读出「可拆解的分组」：只取引用了 rule_set 的规则。
 * 动作规则（sniff / hijack-dns）、纯条件规则（ip_cidr / port …）不参与拆解合并。
 */
export function ruleSetGroups(doc: ConfigDoc, outbound?: string): RuleSetGroup[] {
  const out: RuleSetGroup[] = [];
  routeRules(doc).forEach((r, i) => {
    if (!r) return;
    const tags = ruleSetRefs(r);
    if (!tags.length) return;
    const ob = String(r['outbound'] ?? '');
    // 传了 outbound 就只看这个出口下的规则（右键「拆解与合并」按出口分组收敛）
    if (outbound !== undefined && ob !== outbound) return;
    out.push({ index: i, outbound: ob, tags });
  });
  return out;
}

/** 弹窗保存时的一组：index=null 表示新增（anchor = 插在哪个原下标之后，-1 = 末尾） */
export interface RuleGroupPlan {
  index: number | null;
  anchor: number;
  outbound: string;
  tags: string[];
}

/** 取 route.rules 里的一条规则（保留它原有的其它条件字段） */
function cloneRuleWith(r: AnyObj, outbound: string, tags: string[]): AnyObj {
  const copy: AnyObj = { ...r };
  copy['rule_set'] = [...tags];
  copy['outbound'] = outbound;
  return copy;
}

/**
 * 按弹窗结果重写 route.rules 里的「rule_set 分组」：
 *  · 有 tags 的组 → 原地替换（保留该规则其它条件与位置）；
 *  · tags 为空的组 → 该规则被删掉（「空的组自动消失」）；
 *  · index=null 的新组 → 插在 anchor 那条规则之后（anchors 用改动前的下标）。
 * 不碰未参与分组的规则（动作规则 / 纯条件规则 / final 全部保持原样与原位置）。
 */
export function applyRuleGroups(doc: ConfigDoc, plan: RuleGroupPlan[]): void {
  const rules = ensureRouteRules(ensureRoute(doc));
  const byIndex = new Map<number, RuleGroupPlan>();
  for (const g of plan) if (g.index !== null) byIndex.set(g.index, g);
  const inserts = new Map<number, RuleGroupPlan[]>();
  for (const g of plan) {
    if (g.index !== null) continue;
    if (!g.tags.length) continue; // 新建但没放桶 → 不落盘
    const list = inserts.get(g.anchor) ?? [];
    list.push(g);
    inserts.set(g.anchor, list);
  }
  const next: AnyObj[] = [];
  rules.forEach((r, i) => {
    const g = byIndex.get(i);
    if (!g) {
      next.push(r);
    } else if (g.tags.length) {
      next.push(cloneRuleWith(r, g.outbound, g.tags));
    }
    for (const add of inserts.get(i) ?? []) {
      next.push({ rule_set: [...add.tags], outbound: add.outbound });
    }
  });
  for (const add of inserts.get(-1) ?? []) {
    next.push({ rule_set: [...add.tags], outbound: add.outbound });
  }
  rules.length = 0;
  rules.push(...next);
}

/**
 * 清理「没有任何东西指向」的分组出站（弹窗保存时调用）：
 *  · 只删 selector / urltest 分组，不碰节点 / endpoints / 内置 DIRECT·block·dns；
 *  · 仍被 route.rules / route.final / 其它分组成员引用的一律保留；
 *  · 至少保留 1 个分组（用户要求：config 里必须始终有一个之前建的 outbound）。
 * 返回被删掉的 tag。
 */
export function pruneOrphanGroups(doc: ConfigDoc, only?: readonly string[]): string[] {
  const list = doc.root['outbounds'];
  if (!Array.isArray(list)) return [];
  const arr = list as AnyObj[];
  const used = new Set<string>();
  for (const r of routeRules(doc)) {
    const ob = String(r?.['outbound'] ?? '');
    if (ob) used.add(ob);
  }
  const route = doc.root['route'];
  const finalTag = route && typeof route === 'object' ? String((route as AnyObj)['final'] ?? '') : '';
  if (finalTag) used.add(finalTag);
  for (const o of arr) {
    if (!isGroup(o)) continue;
    for (const m of Array.isArray(o['outbounds']) ? (o['outbounds'] as unknown[]) : []) {
      const t = String(m ?? '');
      if (t) used.add(t);
    }
  }
  const allow = only && only.length ? new Set(only.map(String)) : null;
  const groupCount = arr.filter((o) => isGroup(o)).length;
  const removable = arr.filter((o) => {
    const tag = String(o['tag'] ?? '');
    if (!isGroup(o) || !tag || used.has(tag)) return false;
    return allow ? allow.has(tag) : true;
  });
  // 至少留一个分组：最多删到只剩 1 个
  const allowed = Math.max(0, Math.min(removable.length, groupCount - 1));
  const doomed = new Set(removable.slice(0, allowed).map((o) => String(o['tag'] ?? '')));
  if (!doomed.size) return [];
  const kept = arr.filter((o) => !doomed.has(String(o['tag'] ?? '')));
  arr.length = 0;
  arr.push(...kept);
  return [...doomed];
}

/* ────────────────── 格式化：出站 tag 统一大写 ────────────────── */

export interface TagNormalizeResult {
  /** 只是改名（大写化） */
  renamed: { from: string; to: string }[];
  /** 大写后撞名且类型相同 → 合并（删掉原条目，引用指向已存在那个） */
  merged: { from: string; to: string }[];
  /** 改写掉的引用处数（分组成员 / 规则出口 / final / detour） */
  refs: number;
  /** 需要人看一眼的情况（类型不同被迫改名 / 组内自引用被去掉等） */
  warnings: string[];
}

/**
 * 「格式化」里的 tag 规范化：把 outbounds[].tag 统一成大写，并同步所有引用。
 *
 * 口径（与用户约定）：
 *  · 只动**出站 tag**；桶 tag（route.rule_set[].tag，对应 NAS 文件名）不动；
 *  · 中文 / emoji tag 没有大小写，保持原样；
 *  · 大写后与已有 tag 撞名：同类型 → 合并（`direct` 并入 `DIRECT`）；不同类型 → 改名为 `<UP>_2` 并记 warning；
 *  · 引用点：outbounds[].outbounds（成员）、outbounds[].detour、route.rules[].outbound、
 *    route.rules[].action.outbound、route.final、dns.servers[].detour；成员列表顺带去重 / 去掉自引用；
 *  · 幂等：已经全大写的配置再跑一次不会产生任何改动。
 */
export function normalizeOutboundTags(doc: ConfigDoc): TagNormalizeResult {
  const res: TagNormalizeResult = { renamed: [], merged: [], refs: 0, warnings: [] };
  const list = Array.isArray(doc.root['outbounds']) ? (doc.root['outbounds'] as AnyObj[]) : [];
  const byTag = new Map<string, AnyObj>();
  for (const o of list) {
    const t = o['tag'];
    if (typeof t === 'string' && !byTag.has(t)) byTag.set(t, o);
  }
  const rename = new Map<string, string>();
  const dropped = new Set<string>();
  for (const [tag, o] of byTag) {
    const up = tag.toUpperCase();
    if (up === tag) continue;
    const exist = byTag.get(up);
    if (!exist) {
      rename.set(tag, up);
      res.renamed.push({ from: tag, to: up });
      continue;
    }
    if (String(exist['type']) === String(o['type'])) {
      rename.set(tag, up);
      dropped.add(tag);
      res.merged.push({ from: tag, to: up });
      continue;
    }
    let n = 2;
    let cand = `${up}_${n}`;
    while (byTag.has(cand)) {
      n += 1;
      cand = `${up}_${n}`;
    }
    rename.set(tag, cand);
    res.renamed.push({ from: tag, to: cand });
    res.warnings.push(`「${tag}」大写后与「${up}」撞名但类型不同（${String(o['type'])} ≠ ${String(exist['type'])}），改名 ${cand}`);
  }
  if (!rename.size) return res;

  const fix = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    const to = rename.get(v);
    if (to === undefined) return v;
    res.refs += 1;
    return to;
  };
  const fixMembers = (owner: AnyObj): void => {
    const arr = owner['outbounds'];
    if (!Array.isArray(arr)) return;
    const seen = new Set<string>();
    const next: unknown[] = [];
    for (const m of arr) {
      const t = fix(m);
      const s = String(t);
      if (seen.has(s)) continue;
      seen.add(s);
      next.push(t);
    }
    const selfTag = typeof owner['tag'] === 'string' ? String(fix(owner['tag'])) : '';
    owner['outbounds'] = selfTag ? next.filter((m) => String(m) !== selfTag) : next;
  };

  // 1) 先改所有引用（此时 tag 还是旧名，rename 表按旧名查）
  /** detour 在任何层级都指某个出站 tag（http_clients / dns.servers / inbounds / endpoints…），全树改写 */
  const fixDetours = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(fixDetours);
      return;
    }
    if (node && typeof node === 'object') {
      const o = node as AnyObj;
      if (typeof o['detour'] === 'string') o['detour'] = fix(o['detour']);
      for (const v of Object.values(o)) fixDetours(v);
    }
  };
  fixDetours(doc.root);

  for (const o of list) {
    fixMembers(o);
    // selector 的 default 也是出站 tag（漏了它会变成「default 不在成员里」）
    if (typeof o['default'] === 'string') o['default'] = fix(o['default']);
  }
  const route = doc.root['route'];
  if (route && typeof route === 'object' && !Array.isArray(route)) {
    const r = route as AnyObj;
    if (typeof r['final'] === 'string') r['final'] = fix(r['final']);
    for (const rule of Array.isArray(r['rules']) ? (r['rules'] as AnyObj[]) : []) {
      if (typeof rule['outbound'] === 'string') rule['outbound'] = fix(rule['outbound']);
      const act = rule['action'];
      if (act && typeof act === 'object' && !Array.isArray(act) && typeof (act as AnyObj)['outbound'] === 'string') {
        (act as AnyObj)['outbound'] = fix((act as AnyObj)['outbound']);
      }
    }
  }
  const dns = doc.root['dns'];
  if (dns && typeof dns === 'object' && !Array.isArray(dns)) {
    for (const s of Array.isArray((dns as AnyObj)['servers']) ? ((dns as AnyObj)['servers'] as AnyObj[]) : []) {
      if (s && typeof s === 'object' && typeof s['detour'] === 'string') s['detour'] = fix(s['detour']);
    }
  }

  // 2) 再改 tag 本身 + 丢掉被合并掉的重复出站
  const kept: AnyObj[] = [];
  for (const o of list) {
    const t = o['tag'];
    if (typeof t === 'string' && dropped.has(t)) continue;
    if (typeof t === 'string' && rename.has(t)) o['tag'] = rename.get(t)!;
    kept.push(o);
  }
  list.length = 0;
  list.push(...kept);

  // 3) 兜底：扫一遍还有没有残留旧 tag（正常应为空；只记 warning 不改）
  const leftovers: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (rename.has(node)) leftovers.push(`${path} = ${node}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'type') continue; // 类型名（direct/block…）不是 tag，不参与残留检查
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(doc.root, '');
  for (const l of leftovers.slice(0, 5)) res.warnings.push(`旧 tag 残留：${l}`);
  return res;
}

/* ────────────────── 拆解与合并：纯条件规则（port / ip_cidr …） ────────────────── */

/** 规则里这些键的值是数组（数组内 OR，数组之间 AND） */
const ARRAY_COND_KEYS = new Set([
  'ip_cidr',
  'ip_is_private', // 布尔，但这里只处理数组
  'port',
  'port_range',
  'source_ip_cidr',
  'source_port',
  'source_port_range',
  'domain',
  'domain_suffix',
  'domain_keyword',
  'domain_regex',
  'geosite',
  'geoip',
  'process_name',
  'process_path',
  'package_name',
  'network',
  'protocol',
  'client',
  'user',
]);

/** 弹窗里的一条「纯条件规则」行 */
export interface CondRuleRow {
  index: number;
  outbound: string;
  /** 数组型条件（可合并）：字段名 → 值列表 */
  arrays: { field: string; values: string[] }[];
  /** 标量型条件（原样保留，不参与拖动） */
  scalars: { field: string; value: unknown }[];
  /** 可以参与合并（恰好一个数组字段、没有标量、没有 rule_set / action） */
  mergeable: boolean;
  /** 合并签名：字段集合排序拼串（相同才能合并） */
  sig: string;
}

const ABSENT = new Set(['outbound', 'rule_set', 'action', 'invert']);

/**
 * 取某个出口下的「纯条件规则」（没有 rule_set、没有 action，只剩条件 + outbound），
 * 供「拆解与合并」弹窗的第二类行使用。
 */
export function condRuleRows(doc: ConfigDoc, outbound?: string): CondRuleRow[] {
  const out: CondRuleRow[] = [];
  routeRules(doc).forEach((r, i) => {
    if (!r || r['rule_set'] || r['action']) return;
    const ob = String(r['outbound'] ?? '');
    if (outbound !== undefined && ob !== outbound) return;
    const arrays: { field: string; values: string[] }[] = [];
    const scalars: { field: string; value: unknown }[] = [];
    for (const [k, v] of Object.entries(r)) {
      if (ABSENT.has(k)) continue;
      if (Array.isArray(v) && ARRAY_COND_KEYS.has(k)) {
        arrays.push({ field: k, values: v.map((x) => String(x)) });
      } else {
        scalars.push({ field: k, value: v });
      }
    }
    if (!arrays.length && !scalars.length) return; // 纯 outbound 的兜底规则，不参与
    arrays.sort((a, b) => a.field.localeCompare(b.field));
    const sig = arrays.map((a) => a.field).join(',');
    out.push({
      index: i,
      outbound: ob,
      arrays,
      scalars,
      mergeable: arrays.length === 1 && scalars.length === 0,
      sig,
    });
  });
  return out;
}

/** 合并两条条件规则的字段（同字段集合才能合并；数组取并集，标量必须相等） */
export function mergeCondData(
  a: AnyObj,
  b: AnyObj,
): { ok: true; merged: AnyObj } | { ok: false; reason: string } {
  const keysA = Object.keys(a).filter((k) => !ABSENT.has(k)).sort();
  const keysB = Object.keys(b).filter((k) => !ABSENT.has(k)).sort();
  if (keysA.join(',') !== keysB.join(',')) {
    return { ok: false, reason: `条件字段不同（${keysA.join('+') || '空'} vs ${keysB.join('+') || '空'}），不能合并` };
  }
  const merged: AnyObj = {};
  for (const k of keysA) {
    const va = a[k];
    const vb = b[k];
    if (Array.isArray(va) && Array.isArray(vb)) {
      const seen = new Set<string>();
      const arr: unknown[] = [];
      for (const x of [...va, ...vb]) {
        const key = JSON.stringify(x);
        if (seen.has(key)) continue;
        seen.add(key);
        arr.push(x);
      }
      merged[k] = arr;
    } else if (JSON.stringify(va) === JSON.stringify(vb)) {
      merged[k] = va;
    } else {
      return { ok: false, reason: `字段 ${k} 的取值不同（${JSON.stringify(va)} vs ${JSON.stringify(vb)}），不能合并` };
    }
  }
  return { ok: true, merged };
}

/** 条件对象是否「实质为空」：没有键，或所有数组都是空数组 */
export function condIsEmpty(cond: AnyObj | null | undefined): boolean {
  if (!cond) return true;
  for (const v of Object.values(cond)) {
    if (Array.isArray(v)) {
      if (v.length) return false;
    } else {
      return false;
    }
  }
  return true;
}

/** 去掉条件里已经拖空的数组字段（保留标量） */
export function tidyCond(cond: AnyObj | null | undefined): AnyObj {
  const out: AnyObj = {};
  for (const [k, v] of Object.entries(cond ?? {})) {
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/** 弹窗保存用的一行（桶引用 / 条件规则 二选一） */
export interface RegroupRowPlan {
  index: number | null;
  anchor: number;
  outbound: string;
  buckets: string[];
  cond: AnyObj | null;
}

/**
 * 按弹窗结果重写 route.rules：
 *  · index 存在 → 原地替换（保留原规则其它字段；buckets/cond 都空 → 删掉这条规则）；
 *  · index=null → 插在 anchor 之后（buckets/cond 都空 → 不落盘）；
 *  · 未参与的行原样保留。
 */
export function applyRegroupRows(doc: ConfigDoc, rows: RegroupRowPlan[]): void {
  const rules = ensureRouteRules(ensureRoute(doc));
  const byIndex = new Map<number, RegroupRowPlan>();
  for (const r of rows) if (r.index !== null) byIndex.set(r.index, r);
  const inserts = new Map<number, RegroupRowPlan[]>();
  for (const r of rows) {
    if (r.index !== null) continue;
    if (!r.buckets.length && !r.cond) continue;
    const list = inserts.get(r.anchor) ?? [];
    list.push(r);
    inserts.set(r.anchor, list);
  }
  const build = (orig: AnyObj | null, row: RegroupRowPlan): AnyObj | null => {
    // cond 空对象 / 全空数组 = 这条条件规则被拖空了 → 删掉
    // （否则会写出 {"port": []} 这种永远不命中的空壳规则）
    const hasCond = !condIsEmpty(row.cond);
    if (row.buckets.length === 0 && !hasCond) return null;
    const next: AnyObj = orig ? { ...orig } : {};
    delete next['rule_set'];
    if (row.buckets.length) next['rule_set'] = [...row.buckets];
    if (hasCond) {
      // 条件行：用新条件整体替换旧条件字段（保留 invert 等不在 cond 里的字段）
      for (const k of Object.keys(next)) {
        if (k === 'outbound' || k === 'rule_set' || k === 'invert') continue;
        delete next[k];
      }
      Object.assign(next, row.cond!);
    }
    next['outbound'] = row.outbound;
    return next;
  };
  const nextRules: AnyObj[] = [];
  rules.forEach((r, i) => {
    const row = byIndex.get(i);
    if (!row) {
      nextRules.push(r);
    } else {
      const built = build(r, row);
      if (built) nextRules.push(built);
    }
    for (const add of inserts.get(i) ?? []) {
      const built = build(null, add);
      if (built) nextRules.push(built);
    }
  });
  for (const add of inserts.get(-1) ?? []) {
    const built = build(null, add);
    if (built) nextRules.push(built);
  }
  rules.length = 0;
  rules.push(...nextRules);
}
