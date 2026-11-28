// TUN 入站 route_exclude_address 的纯函数回归（配置页「TUN 私网排除」面板的底层）
const m = await import('../../.test-build/config-ops.mjs');
const out = []; const ok = (n, c, x = '') => out.push([n, !!c, x]);
const P = (o) => m.parseConfig(JSON.stringify(o));

// 一台典型路由：tun + mixed + direct(dns-in)
const mkDoc = (excl) => P({
  inbounds: [
    { type: 'tun', tag: 'tun-in', auto_route: true, ...(excl && excl.length ? { route_exclude_address: excl } : {}) },
    { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 7890 },
    { type: 'direct', tag: 'dns-in', listen: '127.0.0.1', listen_port: 5335 },
  ],
  outbounds: [{ type: 'direct', tag: 'DIRECT' }],
});

// 1) 只认 type=tun；能读回
{
  const d = mkDoc(['10.0.0.0/8']);
  const t = m.tunInbounds(d);
  ok('tunInbounds 只取 type=tun', t.length === 1 && t[0].tag === 'tun-in', JSON.stringify(t.map((x) => x.tag)));
  ok('tunExcludeAddresses 读回', JSON.stringify(m.tunExcludeAddresses(d)) === '["10.0.0.0/8"]', JSON.stringify(m.tunExcludeAddresses(d)));
}

// 2) 写入按规范序排列：v4 数值序 + v6 在后（与线上两台实际顺序一致）
{
  const d = mkDoc([]);
  const r = m.applyTunExcludes(d, ['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '2603:c024:c003:5866:0:8dce:6c18:1226/128']);
  const got = d.root.inbounds[0].route_exclude_address;
  ok('写入 ok 且 tun=1', r.ok && r.tun === 1, JSON.stringify(r));
  ok('顺序为 v4 数值序 + v6 在后', JSON.stringify(got) === JSON.stringify([
    '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
    '172.16.0.0/12', '192.168.0.0/16', '2603:c024:c003:5866:0:8dce:6c18:1226/128',
  ]), JSON.stringify(got));
  ok('before 记录原值（空）', JSON.stringify(r.before) === '[]', JSON.stringify(r.before));
}

// 3) 去重 + 大小写归一 + 空白容忍
{
  const d = mkDoc([]);
  m.applyTunExcludes(d, ['  10.0.0.0/8 ', '10.0.0.0/8', 'FC00::/7', 'fc00::/7', '']);
  const got = d.root.inbounds[0].route_exclude_address;
  ok('去重/去空白/小写', JSON.stringify(got) === JSON.stringify(['10.0.0.0/8', 'fc00::/7']), JSON.stringify(got));
}

// 4) 非法值：不写文档，列出坏值
{
  const d = mkDoc([]);
  const r = m.applyTunExcludes(d, ['10.0.0.0/8', '999.1.1.1/8', 'abc', '10.0.0.0/33']);
  ok('非法值被拒（ok=false / reason=invalid）', !r.ok && r.reason === 'invalid', JSON.stringify(r));
  ok('非法值时文档未被改动', d.root.inbounds[0].route_exclude_address === undefined, JSON.stringify(d.root.inbounds[0]));
  ok('invalid 列出全部坏值（保持输入顺序）', JSON.stringify(r.invalid) === JSON.stringify(['999.1.1.1/8', 'abc', '10.0.0.0/33']), JSON.stringify(r.invalid));
}

// 5) 空列表 = 删掉该字段（不排除任何地址）
{
  const d = mkDoc(['10.0.0.0/8']);
  const r = m.applyTunExcludes(d, []);
  ok('空列表 ok', r.ok, JSON.stringify(r));
  ok('空列表删字段', !('route_exclude_address' in d.root.inbounds[0]), JSON.stringify(d.root.inbounds[0]));
}

// 6) 没有 TUN 入站 → 明确报 no-tun，不静默成功
{
  const d = P({ inbounds: [{ type: 'mixed', tag: 'm' }], outbounds: [] });
  const r = m.applyTunExcludes(d, ['10.0.0.0/8']);
  ok('无 TUN 时报 no-tun', !r.ok && r.reason === 'no-tun', JSON.stringify(r));
}

// 7) 多个 TUN 入站：全部写
{
  const d = P({ inbounds: [{ type: 'tun', tag: 'tun-a' }, { type: 'tun', tag: 'tun-b' }], outbounds: [] });
  const r = m.applyTunExcludes(d, ['10.0.0.0/8']);
  ok('多个 tun 全部写入', r.ok && r.tun === 2 &&
    JSON.stringify(d.root.inbounds[0].route_exclude_address) === '["10.0.0.0/8"]' &&
    JSON.stringify(d.root.inbounds[1].route_exclude_address) === '["10.0.0.0/8"]', JSON.stringify(r));
}

// 8) 校验函数 12 例
{
  const cases = [
    ['10.0.0.0/8', true], ['192.168.1.1', true], ['2603:c024::1/128', true], ['::1', true],
    ['fe80::/10', true], ['256.1.1.1', false], ['10.0.0.0/33', false], ['', false],
    ['10.0.0.0/8/9', false], ['fe80::/129', false], ['1.2.3', false], ['gggg::1', false],
  ];
  const bad = cases.filter(([s, want]) => m.isValidAddressPrefix(s) !== want);
  ok('isValidAddressPrefix 12 例符合预期', bad.length === 0, JSON.stringify(bad));
}

// 9) v6 :: 展开后排序正确（2603 < fc00 < fe80 < ::1）
{
  const d = mkDoc([]);
  m.applyTunExcludes(d, ['fe80::/10', '2603:c024::1/128', 'fc00::/7', '::1/128']);
  const got = d.root.inbounds[0].route_exclude_address;
  ok('v6 数值序（::1 = 1 最小，故排最前）', JSON.stringify(got) === JSON.stringify(['::1/128', '2603:c024::1/128', 'fc00::/7', 'fe80::/10']), JSON.stringify(got));
}

// 10) 预设清单都合法
{
  ok('预设至少 6 条', m.TUN_EXCLUDE_PRESETS.length >= 6, String(m.TUN_EXCLUDE_PRESETS.length));
  const bad = m.TUN_EXCLUDE_PRESETS.filter((p) => !m.isValidAddressPrefix(p.cidr));
  ok('预设每条都合法', bad.length === 0, JSON.stringify(bad));
}

export const results = out;
