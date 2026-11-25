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

/** route.rules 数组（缺省空） */
function routeRules(doc: ConfigDoc): AnyObj[] {
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