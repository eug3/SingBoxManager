/**
 * group-board-model — 分组看板的纯函数：读盘 + 拖拽后生成新文档。
 *
 * 语义（与 rule-model.ts 同一套口径）：
 *  · 分组 = outbounds[] 里 type ∈ {selector, urltest} 的条目，成员写在它自己的 outbounds[]（tag 数组）；
 *  · 池（未分组）= 不属于任何分组的非分组条目，含 direct/block/dns 等特殊出站与 endpoints[]（masque）；
 *  · 改分组成员 = 改 config 结构 → 需「应用并重启」。route.rules / route.rule_set 一概不碰。
 *
 * 所有函数都不修改入参 doc：moveMember 先 structuredClone 根节点再改，
 * 返回的新 ConfigDoc 交给 ConfigPane.enterReview 用 serializeConfig 按原文缩进/行尾写回文本。
 */

import { AnyObj, ConfigDoc, GROUP_TYPES, SPECIAL_TYPES } from './config-ops';

/** 条目元信息（模板渲染 chip 用） */
export interface BoardMeta {
  type: string;
  special: boolean; // direct/block/dns 等特殊出站 → 不同底色
  server?: string; // host:port，没有 server 字段的条目省略
}

/** 分组列 */
export interface BoardGroup {
  tag: string;
  type: string; // selector | urltest
  count: number; // 成员数（= members.length，列头直接显示）
  default: string; // 组里的 default；没有该键为 ''
  members: string[]; // 成员 tag，原样保留（可能含分组 tag = 既有嵌套，只读展示）
}

/** 看板数据（全部来自已拉取的 config，只在浏览器里解析） */
export interface BoardData {
  groups: BoardGroup[];
  pool: string[]; // 未分组：既不是分组、也不在任何分组的成员里（含 endpoints 条目），保持 config 里的先后顺序
  meta: Record<string, BoardMeta>; // tag → 元信息（含分组自身，模板据此判定「这是分组，不能拖进分组」）
}

function asObj(v: unknown): AnyObj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyObj) : null;
}

/** root[key]（对象数组）→ 对象条目列表；形状不对时返回空列表，不抛错 */
function entriesOf(root: AnyObj, key: string): AnyObj[] {
  const v = root[key];
  if (!Array.isArray(v)) return [];
  const out: AnyObj[] = [];
  for (const item of v) {
    const o = asObj(item);
    if (o) out.push(o);
  }
  return out;
}

function tagOf(o: AnyObj): string {
  return String(o['tag'] ?? '?');
}

/** 分组的成员 tag（缺失/形状不对按空数组处理） */
function memberTags(o: AnyObj): string[] {
  return Array.isArray(o['outbounds']) ? (o['outbounds'] as unknown[]).map(String) : [];
}

function metaOfEntry(o: AnyObj): BoardMeta {
  const type = String(o['type'] ?? '?');
  const special = SPECIAL_TYPES.has(type);
  const host = typeof o['server'] === 'string' ? o['server'] : '';
  const port = o['server_port'];
  const hasPort = port !== undefined && port !== null && port !== '';
  const server = host ? `${host}${hasPort ? ':' + String(port) : ''}` : '';
  return server ? { type, special, server } : { type, special };
}

/**
 * 读整份配置 → 看板数据（不改入参）。
 * 池只收「不属于任何分组」的非分组条目：分组 tag 本身永远不进池列，
 * 已经挂在某个组里的节点也不会重复出现在池里（哪怕它同时挂在多个组）。
 */
export function readBoard(doc: ConfigDoc): BoardData {
  const obList = entriesOf(doc.root, 'outbounds');
  const epList = entriesOf(doc.root, 'endpoints');

  const groups: BoardGroup[] = [];
  const inAnyGroup = new Set<string>();
  for (const o of obList) {
    const type = String(o['type'] ?? '');
    if (!GROUP_TYPES.has(type)) continue;
    const members = memberTags(o);
    for (const m of members) inAnyGroup.add(m);
    groups.push({
      tag: tagOf(o),
      type,
      count: members.length,
      default: o['default'] === undefined || o['default'] === null ? '' : String(o['default']),
      members,
    });
  }

  const meta: Record<string, BoardMeta> = {};
  const pool: string[] = [];
  // outbounds 在前、endpoints 在后：与配置文件的书写顺序一致，便于对着原文核
  for (const o of [...obList, ...epList]) {
    const tag = tagOf(o);
    const type = String(o['type'] ?? '');
    meta[tag] = metaOfEntry(o);
    if (GROUP_TYPES.has(type)) continue; // 分组本身不进池
    if (inAnyGroup.has(tag)) continue; // 已在某个分组里
    pool.push(tag);
  }

  return { groups, pool, meta };
}

/** 成员变化后修正 default：不在成员里就退回第一个成员；组变空就删掉该键（没有该键则不动） */
function fixDefault(g: AnyObj): void {
  if (!Object.prototype.hasOwnProperty.call(g, 'default')) return;
  const members = memberTags(g);
  if (!members.length) {
    delete g['default'];
    return;
  }
  const cur = g['default'];
  if (typeof cur !== 'string' || !members.includes(cur)) g['default'] = members[0];
}

/**
 * 拖动一个条目 → 生成新的 ConfigDoc（structuredClone 后改，绝不修改入参）。
 *
 *  · targetGroup 非空：加入该分组（已在组里=无改动；去重、按原顺序追加到末尾）；
 *  · targetGroup 为 null：从所有分组里移除（分组 tag 也可以拖出，那只是取消嵌套，不会造出嵌套）；
 *  · 改完修正受影响分组的 default（见 fixDefault）。
 *
 * 返回 undefined 的两种情形：非法（分组 tag 拖进分组、目标组不存在、条目不存在）
 * 与无改动（已在该组 / 本来就不在任何组）——后者避免拿一份相同的文档去覆盖暂存。
 */
export function moveMember(
  doc: ConfigDoc,
  tag: string,
  targetGroup: string | null,
): ConfigDoc | undefined {
  const t = String(tag ?? '');
  if (!t) return undefined;

  const root = structuredClone(doc.root) as AnyObj;
  const obList = entriesOf(root, 'outbounds');
  const epList = entriesOf(root, 'endpoints');
  if (![...obList, ...epList].some((o) => tagOf(o) === t)) return undefined;

  const groupObjs = obList.filter((o) => GROUP_TYPES.has(String(o['type'])));
  const tIsGroup = groupObjs.some((g) => tagOf(g) === t);

  if (targetGroup === null) {
    // 只修正「成员真的被改过」的组：没碰过的组里本来就存在的失效 default 不顺手改，避免一次拖拽动到无关分组
    let changed = false;
    for (const g of groupObjs) {
      const members = memberTags(g);
      const i = members.indexOf(t);
      if (i < 0) continue;
      members.splice(i, 1);
      g['outbounds'] = members;
      fixDefault(g);
      changed = true;
    }
    return changed ? { root } : undefined;
  }

  // 分组不能拖进分组（否则会造出嵌套 selector/urltest）
  if (tIsGroup) return undefined;
  const wanted = String(targetGroup);
  const target = groupObjs.find((g) => tagOf(g) === wanted);
  if (!target) return undefined;

  const members = memberTags(target);
  if (members.includes(t)) return undefined; // 已在该组：无改动
  members.push(t);
  target['outbounds'] = members;
  fixDefault(target);
  return { root };
}
