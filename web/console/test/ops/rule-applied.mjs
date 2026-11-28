// 共享规则池：不区分来源 + 已应用/未应用 状态判定
const { SharedPoolService, groupStatus, isAppliedEverywhere, routerGroupRefs, sameRefSet } =
  await import('../../.test-build/shared-pool.mjs');
const m = await import('../../.test-build/config-ops.mjs');
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const out = [];
const ok = (n, c, x = '') => out.push([n, !!c, x]);
const P = (o) => m.parseConfig(JSON.stringify(o));
const router = (tag, name, rules, outs = ['G', 'X']) => ({
  tag,
  name,
  doc: P({
    outbounds: [
      { type: 'selector', tag: 'G', outbounds: ['X'] },
      { type: 'shadowsocks', tag: 'X', server: '1.1.1.1', server_port: 1, method: 'x', password: 'p' },
      ...outs.filter((t) => t !== 'G' && t !== 'X').map((t) => ({ type: 'selector', tag: t, outbounds: ['X'] })),
    ],
    route: { final: 'G', rules },
  }),
});

// 1) 集合比较：顺序不影响
ok('sameRefSet 顺序无关', sameRefSet(['a', 'b'], ['b', 'a']));
ok('sameRefSet 不同长度 false', !sameRefSet(['a'], ['a', 'b']));
ok('sameRefSet 内容不同 false', !sameRefSet(['a', 'b'], ['a', 'c']));

// 2) 各路由组名引用读取（含字符串/数组两种 rule_set）
{
  const d = P({
    outbounds: [{ type: 'selector', tag: 'G', outbounds: [] }],
    route: { rules: [{ rule_set: 'rs-a', outbound: 'G' }, { rule_set: ['rs-b', 'rs-a'], outbound: 'G' }] },
  });
  const r = routerGroupRefs(d, 'G');
  ok('并集去重（字符串+数组混写）', JSON.stringify(r.refs) === '["rs-a","rs-b"]', JSON.stringify(r.refs));
  ok('hasOutbound 命中', r.hasOutbound);
  ok('不存在的组名 hasOutbound=false', !routerGroupRefs(d, 'NOPE').hasOutbound);
}

// 3) 两台路由都一致 → 已应用
{
  const rs = [
    router('r1', '甲', [{ rule_set: ['rs-a', 'rs-b'], outbound: 'G' }]),
    router('r2', '乙', [{ rule_set: ['rs-b', 'rs-a'], outbound: 'G' }]),
  ];
  const st = groupStatus(['rs-a', 'rs-b'], 'G', rs);
  ok('顺序不同也算一致', st.every((s) => s.same), JSON.stringify(st.map((s) => s.same)));
  ok('→ 已应用', isAppliedEverywhere(st));
}

// 4) 一台不同 → 未应用，并给出差异
{
  const rs = [
    router('r1', '甲', [{ rule_set: ['rs-a', 'rs-b'], outbound: 'G' }]),
    router('r2', '乙', [{ rule_set: ['rs-a'], outbound: 'G' }]),
  ];
  const st = groupStatus(['rs-a', 'rs-b'], 'G', rs);
  ok('有一台不同 → 不是全部一致', !isAppliedEverywhere(st));
  const bad = st.find((s) => !s.same);
  ok('差异定位到乙且缺 rs-b', bad.name === '乙' && JSON.stringify(bad.missing) === '["rs-b"]', JSON.stringify(bad));
}

// 5) 没有该组名的路由不算「未应用」
{
  const rs = [
    router('r1', '甲', [{ rule_set: ['rs-a'], outbound: 'G' }]),
    { tag: 'r2', name: '乙', doc: P({ outbounds: [{ type: 'direct', tag: 'DIRECT' }], route: { rules: [] } }) },
  ];
  const st = groupStatus(['rs-a'], 'G', rs);
  ok('乙没有该组名 → 不参与判定', st.find((s) => s.name === '乙').hasOutbound === false);
  ok('→ 仍算已应用', isAppliedEverywhere(st));
}

// 6) 读不到配置 → 未知，不算已应用
{
  const rs = [
    router('r1', '甲', [{ rule_set: ['rs-a'], outbound: 'G' }]),
    { tag: 'r2', name: '乙', doc: null, err: '读取超时' },
  ];
  const st = groupStatus(['rs-a'], 'G', rs);
  ok('读不到 → err 标记', st.find((s) => s.name === '乙').err === '读取超时');
  ok('读不到 → 不算已应用', !isAppliedEverywhere(st));
}

// 7) 池服务：不区分来源、按组名去重、状态可改
{
  const svc = new SharedPoolService();
  const a = svc.addRuleGroup('G', ['rs-a'], { api: 'r1', name: '甲' });
  ok('加入成功', a.ok && svc.rules().length === 1, JSON.stringify(a));
  ok('初始为未应用', svc.rules()[0].applied === false);
  const b = svc.addRuleGroup('G', ['rs-a', 'rs-b'], { api: 'r2', name: '乙' });
  ok('同组名来自另一台 → 更新同一条（不新增）', b.dup && svc.rules().length === 1, JSON.stringify(b));
  ok('更新后回到未应用', svc.rules()[0].applied === false && svc.rules()[0].refs.length === 2);
  const id = svc.rules()[0].id;
  svc.setRuleApplied(id, true);
  ok('标为已应用', svc.rules()[0].applied === true && !!svc.rules()[0].appliedAt);
  ok('rulesStats 正确', JSON.stringify(svc.rulesStats()) === '{"applied":1,"pending":0}', JSON.stringify(svc.rulesStats()));
  svc.addRuleGroup('H', ['rs-h'], { api: 'r1', name: '甲' });
  const list = svc.rulesList();
  ok('列表未应用排前面', list[0].group === 'H' && list[1].group === 'G', JSON.stringify(list.map((r) => r.group)));
  ok('按组名可查', svc.ruleByGroup('G')?.id === id);
  // 导入导出保留状态
  const svc2 = new SharedPoolService();
  svc2.importJson(svc.exportJson());
  ok('导出/导入保留 applied 状态', svc2.rules().find((r) => r.group === 'G')?.applied === true);
  // 老数据（带 sourceApi，无 applied）兼容
  const svc3 = new SharedPoolService();
  svc3.importJson(JSON.stringify({ version: 2, nodes: [], rules: [{ id: 'x', sourceApi: 'a', sourceName: 'A', group: 'G', refs: ['rs-a'], addedAt: 1 }] }));
  ok('老数据缺 applied → 未应用', svc3.rules()[0].applied === false);
}

export const results = out;

// ── 追加：规则条目编辑（updateRuleRefs）──
{
  const svc = new SharedPoolService();
  svc.addRuleGroup('G', ['rs-a'], { api: 'r1', name: '甲' });
  const id = svc.rules()[0].id;
  svc.setRuleApplied(id, true);
  const r1 = svc.updateRuleRefs(id, ['rs-a', 'rs-b']);
  ok('编辑 refs 成功', r1.ok && svc.rules()[0].refs.join() === 'rs-a,rs-b', JSON.stringify(r1));
  ok('改了 refs → 回到未应用', svc.rules()[0].applied === false && svc.rules()[0].appliedAt === undefined);
  svc.setRuleApplied(id, true);
  const r2 = svc.updateRuleRefs(id, ['rs-b', 'rs-a']);
  ok('集合相同（仅顺序）→ 保持已应用', r2.ok && svc.rules()[0].applied === true, JSON.stringify(svc.rules()[0]));
  ok('空列表拒绝', !svc.updateRuleRefs(id, []).ok);
  ok('去重 + 去空白', svc.updateRuleRefs(id, [' rs-a ', 'rs-a', '', 'rs-c']).ok && svc.rules()[0].refs.join() === 'rs-a,rs-c');
  ok('不存在的 id 拒绝', !svc.updateRuleRefs('nope', ['x']).ok);
}
