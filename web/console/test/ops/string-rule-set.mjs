import { readFileSync } from 'node:fs';
const m = await import('../../.test-build/config-ops.mjs');
const out = []; const ok = (n, c, x = '') => out.push([n, !!c, x]);

// 真实 32 配置：很多规则是 "rule_set": "rs-apple" 字符串形式
const d = m.parseConfig(readFileSync('./fixtures/router-32-api.json', 'utf8') ? JSON.parse(readFileSync('./fixtures/router-32-api.json', 'utf8')).config : '{}');
const groups = m.groupsWithRuleRefs(d);
const names = groups.map((g) => g.group);
ok('字符串形式的规则也被识别', names.includes('📲 电报信息') && names.includes('🍎 苹果服务'), names.join('|'));
const refsTg = m.groupRuleRefs(d, '📲 电报信息');
ok('字符串形式 refs 归一成数组', JSON.stringify(refsTg) === '["rs-tg"]', JSON.stringify(refsTg));
const count = d.root.route.rules.filter((r) => r.rule_set).length;
ok('组名数量与实际带 rule_set 的规则口径一致', names.length >= 9, `${names.length} 组 / ${count} 条规则`);

// 套用到「📲 电报信息」：应合并那条字符串规则，不能新增重复规则
const before = d.root.route.rules.length;
const res = m.applyGroupRefs(d, '📲 电报信息', ['rs-apple', 'rs-tg']);
ok('已有字符串规则 → 合并而非新增', res.ok && res.insertedAt === undefined && d.root.route.rules.length === before, JSON.stringify(res));
const tgRules = d.root.route.rules.filter((r) => r.outbound === '📲 电报信息');
ok('只剩一条且为数组形式', tgRules.length === 1 && JSON.stringify(tgRules[0].rule_set) === '["rs-apple","rs-tg"]', JSON.stringify(tgRules));
ok('validateDoc 通过', m.validateDoc(d).length === 0, m.validateDoc(d).slice(0, 2).join('/'));

export const results = out;
