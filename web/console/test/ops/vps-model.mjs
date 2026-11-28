// 远程 VPS 部署结果 → 共享节点池 的纯逻辑回归
const m = await import('../../.test-build/vps-model.mjs');
const out = []; const ok = (n, c, x = '') => out.push([n, !!c, x]);

// 1) tag 去冲突：空池原样、冲突加 -2、再冲突 -3
{
  ok('空池原样', m.resolvePoolTag('vps-a', []) === 'vps-a', m.resolvePoolTag('vps-a', []));
  ok('冲突加 -2', m.resolvePoolTag('vps-a', ['vps-a']) === 'vps-a-2', m.resolvePoolTag('vps-a', ['vps-a']));
  ok('再冲突 -3', m.resolvePoolTag('vps-a', ['vps-a', 'vps-a-2']) === 'vps-a-3');
  ok('不相关不干扰', m.resolvePoolTag('vps-a', ['other']) === 'vps-a');
  ok('空描述回落 vps', m.resolvePoolTag('', []) === 'vps', m.resolvePoolTag('', []));
  ok('忽略空白条目', m.resolvePoolTag('x', ['  ', '']) === 'x');
}

// 2) 正常节点：合法 masque-client → 保留全部字段
{
  const node = {
    type: 'masque-client', tag: 'vps-a', server: 'a.example.com', server_port: 443,
    username: 'masque', password: 'pw', version: 3,
    tls: { enabled: true, server_name: 'a.example.com', insecure: true }, mtu: 1280,
  };
  const r = m.buildPoolNode('1.2.3.4', node, []);
  ok('合法节点 ok', r.ok && r.tag === 'vps-a' && !r.renamed, JSON.stringify(r));
  ok('字段完整保留', r.node.password === 'pw' && r.node.tls.insecure === true && r.node.mtu === 1280, JSON.stringify(r.node));
  const src = { ...node };
  r.node.mtu = 900; // 改返回对象不应影响入参
  ok('不修改入参（深拷贝）', src.mtu === 1280, String(src.mtu));
}

// 3) 冲突时改名
{
  const node = { type: 'masque-client', tag: 'dup', server: 's', server_port: 443, username: 'masque', password: 'p', version: 3, tls: {}, mtu: 1280 };
  const r = m.buildPoolNode('h', node, ['dup']);
  ok('冲突改名 dup-2', r.ok && r.tag === 'dup-2' && r.renamed === true, JSON.stringify(r));
  ok('改名后 node.tag 同步', r.node.tag === 'dup-2');
}

// 4) 各种非法输入
{
  const good = { type: 'masque-client', tag: 't', server: 's', server_port: 443, username: 'masque', password: 'p', version: 3, tls: {}, mtu: 1280 };
  const cases = [
    ['缺 host', '', good, '缺少 VPS 主机名'],
    ['无节点', 'h', null, '部署结果里没有节点'],
    ['非 masque-client', 'h', { ...good, type: 'shadowsocks' }, 'masque-client'],
    ['缺 server', 'h', { ...good, server: '' }, 'server'],
    ['缺 tag', 'h', { ...good, tag: '' }, 'tag'],
  ];
  for (const [name, host, node, want] of cases) {
    const r = m.buildPoolNode(host, node, []);
    ok('拒绝：' + name, !r.ok && String(r.reason).includes(want), JSON.stringify(r));
  }
}

export const results = out;
