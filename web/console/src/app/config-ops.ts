/** config-ops — 在整份 sing-box 配置上做结构化节点增删改（保持缩进/行尾风格） */

export type AnyObj = Record<string, unknown>;

export interface ConfigDoc {
  root: AnyObj;
}

export interface NodeSummary {
  tag: string;
  type: string;
  server: string;
  groups: string[];
  routeRefs: number;
  special: boolean;
}

export const GROUP_TYPES = new Set(['selector', 'urltest']);
export const SPECIAL_TYPES = new Set(['direct', 'block', 'dns']);

export function parseConfig(raw: string): ConfigDoc {
  const root = JSON.parse(raw) as unknown;
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('配置根节点必须是对象');
  return { root: root as AnyObj };
}

function detectIndent(raw: string): number {
  const line = raw.split(/\r?\n/)[1] ?? '';
  const m = line.match(/^( +)/);
  return m ? m[1].length : 2;
}

export function serializeConfig(doc: ConfigDoc, like: string): string {
  const crlf = like.includes('\r\n');
  const indent = detectIndent(like);
  let out = JSON.stringify(doc.root, null, indent);
  if (crlf) out = out.replace(/\n/g, '\r\n');
  return out + (like.endsWith('\n') ? (crlf ? '\r\n' : '\n') : '');
}

function outbounds(doc: ConfigDoc): AnyObj[] {
  return Array.isArray(doc.root['outbounds']) ? (doc.root['outbounds'] as AnyObj[]) : [];
}

function endpoints(doc: ConfigDoc): AnyObj[] {
  return Array.isArray(doc.root['endpoints']) ? (doc.root['endpoints'] as AnyObj[]) : [];
}

function routeRules(doc: ConfigDoc): AnyObj[] {
  const route = doc.root['route'] as AnyObj | undefined;
  return Array.isArray(route?.['rules']) ? (route!['rules'] as AnyObj[]) : [];
}

export function isGroup(o: AnyObj): boolean {
  return GROUP_TYPES.has(String(o['type']));
}

export function groups(doc: ConfigDoc): AnyObj[] {
  return outbounds(doc).filter(isGroup);
}

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
  const tags = new Set(counter.keys());
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