import { AnyObj } from './config-ops';

/**
 * VPS 部署结果 → 共享节点池条目 的纯逻辑（单独成文件便于单测）。
 *
 * 后端 POST /vps/deploy 成功后返回 `node`（一个 masque-client endpoint）。
 * 这里负责：校验形状、处理池内 tag 冲突（同 tag 会覆盖别的来源的节点，不能不管）。
 */

/** 池内 tag 去冲突：desired → desired-2 → desired-3 …（最多 20 次，仍冲突则加短随机后缀） */
export function resolvePoolTag(desired: string, taken: readonly string[]): string {
  const set = new Set(taken.map((t) => String(t ?? '').trim()).filter(Boolean));
  const base = (String(desired ?? '').trim() || 'vps').slice(0, 40);
  if (!set.has(base)) return base;
  for (let i = 2; i <= 20; i++) {
    const t = `${base}-${i}`;
    if (!set.has(t)) return t;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

export interface PoolNodeBuild {
  ok: boolean;
  node?: AnyObj;
  /** 最终写进池的 tag（可能与后端给的不同） */
  tag?: string;
  /** tag 是否被改过（界面要提示） */
  renamed?: boolean;
  reason?: string;
}

/**
 * 把部署返回的 endpoint 变成可直接喂给 SharedPoolService.addNode 的节点。
 * taken = 池里已被其它来源占用的 tag（同来源的会被覆盖，所以不用排除）。
 */
export function buildPoolNode(
  host: string,
  node: AnyObj | null | undefined,
  taken: readonly string[],
): PoolNodeBuild {
  if (!host || !String(host).trim()) return { ok: false, reason: '缺少 VPS 主机名' };
  if (!node || typeof node !== 'object') return { ok: false, reason: '部署结果里没有节点' };
  const type = String(node['type'] ?? '').trim();
  if (type !== 'masque-client') return { ok: false, reason: `只接受 masque-client 端点，实际是「${type || '空'}」` };
  const server = String(node['server'] ?? '').trim();
  if (!server) return { ok: false, reason: '节点缺少 server' };
  const rawTag = String(node['tag'] ?? '').trim();
  if (!rawTag) return { ok: false, reason: '节点缺少 tag' };
  const finalTag = resolvePoolTag(rawTag, taken);
  const out = { ...structuredClone(node), tag: finalTag } as AnyObj;
  return { ok: true, node: out, tag: finalTag, renamed: finalTag !== rawTag };
}
