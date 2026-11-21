# SingBoxManager

双路由 sing-box（甲 `192.168.31.32` / 乙 `172.16.8.1`）的**规则托管与管理系统**：全部域名/IP 分流规则以 23 个远程桶形式放在 NAS，改文件 → 60 秒内两台路由免重启生效；配套内网管理页（状态查看 + 规则编辑发布）。

## 总览

```
                       ┌─ http://192.168.31.8:888/zashboard/  查看与切节点（zashboard v3.30 原版）
局域网（192.168.31.x）─┤
                       └─ http://192.168.31.8:888/edit/       规则编辑 + 一键发布（本仓库 web/edit）

规则链路：浏览器 → 99号机(9099, 编译) → NAS HddShare/WebEdit/rule-set/*.srs → 两台路由每 60s 自动拉取
```

| 组件 | 位置 | 说明 |
|---|---|---|
| 规则桶（23 个 + bard） | `\\192.168.31.8\HddShare\WebEdit\rule-set\` | `.json` 源 + `.srs` 编译产物 + `manifest.json` |
| 发布服务 | 99号机 `~/vault-edit/vault_edit.py`（systemd `vault-edit`，9099） | 校验→编译→写回 NAS；LAN-only + 密钥头 |
| 首页（桶状态页） | `WebEdit/index.html` | 本仓库 `web/index.html` |
| 编辑台 | `WebEdit/edit/index.html` | 本仓库 `web/edit/index.html` |
| 路由配置 | 两台 `/etc/sing-box/config.json` | 35/37 条规则 + 27 个 rule_set 引用；CORS 已开（888 来源） |

## 快速使用

1. 打开 `http://192.168.31.8:888/edit/`，右上角填访问密钥（= 路由 Clash API 密钥，见 docs/runbook.md 的凭据指路）
2. 选桶 → 改 JSON（页面实时校验）→ 「保存并发布」→ 60 秒倒计时后两台路由自动生效
3. 查状态/切节点：`http://192.168.31.8:888/zashboard/`，添加两个后端 `192.168.31.32:9090`、`172.16.8.1:9090`

## 仓库结构

```
web/                 部署到 NAS 的页面（改动后跑 scripts/deploy_web.sh）
service/             99号机发布服务源码（改动后跑 scripts/deploy_service.sh）
scripts/             deploy_web / deploy_service / publish（CLI 发布）/ check（链路体检）
docs/runbook.md      架构、口径、备份清单、坑（先读这个）
HANDOFF.md           交接文档
```

## 开发约定

- 页面**不含任何密钥/真实拓扑信息**（公网可访问 https://router.guaishoudejia.com/ 同目录）；密钥一律用户手填 + localStorage
- `.srs` 是 sing-box 私有二进制格式，只能在有 sing-box 二进制处编译（99 号机）；**改桶必须重编译换内容**，只 touch 不保证重拉
- NAS nginx 有约 1 分钟文件句柄缓存，发布后立即验证可能拿到旧文件
- 规则语义：桶按路由匹配顺序排列；同名序号桶（-2/-3）是原位保序的影子桶，不是冗余——改桶前先看 docs/runbook.md 的桶清单
