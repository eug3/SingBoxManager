const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { SharedPoolService, nodeFingerprint } = await import('../../.test-build/shared-pool.mjs');
const out = []; const ok = (n, c, x = '') => out.push([n, !!c, x]);

const nodeA = { type: 'shadowsocks', tag: 'LAN-FD-SA', server: '192.168.31.99', server_port: 17553, method: 'aes-128-gcm', password: 'p', tls: { enabled: true, server_name: 'a.b' } };
const nodeA2 = { ...JSON.parse(JSON.stringify(nodeA)), tag: 'another-tag' };  // 同配置换 tag
const nodeB = { ...JSON.parse(JSON.stringify(nodeA)), password: 'DIFFERENT' }; // 密码不同
const nodeC = { ...JSON.parse(JSON.stringify(nodeA)), server_port: 1 };

ok('同配置不同 tag 指纹相同', nodeFingerprint(nodeA) === nodeFingerprint(nodeA2));
ok('密码不同指纹不同', nodeFingerprint(nodeA) !== nodeFingerprint(nodeB));
ok('端口不同指纹不同', nodeFingerprint(nodeA) !== nodeFingerprint(nodeC));
ok('outbound/endpoint 同内容也算不同（类型不同）', nodeFingerprint(nodeA, 'outbound') !== nodeFingerprint(nodeA, 'endpoint'));
// 键顺序不影响
const reordered = Object.fromEntries(Object.entries(nodeA).reverse());
ok('键顺序不影响指纹', nodeFingerprint(nodeA) === nodeFingerprint(reordered));

const svc = new SharedPoolService();
svc.addNode({ api: 'a', name: '32' }, nodeA, 'outbound');
const keys = svc.fingerprints();
ok('池里有 → 同配置可命中', keys.has(nodeFingerprint(nodeA2)));
ok('池里没有的配置不命中', !keys.has(nodeFingerprint(nodeB)));
svc.removeNode(svc.nodes()[0].id);
ok('移除后不命中', !svc.fingerprints().has(nodeFingerprint(nodeA)));

export const results = out;
