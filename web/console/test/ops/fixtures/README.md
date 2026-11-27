# 真机夹具（不入库）

`cond-merge` 与 `string-rule-set` 两个用例需要真机配置做夹具。仓库里不放（含节点密钥），
在本机按下面名字放两份就能跑：

```
test/ops/fixtures/router-32.json              # 192.168.31.32 的 config.json（路由原文）
test/ops/fixtures/router-172.16.8.1.json      # 172.16.8.1 的 config.json
test/ops/fixtures/router-32-api.json          # /router/config 的应答（{"config": "...json 字符串..."}）
```

取法：

```bash
sshpass -p '<口令>' ssh root@192.168.31.32 'cat /etc/sing-box/config.json' > test/ops/fixtures/router-32.json
curl -s -H "X-Vault-Key: <key>" 'http://192.168.31.99:9099/router/config?host=192.168.31.32' \
  > test/ops/fixtures/router-32-api.json
```

缺夹具时 runner 会 `SKIP` 这两组用例，其余照常跑。
