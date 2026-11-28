const m = await import('../../.test-build/config-ops.mjs');
const out = []; const ok = (n, c, x = '') => out.push([n, !!c, x]);
const P = (o) => m.parseConfig(JSON.stringify(o));

// 1) 目标有同名出口（组）、但没有挂规则集的规则 → 新增一条
{
  const d = P({ outbounds: [
      { type: 'selector', tag: '🚀 节点选择', outbounds: ['A'] },
      { type: 'shadowsocks', tag: 'A', server: '1.1.1.1', server_port: 1, method: 'x', password: 'p' },
      { type: 'direct', tag: 'DIRECT' },
    ], route: { final: '🚀 节点选择', rules: [
      { rule_set: ['rs-cn'], outbound: 'DIRECT' },
      { action: 'sniff' },
    ] } });
  const res = m.applyGroupRefs(d, '🚀 节点选择', ['rs-github', 'rs-msft']);
  ok('同名出口存在 → 新增规则', res.ok && typeof res.insertedAt === 'number', JSON.stringify(res));
  const rules = d.root.route.rules;
  ok('新规则落在 rule_set 段末尾（动作规则之后）', rules[res.insertedAt].outbound === '🚀 节点选择' && rules[res.insertedAt].rule_set.join() === 'rs-github,rs-msft', JSON.stringify(rules));
  ok('原规则顺序未变', rules[0].outbound === 'DIRECT' && rules[1].action === 'sniff');
  ok('出口/组内节点未动', JSON.stringify(d.root.outbounds[0].outbounds) === '["A"]');
  ok('validateDoc 通过', m.validateDoc(d).length === 0, m.validateDoc(d).join('/'));
}

// 2) 目标连同名出口都没有 → 明确拒绝（提示先建同名出口）
{
  const d = P({ outbounds: [{ type: 'direct', tag: 'DIRECT' }], route: { rules: [] } });
  const res = m.applyGroupRefs(d, '不存在组', ['rs-a']);
  ok('无同名出口 → 拒绝且提示同名', !res.ok && /同名出口/.test(res.reason), JSON.stringify(res));
  ok('拒绝时不动文档', d.root.route.rules.length === 0);
}

// 3) 内置出口（direct）也能挂规则集
{
  const d = P({ outbounds: [{ type: 'direct', tag: 'DIRECT' }], route: { rules: [] } });
  const res = m.applyGroupRefs(d, 'direct', ['rs-x']);
  ok('内置 direct 可挂规则集', res.ok && d.root.route.rules[0].outbound === 'direct', JSON.stringify(res));
}

// 4) 已有规则 → 仍然统一（不是新增）
{
  const d = P({ outbounds: [{ type: 'direct', tag: 'DIRECT' }], route: { rules: [
    { rule_set: ['rs-old'], outbound: 'DIRECT' },
    { rule_set: ['rs-old2'], outbound: 'DIRECT' },
  ] } });
  const res = m.applyGroupRefs(d, 'DIRECT', ['rs-new']);
  ok('已有规则 → 合并成一条而不是新增', res.ok && res.insertedAt === undefined && d.root.route.rules.length === 1, JSON.stringify(res));
  ok('合并且引用替换', d.root.route.rules[0].rule_set.join() === 'rs-new');
}

// 5) 出口定义不同也能套（正是用户要的：同名即可，出口各自）
{
  const src = P({ outbounds: [
      { type: 'selector', tag: '节点选择', outbounds: ['X', 'Y'] },
      { type: 'shadowsocks', tag: 'X', server: '1.1.1.1', server_port: 1, method: 'x', password: 'p' },
      { type: 'shadowsocks', tag: 'Y', server: '1.1.1.2', server_port: 2, method: 'x', password: 'p' },
    ], route: { rules: [{ rule_set: ['rs-a', 'rs-b'], outbound: '节点选择' }] } });
  const refs = m.groupRuleRefs(src, '节点选择');
  const dst = P({ outbounds: [
      { type: 'urltest', tag: '节点选择', outbounds: ['Z'], url: 'http://x', interval: '1m' },
      { type: 'shadowsocks', tag: 'Z', server: '9.9.9.9', server_port: 3, method: 'x', password: 'p' },
    ], route: { rules: [] } });
  const before = JSON.stringify(dst.root.outbounds[0]);
  const res = m.applyGroupRefs(dst, '节点选择', refs);
  ok('出口类型不同（selector vs urltest）也能套', res.ok, JSON.stringify(res));
  ok('出口定义一字未改', before === JSON.stringify(dst.root.outbounds[0]));
  ok('规则集一致', dst.root.route.rules[0].rule_set.join() === 'rs-a,rs-b');
}

export const results = out;

// ── A5：路由没有 route / route.rules 时，applyGroupRefs 必须真把规则写进去（原来返回假成功）──
{
  const P = (o) => m.parseConfig(JSON.stringify(o));
  // 没有 route.rules
  let d = P({ outbounds: [{ type: 'selector', tag: 'G', outbounds: [] }] });
  let r = m.applyGroupRefs(d, 'G', ['rs-a', 'rs-b']);
  ok('无 route.rules：仍 ok 且新增到下标 0', r.ok && r.insertedAt === 0, JSON.stringify(r));
  ok('无 route.rules：rules 真的被创建并写入', Array.isArray(d.root.route?.rules) && d.root.route.rules.length === 1 &&
    JSON.stringify(d.root.route.rules[0]) === JSON.stringify({ rule_set: ['rs-a', 'rs-b'], outbound: 'G' }), JSON.stringify(d.root.route));
  ok('无 route.rules：写入后零悬空', m.validateDoc(d).length === 0, m.validateDoc(d).join('/'));
  // 连 route 都没有
  d = P({ outbounds: [{ type: 'selector', tag: 'G', outbounds: [] }] });
  delete d.root.route;
  r = m.applyGroupRefs(d, 'G', ['rs-a']);
  ok('无 route：route 被创建', r.ok && d.root.route && Array.isArray(d.root.route.rules) && d.root.route.rules.length === 1, JSON.stringify(d.root));
}
