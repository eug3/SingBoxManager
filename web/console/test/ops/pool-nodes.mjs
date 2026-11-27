// localStorage 桩（service 在 load/save 里用）
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// Angular 的 Injectable/signal 在 node 里可跑（signal 是纯函数式实现）
const { SharedPoolService } = await import('/tmp/pool.mjs?' );
const m = await import('../../.test-build/config-ops.mjs');

const out = []; const ok = (n, c, x = '') => out.push([n, !!c, x]);

const cfg = () => m.parseConfig(JSON.stringify({
  outbounds: [
    { type: 'selector', tag: 'G1', outbounds: ['LAN-FD-SA'] },
    { type: 'shadowsocks', tag: 'LAN-FD-SA', server: '192.168.31.99', server_port: 17553, method: 'aes-128-gcm', password: 'p' },
    { type: 'direct', tag: 'DIRECT' },
  ],
  route: { final: 'G1', rules: [] },
}));

const svc = new SharedPoolService();
ok('初始为空', svc.nodes().length === 0);

// 1) 只能加节点，分组/内置拒绝
{
  const d = cfg();
  const ob = d.root.outbounds;
  ok('拒绝分组', svc.addNode({ api: 'a', name: '32' }, ob[0]).ok === false, JSON.stringify(svc.addNode({ api: 'a', name: '32' }, ob[0])));
  ok('拒绝 DIRECT', svc.addNode({ api: 'a', name: '32' }, ob[2]).ok === false);
  const r = svc.addNode({ api: 'a', name: '32' }, ob[1]);
  ok('节点加入成功', r.ok && svc.nodes().length === 1, JSON.stringify(r));
  ok('保留完整字段', JSON.stringify(svc.nodes()[0].node.password) === '"p"' && svc.nodes()[0].node.server_port === 17553);
}

// 2) 同来源同 tag 覆盖不重复
{
  const r = svc.addNode({ api: 'a', name: '32' }, { type: 'shadowsocks', tag: 'LAN-FD-SA', server: 'x', server_port: 1 });
  ok('同来源同 tag 覆盖（不重复）', r.dup === true && svc.nodes().length === 1, JSON.stringify(r));
  ok('内容已更新', svc.nodes()[0].node.server === 'x');
}

// 3) 不同来源同 tag 视为两条
{
  svc.addNode({ api: 'b', name: 'GL' }, { type: 'trojan', tag: 'LAN-FD-SA', server: 'y', server_port: 2 });
  ok('不同来源同 tag 并存', svc.nodes().length === 2, svc.nodes().length);
  ok('按来源分组', svc.bySource().length === 2, JSON.stringify(svc.bySource().map((g) => g.sourceName)));
}

// 4) 导入到文档：tag 冲突自动加来源前缀
{
  const d = cfg();
  const item = svc.nodes().find((n) => n.sourceName === 'GL');
  const tag = svc.importInto(d, item);
  const tags = d.root.outbounds.map((o) => o.tag);
  ok('冲突时加来源前缀', tag === 'GL-LAN-FD-SA' && tags.includes(tag), `tag=${tag}`);
  ok('节点确实写进 outbounds', tags.filter((t) => t === 'GL-LAN-FD-SA').length === 1);
  ok('字段完整带过去', d.root.outbounds.find((o) => o.tag === tag).server === 'y');
  ok('validateDoc 通过', m.validateDoc(d).length === 0, m.validateDoc(d).join('/'));
}

// 5) 不冲突时保留原 tag（目标配置里没有同名 tag）
{
  const fresh = m.parseConfig(JSON.stringify({ outbounds: [{ type: 'direct', tag: 'DIRECT' }], route: {} }));
  const item = svc.nodes().find((n) => n.tag === 'LAN-FD-SA' && n.sourceName === '32');
  const tag = svc.importInto(fresh, item);
  ok('不冲突保留原 tag', tag === 'LAN-FD-SA', `tag=${tag}`);
}

// 6) 导出/导入 JSON 往返
{
  const text = svc.exportJson();
  const svc2 = new SharedPoolService();
  const r = svc2.importJson(text);
  ok('导出可再导入', r.ok && svc2.nodes().length === svc.nodes().length, JSON.stringify(r));
  const bad = svc2.importJson('{"nodes": "x"}');
  ok('坏 JSON 报错不崩', bad.ok === false && !!bad.error, JSON.stringify(bad));
}

// 7) 持久化（同 KEY 再 new 能读回）
{
  const svc3 = new SharedPoolService();
  ok('localStorage 持久化', svc3.nodes().length === svc.nodes().length, `${svc3.nodes().length} vs ${svc.nodes().length}`);
}

// 8) 移除
{
  const id = svc.nodes()[0].id;
  svc.removeNode(id);
  ok('移除一条', svc.nodes().length === 1);
  svc.clear();
  ok('清空', svc.nodes().length === 0);
}

export const results = out;
