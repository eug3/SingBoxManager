package main

// router_http.go — /router/* 的 HTTP 层：鉴权 + 四个配置操作接口。
//
// 鉴权口径（用户裁定「能访问 clash_api 就是有密钥」）：
//   /router/* 接受两种密钥之一 —— 99 的 VAULT_KEY，或目标路由 clash_api 认可的 secret
//   （拿它请求路由 /version，200 即通过）。/publish 仍只认 VAULT_KEY。
//
// 注意 handler 顺序：先 pickRouter 再鉴权 —— 「未配置路由凭据」的 400 文案
// 是前端连接门禁的触发条件之一，保持这个先后关系。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"time"
)

// routerOpReq 配置操作请求体（restart 只用 host；check/apply 用 config；apply 可带 expectSha）
type routerOpReq struct {
	Host      string `json:"host"`
	Config    string `json:"config"`
	ExpectSha string `json:"expectSha"`
}

// routerKeyFrom 取请求密钥（X-Vault-Key 优先，兼容 X-Router-Key）
func routerKeyFrom(r *http.Request) string {
	if k := strings.TrimSpace(r.Header.Get("X-Vault-Key")); k != "" {
		return k
	}
	return strings.TrimSpace(r.Header.Get("X-Router-Key"))
}

// clashProbeClient 校验 clash 密钥用的 HTTP 客户端（复用连接，5s 超时）
var clashProbeClient = &http.Client{Timeout: 5 * time.Second}

// routerKeyValid 密钥要么是 99 的 VAULT_KEY，要么能被指定路由的 clash_api 接受
func routerKeyValid(host, key string) bool {
	if key == "" {
		return false
	}
	if key == vaultKey {
		return true
	}
	if host == "" {
		return false
	}
	port := env("ROUTER_CLASH_PORT", "9090")
	req, err := http.NewRequest(http.MethodGet, "http://"+net.JoinHostPort(host, port)+"/version", nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := clashProbeClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// routerAuth 只做密钥校验（CORS/OPTIONS 由 preflight 处理）。
// host 为空表示「任一已配置路由接受该密钥即可」（凭据列表这类不针对单台路由的接口）。
func routerAuth(w http.ResponseWriter, r *http.Request, host string) bool {
	key := routerKeyFrom(r)
	if routerKeyValid(host, key) {
		return true
	}
	if host == "" {
		if all, err := loadRouters(); err == nil {
			for h := range all {
				if routerKeyValid(h, key) {
					return true
				}
			}
		}
	}
	fail(w, 401, "密钥不正确（既不是 99 的 VAULT_KEY，也不被路由 clash_api 接受）")
	return false
}

// handleRouterConfig GET /router/config?host= —— 读整份 config.json（含 sha256，供乐观锁）
func handleRouterConfig(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	cred, host, err := pickRouter(r.URL.Query().Get("host"))
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if !routerAuth(w, r, host) {
		return
	}
	t0 := time.Now()
	out, err := remoteReadConfig(host, cred)
	if err != nil {
		fail(w, 502, "读取失败: "+err.Error()+" "+cleanLine(out))
		return
	}
	sum := sha256.Sum256([]byte(out))
	writeJSON(w, 200, map[string]any{
		"ok": true, "host": host, "name": cred.Name,
		"config": out, "size": len(out),
		"sha256": hex.EncodeToString(sum[:]),
		"ms":     time.Since(t0).Milliseconds(),
	})
}

// handleRouterRestart POST /router/restart {"host"} —— 仅重启（断流约 1–2s）
func handleRouterRestart(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	var req routerOpReq
	_ = json.NewDecoder(r.Body).Decode(&req) // body 缺 host 时由 pickRouter 给出明确错误
	cred, host, err := pickRouter(req.Host)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if !routerAuth(w, r, host) {
		return
	}
	t0 := time.Now()
	out, err := remoteRestart(host, cred)
	if err != nil {
		log.Printf("router restart %s failed: %v", host, err)
		fail(w, 502, err.Error())
		return
	}
	log.Printf("router restart %s ok (%dms) %s", host, time.Since(t0).Milliseconds(), cleanLine(out))
	writeJSON(w, 200, map[string]any{"ok": true, "host": host, "log": out, "ms": time.Since(t0).Milliseconds()})
}

// handleRouterCheck POST /router/check {"host","config"} —— 路由上跑 sing-box check（不落盘）
func handleRouterCheck(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	var req routerOpReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, "bad body")
		return
	}
	cred, host, err := pickRouter(req.Host)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if !routerAuth(w, r, host) {
		return
	}
	if strings.TrimSpace(req.Config) == "" {
		fail(w, 400, "config 为空")
		return
	}
	ok, out := remoteCheckConfig(host, cred, req.Config)
	writeJSON(w, 200, map[string]any{"ok": ok, "host": host, "output": cleanLine(out)})
}

// handleRouterApply POST /router/apply {"host","config","expectSha"}
// 错误码约定：409=STALE（他人已改）；422=check 未通过；502=SSH/重启/回滚类失败。
func handleRouterApply(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	var req routerOpReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, "bad body")
		return
	}
	if strings.TrimSpace(req.Config) == "" {
		fail(w, 400, "config 为空")
		return
	}
	cred, host, err := pickRouter(req.Host)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	if !routerAuth(w, r, host) {
		return
	}
	t0 := time.Now()
	res, err := remoteApplyConfig(host, cred, req.Config, req.ExpectSha)
	if err != nil {
		msg := err.Error()
		code := 502
		switch {
		case strings.Contains(msg, "STALE"):
			code = 409
		case strings.Contains(msg, "check 未通过"):
			code = 422
		}
		log.Printf("router apply %s failed (%d): %s", host, code, msg)
		fail(w, code, msg)
		return
	}
	log.Printf("router apply %s changed=%v (%dms) %s", host, res.Changed, time.Since(t0).Milliseconds(), cleanLine(res.Log))
	writeJSON(w, 200, map[string]any{
		"ok": true, "changed": res.Changed, "host": host, "log": res.Log,
		"ms": time.Since(t0).Milliseconds(),
	})
}
