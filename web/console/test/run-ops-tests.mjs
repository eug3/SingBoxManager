// 控制台纯函数回归：先把 config-ops / shared-pool.service 打成 ESM，再逐个跑 test/ops/*.mjs
// 用法：node test/run-ops-tests.mjs   （或 npm run test:ops）
import { build } from 'esbuild';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '.test-build');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const [entry, name] of [
  ['src/app/config-ops.ts', 'config-ops'],
  ['src/app/shared-pool.service.ts', 'shared-pool'],
]) {
  await build({
    entryPoints: [join(here, '..', entry)],
    bundle: true,
    format: 'esm',
    outfile: join(out, `${name}.mjs`),
    logLevel: 'error',
  });
}

// 需要真机夹具的用例：没夹具就跳过（夹具里有节点密钥，不入库，见 test/ops/fixtures/README.md）
const fixturesOk = existsSync(join(here, 'ops', 'fixtures', 'router-32.json'));
const needsFixture = new Set(['cond-merge', 'string-rule-set']);
const files = ['fingerprint', 'pool-nodes', 'pool-rules', 'pool-override', 'rule-applied', 'group-apply', 'cond-merge', 'string-rule-set'];

// 用例里的相对路径（./fixtures/...）按 test/ops 解析
process.chdir(join(here, 'ops'));

let total = 0;
let failed = 0;
for (const f of files) {
  if (needsFixture.has(f) && !fixturesOk) {
    console.log(`SKIP  ${f}（缺 test/ops/fixtures/router-32.json 真机夹具）`);
    continue;
  }
  const mod = await import(join(here, 'ops', `${f}.mjs`));
  const rows = (mod.default ?? mod.results ?? []);
  const pass = rows.filter((r) => r[1]).length;
  total += rows.length;
  failed += rows.length - pass;
  console.log(`${rows.length === pass ? 'PASS ' : 'FAIL '} ${f}: ${pass}/${rows.length}`);
  for (const [name, ok, extra] of rows) {
    if (!ok) console.log(`   ✗ ${name}${extra ? ' ← ' + extra : ''}`);
  }
}

console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}（${total} 断言）`);
process.exit(failed === 0 ? 0 : 1);
