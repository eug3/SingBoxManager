import { readFileSync } from 'node:fs';
const m = await import('../../.test-build/config-ops.mjs');
const out = []; const ok = (n, c, x = '') => out.push([n, !!c, x]);
const load = (p) => m.parseConfig(readFileSync(p, 'utf8'));

for (const [name, path, expectIdx] of [['32', './fixtures/router-32.json', [28, 29, 30]], ['GL', './fixtures/router-172.16.8.1.json', [24, 25, 26]]]) {
  const d = load(path);
  const cond = m.condRuleRows(d, 'DIRECT');
  ok(`${name} 识别出 DIRECT 的条件规则`, cond.length >= 3, cond.map((c) => c.index).join(','));
  const ports = cond.filter((c) => c.sig === 'port' && c.mergeable);
  ok(`${name} 三条 port 规则相邻且可合并`, JSON.stringify(ports.map((c) => c.index)) === JSON.stringify(expectIdx), JSON.stringify(ports.map((c) => c.index)));
  ok(`${name} 桶规则不会混进条件行`, cond.every((c) => !c.arrays.some((a) => a.field === 'rule_set')));

  // 合并成一条
  const before = d.root.route.rules.length;
  const rows = ports.map((c, i) => (i === 0
    ? { index: c.index, anchor: c.index, outbound: 'DIRECT', buckets: [], cond: { port: ports.flatMap((x) => x.arrays[0].values) } }
    : { index: c.index, anchor: c.index, outbound: 'DIRECT', buckets: [], cond: {} }));
  // 第一行保留并集，其余置空 → 应被删掉
  m.applyRegroupRows(d, rows);
  const rules = d.root.route.rules;
  ok(`${name} 合并后少 2 条规则`, rules.length === before - 2, `${before}→${rules.length}`);
  const merged = rules[expectIdx[0]];
  ok(`${name} 并集端口正确`, Array.isArray(merged.port) && merged.port.length === 3 && ['6969','2710','1337'].every((p) => merged.port.map(String).includes(p)), JSON.stringify(merged));
  ok(`${name} 出口仍是 DIRECT`, merged.outbound === 'DIRECT');
  ok(`${name} 其它规则条数/顺序未变`, JSON.stringify(rules.map((r) => r.outbound)).length > 0 && m.validateDoc(d).length === 0, m.validateDoc(d).slice(0, 2).join('/'));
}

// mergeCondData 规则
{
  const a = { port: [1, 2] }, b = { port: [2, 3] };
  const r = m.mergeCondData(a, b);
  ok('同字段取并集去重', r.ok && JSON.stringify(r.merged.port) === '[1,2,3]', JSON.stringify(r));
  const bad = m.mergeCondData({ port: [1] }, { ip_cidr: ['1.1.1.1/32'] });
  ok('不同字段拒绝合并', !bad.ok, JSON.stringify(bad));
  const bad2 = m.mergeCondData({ port: [1], network: 'tcp' }, { port: [2], network: 'udp' });
  ok('标量不同拒绝合并', !bad2.ok, JSON.stringify(bad2));
  const good2 = m.mergeCondData({ port: [1], network: 'tcp' }, { port: [2], network: 'tcp' });
  ok('标量相同可合并', good2.ok && good2.merged.network === 'tcp' && good2.merged.port.length === 2);
}

// 桶引用组走 applyRegroupRows 仍正常（回归）
{
  const d = load('./fixtures/router-32.json');
  const gs = m.ruleSetGroups(d, '🚀 节点选择');
  ok('桶分组仍能按出口读出', gs.length >= 1, JSON.stringify(gs.map((g) => g.index)));
  const before = d.root.route.rules.length;
  m.applyRegroupRows(d, gs.map((g, i) => ({ index: g.index, anchor: g.index, outbound: g.outbound, buckets: i === 0 ? [...g.tags, 'rs-line'] : g.tags, cond: null })));
  ok('桶组改动不增删规则', d.root.route.rules.length === before, `${before}→${d.root.route.rules.length}`);
  ok('桶并集写入', d.root.route.rules[gs[0].index].rule_set.includes('rs-line'));
  ok('validateDoc 通过', m.validateDoc(d).length === 0, m.validateDoc(d).slice(0, 2).join('/'));
}
// 空数组不能写成空壳规则（曾把 {"port": []} 落盘）
{
  const d = load('./fixtures/router-32.json');
  const cond = m.condRuleRows(d, 'DIRECT').filter((c) => c.sig === 'port');
  const before = d.root.route.rules.length;
  m.applyRegroupRows(d, cond.map((c, i) => ({ index: c.index, anchor: c.index, outbound: 'DIRECT', buckets: [], cond: i === 0 ? { port: ['6969','2710','1337'] } : { port: [] } })));
  const rules = d.root.route.rules;
  ok('空数组行被删掉（不留 port:[] 空壳）', rules.length === before - 2, `${before}→${rules.length}`);
  ok('没有 port:[] 残留', !rules.some((r) => Array.isArray(r.port) && r.port.length === 0), JSON.stringify(rules.filter((r) => Array.isArray(r.port))));
  ok('合并后的 port 保留', rules.some((r) => Array.isArray(r.port) && r.port.length === 3));
}

export const results = out;
