const m = await import('../../.test-build/config-ops.mjs');
const fs = await import('node:fs');
const out = []; const ok = (n, c, x = '') => out.push([n, !!c, x]);
const P = (o) => m.parseConfig(JSON.stringify(o));
const isGroup = (t) => t === 'selector' || t === 'urltest';

{
  const d = P({
    outbounds: [
      { type: 'selector', tag: 'openai', outbounds: ['LAN-FD-SA', 'SHAYUQITE'] },
      { type: 'urltest', tag: 'auto', outbounds: ['shayuqite'] },
      { type: 'shadowsocks', tag: 'LAN-FD-SA', server: 'a', server_port: 1, method: 'x', password: 'p' },
      { type: 'trojan', tag: 'SHAYUQITE', server: 'b', server_port: 2, password: 'p' },
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'reject' },
    ],
    endpoints: [{ type: 'masque-client', tag: 'MASQUE-ARM', server: 'c', server_port: 443 }],
    route: { final: 'AUTO', rules: [{ rule_set: 'rs-a', outbound: 'OPENAI' }, { rule_set: 'rs-b', outbound: 'lan-fd-sa' }] },
  });
  m.normalizeOutboundTags(d);
  const t = Object.fromEntries(d.root.outbounds.map(o => [o.type, o.tag]));
  ok('分组 → 大写', t.selector === 'OPENAI' && t.urltest === 'AUTO', JSON.stringify(t));
  ok('节点 → 小写', t.shadowsocks === 'lan-fd-sa' && t.trojan === 'shayuqite', JSON.stringify(t));
  ok('内置 → 大写（既有约定不变）', t.direct === 'DIRECT' && t.block === 'REJECT', JSON.stringify(t));
  ok('端点 → 小写', d.root.endpoints[0].tag === 'masque-arm', d.root.endpoints[0].tag);
  ok('成员引用同步', JSON.stringify(d.root.outbounds[0].outbounds) === '["lan-fd-sa","shayuqite"]', JSON.stringify(d.root.outbounds[0].outbounds));
  ok('规则出口引用同步', d.root.route.rules[1].outbound === 'lan-fd-sa');
  ok('final 引用同步', d.root.route.final === 'AUTO');
  ok('桶 tag 不动', d.root.route.rules[0].rule_set === 'rs-a');
  ok('validateDoc 通过', m.validateDoc(d).length === 0, m.validateDoc(d).join('/'));
  const before = JSON.stringify(d.root); const r2 = m.normalizeOutboundTags(d);
  ok('幂等', JSON.stringify(d.root) === before && !r2.renamed.length && !r2.merged.length, JSON.stringify(r2));
}
{
  const d = P({ outbounds: [{ type: 'selector', tag: '🚀 节点选择', outbounds: [] }], route: {} });
  const r = m.normalizeOutboundTags(d);
  ok('emoji 分组名不变', d.root.outbounds[0].tag === '🚀 节点选择' && !r.renamed.length);
}
{
  const d = P({ outbounds: [
    { type: 'selector', tag: 'G', outbounds: ['hk-01', 'HK-01'] },
    { type: 'shadowsocks', tag: 'HK-01', server: 'a', server_port: 1, method: 'x', password: 'p' },
    { type: 'shadowsocks', tag: 'hk-01', server: 'b', server_port: 2, method: 'x', password: 'p' },
  ], route: {} });
  const r = m.normalizeOutboundTags(d);
  ok('同类型撞名 → 合并', r.merged.length === 1 && d.root.outbounds.filter(o => o.tag === 'hk-01').length === 1, JSON.stringify(r));
  ok('合并后成员去重', JSON.stringify(d.root.outbounds[0].outbounds) === '["hk-01"]', JSON.stringify(d.root.outbounds[0].outbounds));
}
{
  const d = P({ outbounds: [
    { type: 'selector', tag: 'proxy', outbounds: [] },
    { type: 'shadowsocks', tag: 'PROXY', server: 'a', server_port: 1, method: 'x', password: 'p' },
  ], route: {} });
  const r = m.normalizeOutboundTags(d);
  const tags = d.root.outbounds.map(o => o.tag).sort();
  ok('互换场景：分组拿到 PROXY、节点拿到 proxy，都不必改名', tags.length === 2 && tags.includes('PROXY') && tags.includes('proxy'), JSON.stringify(tags));
  ok('互换场景：无残留误报', !r.warnings.some(w => /残留/.test(w)), JSON.stringify(r.warnings));
  // 真正的类型不同撞名（不是互换）：节点 PROXY 不改走时，分组 proxy 才需要改名
  const d2 = P({ outbounds: [
    { type: 'selector', tag: 'proxy', outbounds: [] },
    { type: 'shadowsocks', tag: 'PROXY', server: 'a', server_port: 1, method: 'x', password: 'p' },
    { type: 'shadowsocks', tag: 'proxy-x', server: 'b', server_port: 2, method: 'x', password: 'p' },
  ], route: {} });
  // 让节点 PROXY 想要的名字不是 proxy：把它的类型换成内置（内置→大写，PROXY 不变）
  d2.root.outbounds[1].type = 'direct';
  const r2 = m.normalizeOutboundTags(d2);
  const t2 = d2.root.outbounds.map(o => o.tag).sort();
  ok('真撞名（占用者不改走）→ 分组改名不丢', t2.length === 3 && t2.includes('PROXY') && t2.some(x => /^PROXY_2$/.test(x)), JSON.stringify(t2));
  ok('真撞名有 warning', r2.warnings.some(w => /撞名/.test(w)), JSON.stringify(r2.warnings));
  ok('validateDoc 通过（撞名场景）', m.validateDoc(d).length === 0, m.validateDoc(d).join('/'));
}
for (const [name, path] of [['32', './fixtures/router-32.json'], ['GL', './fixtures/router-172.16.8.1.json']]) {
  if (!fs.existsSync(path)) continue; // 无真机夹具时跳过（见 fixtures/README）
  try {
    const d = m.parseConfig(fs.readFileSync(path, 'utf8'));
    const r = m.normalizeOutboundTags(d);
    const groups = d.root.outbounds.filter(o => isGroup(String(o.type)));
    const nodes = d.root.outbounds.filter(o => !isGroup(String(o.type)) && !['direct', 'block', 'dns'].includes(String(o.type)));
    const eps = d.root.endpoints ?? [];
    ok(`${name}: 分组全大写`, groups.every(o => !/[a-z]/.test(o.tag)), groups.filter(o => /[a-z]/.test(o.tag)).map(o => o.tag).join(','));
    ok(`${name}: 节点全小写`, nodes.every(o => o.tag === o.tag.toLowerCase()), nodes.filter(o => /[A-Z]/.test(o.tag)).map(o => o.tag).join(','));
    ok(`${name}: 端点全小写`, eps.every(o => o.tag === o.tag.toLowerCase()), eps.filter(o => /[A-Z]/.test(o.tag)).map(o => o.tag).join(','));
    ok(`${name}: 零悬空`, m.validateDoc(d).length === 0, m.validateDoc(d).slice(0, 2).join(' / '));
    ok(`${name}: 改名 ${r.renamed.length}、合并 ${r.merged.length}、引用 ${r.refs}`, true);
  } catch (e) { ok(`${name}: 夹具`, false, e.message); }
}

export const results = out;
