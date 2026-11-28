// 解除应用（detachGroupRefs）+ 启动核对漂移（driftedRouters）
const m = await import('../../.test-build/config-ops.mjs');
const { groupStatus, driftedRouters, isAppliedEverywhere } = await import('../../.test-build/shared-pool.mjs');
const out = [];
const ok = (n, c, x = '') => out.push([n, !!c, x]);
const P = (o) => m.parseConfig(JSON.stringify(o));

// 1) 解除：只删集合完全一致的那条
{
  const d = P({ outbounds: [{ type: 'selector', tag: 'G', outbounds: ['X'] }, { type: 'ss', tag: 'X' }], route: { rules: [
    { rule_set: ['rs-a', 'rs-b'], outbound: 'G' },
    { rule_set: ['rs-a'], outbound: 'G' },
    { port: [443], outbound: 'G' },
    { rule_set: ['rs-a', 'rs-b'], outbound: 'DIRECT' },
  ] } });
  const r = m.detachGroupRefs(d, 'G', ['rs-b', 'rs-a']);
  ok('只删集合一致的那条（顺序无关）', r.removed === 1, JSON.stringify(r));
  const left = d.root.route.rules.map((x) => x.outbound + ':' + JSON.stringify(x.rule_set ?? x.port));
  ok('路由自己的/带条件的/别的出口都保留', JSON.stringify(left) === JSON.stringify(['G:["rs-a"]', 'G:[443]', 'DIRECT:["rs-a","rs-b"]']), JSON.stringify(left));
  ok('出口与组内节点不动', d.root.outbounds.length === 2 && d.root.outbounds[0].tag === 'G');
  ok('再解除 → 0（幂等）', m.detachGroupRefs(d, 'G', ['rs-a', 'rs-b']).removed === 0);
}
// 2) 字符串形式 rule_set 也能解除
{
  const d = P({ outbounds: [{ type: 'selector', tag: 'G', outbounds: [] }], route: { rules: [{ rule_set: 'rs-a', outbound: 'G' }] } });
  ok('字符串形式 rule_set 可解除', m.detachGroupRefs(d, 'G', ['rs-a']).removed === 1 && d.root.route.rules.length === 0);
}
// 3) 解除后状态应变「未应用」：共享规则 ['rs-a']，路由删掉后 refs 为空 → 不一致
{
  const d = P({ outbounds: [{ type: 'selector', tag: 'G', outbounds: [] }], route: { rules: [{ rule_set: 'rs-a', outbound: 'G' }] } });
  const before = isAppliedEverywhere(groupStatus(['rs-a'], 'G', [{ tag: 'r', name: '甲', doc: d }]));
  m.detachGroupRefs(d, 'G', ['rs-a']);
  const after = isAppliedEverywhere(groupStatus(['rs-a'], 'G', [{ tag: 'r', name: '甲', doc: d }]));
  ok('解除前已应用 → 解除后未应用', before === true && after === false);
}

// 4) 启动核对：漂移 = 标了已应用但某台路由没跟上
{
  const a = P({ outbounds: [{ type: 'selector', tag: 'G', outbounds: [] }], route: { rules: [{ rule_set: ['rs-a', 'rs-b'], outbound: 'G' }] } });
  const b = P({ outbounds: [{ type: 'selector', tag: 'G', outbounds: [] }], route: { rules: [{ rule_set: ['rs-a'], outbound: 'G' }] } }); // 少 rs-b
  const st = groupStatus(['rs-a', 'rs-b'], 'G', [
    { tag: 'a', name: '甲', doc: a },
    { tag: 'b', name: '乙', doc: b },
  ]);
  const drift = driftedRouters(st);
  ok('漂移定位到乙、不含甲', drift.length === 1 && drift[0].name === '乙', JSON.stringify(drift.map((x) => x.name)));
  ok('漂移项带缺失详情', JSON.stringify(drift[0].missing) === '["rs-b"]', JSON.stringify(drift[0]));
  ok('此时整体不算已应用', !isAppliedEverywhere(st));
  // 没有该组名的路由不算漂移（甲用与 refs 完全一致的夹具，只剩丙「没这个组」这一种情况）
  const c = P({ outbounds: [{ type: 'direct', tag: 'DIRECT' }], route: { rules: [] } });
  const a1 = P({ outbounds: [{ type: 'selector', tag: 'G', outbounds: [] }], route: { rules: [{ rule_set: 'rs-a', outbound: 'G' }] } });
  const st2 = groupStatus(['rs-a'], 'G', [{ tag: 'a', name: '甲', doc: a1 }, { tag: 'c', name: '丙', doc: c }]);
  ok('没有该组名的路由不进漂移', driftedRouters(st2).length === 0);
}
export const results = out;
