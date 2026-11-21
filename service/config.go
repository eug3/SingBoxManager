package main

// config.go — 服务配置：全部来自环境变量（systemd 从 /etc/vault-edit.env 注入），
// 源码与二进制里不落任何密钥。

import (
	"os"
	"regexp"
)

// env 读环境变量，空值时回退默认值
func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

var (
	listen = env("LISTEN", ":9099") // 监听地址（只应绑内网）
	// SHARE_DIR 仅在 SHARE_MODE=local 时使用（等价于旧的 cifs 挂载路径）；
	// 默认 SHARE_MODE=smb，直接走纯 Go SMB2 客户端，不需要任何挂载。
	shareDir  = env("SHARE_DIR", "/mnt/hdd/WebEdit/rule-set")
	pageDir   = env("PAGE_DIR", "/usr/local/share/vault-edit/edit")     // Angular 管理台产物目录
	staticDir = env("STATIC_DIR", "/usr/local/share/vault-edit/static") // Monaco 等静态资源目录
	singBox   = env("SINGBOX", "/usr/local/bin/sing-box")               // 99 本机的 sing-box（编译 rule-set 用）
	vaultKey  = os.Getenv("VAULT_KEY")                                  // /publish 鉴权密钥（必填）

	// 管理台页面允许的来源（与前端 models.ts 的 PAGE_ORIGINS、路由 clash_api CORS 白名单一致）
	allowOrigins = []string{
		"http://192.168.31.99:9099", // LAN 入口
		"http://10.1.1.99:9099",     // EasyTier 入口
	}

	// 桶名白名单：rs-xxx 或 bard-domains（防止任意路径写入 NAS）
	bucketRe = regexp.MustCompile(`^(rs-[a-z0-9-]+|bard-domains)$`)
	rsFileRe = regexp.MustCompile(`^(rs-[a-z0-9-]+|bard-domains)\.(json|srs)$`)

	// /publish 只接受纯规则桶（这四类键）；完整 route 规则请走「配置」tab 改 config.json
	ruleKeys = map[string]bool{"domain": true, "domain_suffix": true, "domain_keyword": true, "ip_cidr": true}
)
