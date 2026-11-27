// 共享节点：同名覆盖 + 池内编辑 的纯函数回归
const { SharedPoolService, replaceSameNameNode } = await import('../../.test-build/shared-pool.mjs');
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

const nodeS = { type: 'shadowsocks', tag: 'LAN-FD-SA', server: '192.168.31.99', server_port: 17553, method: 'aes-128-gcm', password: 'old' };
const doc = () => P({
  outbounds: [
    { type: 'selector', tag: 'G', outbounds: ['LAN-FD-SA', 'X'] },
    { ...nodeS },
    { type: 'shadowsocks', tag: 'X', server: '1.1.1.1', server_port: 1, method: 'x', password: 'p' },
  ],
  route: { final: 'G', rules: [{ rule_set: 'rs-a', outbound: 'G' }] },
});

// 1) 同名覆盖：整体替换、tag/位置/引用不动
{
  const d = doc();
  const poolNode = { tag: 'LAN-FD-SA', kind: 'outbound', node: { ...nodeS, password: 'NEW', tls: { enabled: true } } };
  const res = replaceSameNameNode(d, poolNode, 'LAN-FD-SA');
  ok('同名覆盖成功', res.ok, JSON.stringify(res));
  const after = d.root.outbounds[1];
  ok('位置不变（仍是下标 1）', after.tag === 'LAN-FD-SA' && after.password === 'NEW', JSON.stringify(after));
  ok('新增字段带过来（tls）', after.tls && after.tls.enabled === true);
  ok('分组引用不动', JSON.stringify(d.root.outbounds[0].outbounds) === '["LAN-FD-SA","X"]');
  ok('规则不动', JSON.stringify(d.root.route.rules[0]) === '{"rule_set":"rs-a","outbound":"G"}');
  ok('validateDoc 通过', m.validateDoc(d).length === 0, m.validateDoc(d).join('/'));
}

// 2) 不同名：拒绝（不新增、不改）
{
  const d = doc();
  const before = JSON.stringify(d.root);
  const res = replaceSameNameNode(d, { tag: 'LAN-FD-KR', kind: 'outbound', node: { type: 'ss', tag: 'LAN-FD-KR' } }, 'LAN-FD-SA');
  ok('不同名拒绝', !res.ok && /只有同名/.test(res.reason), JSON.stringify(res));
  ok('拒绝时文档不变', JSON.stringify(d.root) === before);
}

// 3) 目标没有该节点：拒绝
{
  const res = replaceSameNameNode(doc(), { tag: 'NOPE', kind: 'outbound', node: { type: 'ss', tag: 'NOPE' } }, 'NOPE');
  ok('目标没有同名节点 → 拒绝', !res.ok && /没有叫/.test(res.reason), JSON.stringify(res));
}

// 4) 类型不同（endpoint vs outbound）：拒绝
{
  const d = P({ outbounds: [{ type: 'shadowsocks', tag: 'M', server: 'a', server_port: 1, method: 'x', password: 'p' }], endpoints: [], route: {} });
  const res = replaceSameNameNode(d, { tag: 'M', kind: 'endpoint', node: { type: 'masque-client', tag: 'M', server: 'b', server_port: 2 } }, 'M');
  ok('类型不同拒绝', !res.ok && /类型不同/.test(res.reason), JSON.stringify(res));
}

// 5) endpoint 覆盖 endpoint（放回 endpoints 数组）
{
  const d = P({ outbounds: [], endpoints: [{ type: 'masque-client', tag: 'EP', server: 'old', server_port: 1 }], route: {} });
  const res = replaceSameNameNode(d, { tag: 'EP', kind: 'endpoint', node: { type: 'masque-client', tag: 'EP', server: 'new', server_port: 2, password: 'zz' } }, 'EP');
  ok('endpoint 覆盖进 endpoints', res.ok && d.root.endpoints[0].server === 'new' && d.root.endpoints[0].password === 'zz', JSON.stringify(d.root.endpoints));
  ok('没有串到 outbounds', (d.root.outbounds ?? []).length === 0);
}

// 6) 池内编辑
{
  const svc = new SharedPoolService();
  svc.addNode({ api: 'a', name: '32' }, { ...nodeS }, 'outbound');
  const id = svc.nodes()[0].id;
  const r1 = svc.updateNode(id, { ...nodeS, password: 'EDITED' });
  ok('池内编辑保存', r1.ok && svc.nodes()[0].node.password === 'EDITED', JSON.stringify(r1));
  ok('改 tag 也生效', svc.updateNode(id, { ...nodeS, tag: 'RENAMED' }).ok && svc.nodes()[0].tag === 'RENAMED');
  ok('缺 type 拒绝', !svc.updateNode(id, { tag: 'X' }).ok);
  ok('缺 tag 拒绝', !svc.updateNode(id, { type: 'ss' }).ok);
  // 同来源同 tag 撞车
  svc.addNode({ api: 'a', name: '32' }, { type: 'vmess', tag: 'OTHER', server: 'z', server_port: 9, uuid: 'u' });
  const other = svc.nodes().find((n) => n.tag === 'OTHER');
  ok('同来源同名 tag 撞车拒绝', !svc.updateNode(id, { type: 'ss', tag: 'OTHER' }).ok);
  ok('不存在的 id 拒绝', !svc.updateNode('nope', { type: 'ss', tag: 'Q' }).ok);
  void other;
}

export const results = out;
