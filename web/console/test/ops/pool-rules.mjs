const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const m = await import('../../.test-build/config-ops.mjs');
const { SharedPoolService } = await import('../../.test-build/shared-pool.mjs');
const out = []; const ok = (n, c, x = '') => out.push([n, !!c, x]);

const src = m.parseConfig(JSON.stringify({
  outbounds: [
    { type: 'selector', tag: '🚀 节点选择', outbounds: ['A', 'B'] },
    { type: 'shadowsocks', tag: 'A', server: '1.1.1.1', server_port: 1, method: 'x', password: 'p' },
    { type: 'shadowsocks', tag: 'B', server: '1.1.1.2', server_port: 2, method: 'x', password: 'p' },
    { type: 'direct', tag: 'DIRECT' },
  ],
  route: {
    final: '🚀 节点选择',
    rules: [
      { rule_set: ['rs-google', 'rs-github'], outbound: '🚀 节点选择' },
      { port: [8080], outbound: '🚀 节点选择' },
      { rule_set: ['rs-msft'], outbound: '🚀 节点选择' },
      { rule_set: ['rs-cn'], outbound: 'DIRECT' },
    ],
  },
}));

const refs = m.groupRuleRefs(src, '🚀 节点选择');
ok('组名下的规则集并集（按出现顺序）', JSON.stringify(refs) === JSON.stringify(['rs-google','rs-github','rs-msft']), JSON.stringify(refs));
ok('DIRECT 单独算', JSON.stringify(m.groupRuleRefs(src, 'DIRECT')) === '["rs-cn"]');
const groups = m.groupsWithRuleRefs(src);
ok('组名清单', groups.length === 2 && groups.find((g) => g.group === '🚀 节点选择').rules === 2, JSON.stringify(groups));

// 目标路由：同组名但规则集不同（且多一条）
const dst = m.parseConfig(JSON.stringify({
  outbounds: [
    { type: 'selector', tag: '🚀 节点选择', outbounds: ['X'] },
    { type: 'shadowsocks', tag: 'X', server: '2.2.2.1', server_port: 1, method: 'x', password: 'p' },
    { type: 'direct', tag: 'DIRECT' },
  ],
  route: {
    final: '🚀 节点选择',
    rules: [
      { rule_set: ['rs-old'], outbound: '🚀 节点选择' },
      { rule_set: ['rs-apple'], outbound: '🚀 节点选择' },
      { rule_set: ['rs-cn'], outbound: 'DIRECT' },
    ],
  },
}));
const before = JSON.stringify(m.outbounds(dst).find((o) => o.tag === '🚀 节点选择'));
const res = m.applyGroupRefs(dst, '🚀 节点选择', refs);
ok('应用成功', res.ok, JSON.stringify(res));
ok('added/removed 正确', JSON.stringify(res.added) === JSON.stringify(['rs-google','rs-github','rs-msft']) && JSON.stringify(res.removed) === JSON.stringify(['rs-old','rs-apple']), JSON.stringify(res));
const rules = dst.root.route.rules;
ok('合并成一条规则', rules.filter((r) => r.outbound === '🚀 节点选择').length === 1, JSON.stringify(rules.map((r) => r.outbound)));
ok('引用是同一套', JSON.stringify(rules[0].rule_set) === JSON.stringify(refs), JSON.stringify(rules[0].rule_set));
ok('DIRECT 规则没被动', JSON.stringify(rules.find((r) => r.outbound === 'DIRECT').rule_set) === '["rs-cn"]');
ok('outbound/组内节点没动', before === JSON.stringify(m.outbounds(dst).find((o) => o.tag === '🚀 节点选择')));
ok('重复应用幂等', (() => { const r2 = m.applyGroupRefs(dst, '🚀 节点选择', refs); return r2.ok && !r2.added.length && !r2.removed.length; })());
// 目标没有这个组
{
  const empty = m.parseConfig(JSON.stringify({ outbounds: [{ type: 'direct', tag: 'DIRECT' }], route: { rules: [] } }));
  const r = m.applyGroupRefs(empty, '不存在', ['rs-a']);
  ok('目标没有该组名 → 拒绝并说明', !r.ok && r.reason.includes('同名出口'), JSON.stringify(r));
}
// 服务：规则池增删/分组/导出往返
{
  const svc = new SharedPoolService();
  const a1 = svc.addRuleGroup('🚀 节点选择', refs, { api: 'a', name: '32' });
  ok('规则池加入', a1.ok && svc.rules().length === 1, JSON.stringify(a1));
  ok('refs 去重保存', JSON.stringify(svc.rules()[0].refs) === JSON.stringify(refs));
  const a2 = svc.addRuleGroup('🚀 节点选择', ['rs-google'], { api: 'a', name: '32' });
  ok('同组名更新（不再按来源去重）', a2.dup && svc.rules().length === 1 && JSON.stringify(svc.rules()[0].refs) === '["rs-google"]');
  ok('空集拒绝', svc.addRuleGroup('X', []).ok === false);
  svc.addRuleGroup('DIRECT', ['rs-cn'], { api: 'b', name: 'GL' });
  ok('池列出全部组名（不按来源分组）', svc.rulesList().length === 2 && svc.rulesStats().pending === 2, JSON.stringify(svc.rulesStats()));
  const text = svc.exportJson();
  const svc2 = new SharedPoolService();
  svc2.importJson(text);
  ok('规则池随导出往返', svc2.rules().length === 2, `${svc2.rules().length}`);
  svc.removeRule(svc.rules()[0].id);
  ok('移除规则条目', svc.rules().length === 1);
}

export const results = out;
