package main

// router_store.go — 路由 SSH 凭据的存储与管理接口。
//
// 凭据只落在 99 的 /etc/vault-edit/routers.json（0600 root，原子替换），
// 浏览器提交一次后即清空，任何接口都不回显口令。
// host 必须命中 ROUTER_HOSTS 白名单（默认两台路由），避免本服务变成任意 SSH 跳板。

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// routerCred 一台路由的 SSH 凭据（routers.json 的值）
type routerCred struct {
	Name     string `json:"name"`
	User     string `json:"user"`
	Password string `json:"password"`
	Port     int    `json:"port"`
}

// routerCredReq POST /router/credentials 请求体
type routerCredReq struct {
	Host     string `json:"host"`
	User     string `json:"user"`
	Password string `json:"password"`
	Port     int    `json:"port"`
	Name     string `json:"name"`
}

// routersFile 凭据文件路径（可用 ROUTERS_FILE 覆盖）
func routersFile() string {
	return env("ROUTERS_FILE", "/etc/vault-edit/routers.json")
}

// routerHosts 允许配置凭据的主机白名单（ROUTER_HOSTS，逗号分隔）
func routerHosts() map[string]bool {
	out := map[string]bool{}
	for _, h := range strings.Split(env("ROUTER_HOSTS", "192.168.31.32,172.16.8.1"), ",") {
		if h = strings.TrimSpace(h); h != "" {
			out[h] = true
		}
	}
	return out
}

// loadRouters 读凭据表（SQLite 为准）；user/port 缺省补 root/22
func loadRouters() (map[string]routerCred, error) {
	m, err := routersFromDB()
	if err != nil {
		return nil, err
	}
	if len(m) == 0 {
		return nil, fmt.Errorf("凭据库为空（可先在页面「路由凭据」里填写）")
	}
	return m, nil
}

// loadRoutersFile 读旧的 routers.json（仅首次迁移用）
func loadRoutersFile() (map[string]routerCred, error) {
	b, err := os.ReadFile(routersFile())
	if err != nil {
		return nil, err
	}
	var m map[string]routerCred
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("routers.json 解析失败: %w", err)
	}
	for host, c := range m {
		if c.User == "" {
			c.User = "root"
		}
		if c.Port == 0 {
			c.Port = 22
		}
		m[host] = c
	}
	return m, nil
}

// saveRouters 写凭据表（SQLite）
func saveRouters(m map[string]routerCred) error {
	return routersToDB(m)
}

// saveRoutersLegacyFile 旧实现（保留给需要导出 JSON 的场景，当前未用）
func saveRoutersLegacyFile(m map[string]routerCred) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	dir := filepath.Dir(routersFile())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := routersFile() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, routersFile())
}

// pickRouter 取一台路由的凭据；host 允许带端口（取主机名部分）。
// 错误文案里的「未配置路由凭据」是前端连接门禁的触发关键字，勿随意改动。
func pickRouter(host string) (routerCred, string, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return routerCred{}, "", errors.New("缺少 host")
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	all, err := loadRouters()
	if err != nil {
		return routerCred{}, "", fmt.Errorf("未配置路由凭据（host %s）：99 上没有 %s；可在页面「路由凭据」里填写", host, routersFile())
	}
	c, ok := all[host]
	if !ok {
		return routerCred{}, "", fmt.Errorf("未配置路由凭据（host %s）：可在页面「路由凭据」里填写", host)
	}
	return c, host, nil
}

// ---- 凭据管理接口 ----

// handleRouterCredentialsList GET /router/credentials
// 只返回 host/user/port 与白名单，绝不回显口令。
func handleRouterCredentialsList(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !routerAuth(w, r, "") {
		return
	}
	all, _ := loadRouters()
	list := make([]map[string]any, 0, len(all))
	for host, c := range all {
		list = append(list, map[string]any{
			"host": host, "name": c.Name, "user": c.User, "port": c.Port, "configured": c.Password != "",
		})
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "hosts": list, "allow": keysOf(routerHosts()), "file": routersFile(),
		"config": routerConfigPath(), "bin": routerBin(), "init": routerInit(),
	})
}

// handleRouterCredentialsSet POST /router/credentials {host,user,password,port?,name?}
func handleRouterCredentialsSet(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	var req routerCredReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, "bad body")
		return
	}
	req.Host = strings.TrimSpace(req.Host)
	if req.Host == "" || !routerHosts()[req.Host] {
		fail(w, 400, fmt.Sprintf("host %q 不在允许列表（ROUTER_HOSTS）", req.Host))
		return
	}
	if !routerAuth(w, r, req.Host) {
		return
	}
	if strings.TrimSpace(req.User) == "" || req.Password == "" {
		fail(w, 400, "用户名与口令都不能为空")
		return
	}
	all, _ := loadRouters()
	if all == nil {
		all = map[string]routerCred{}
	}
	if req.Port == 0 {
		req.Port = 22
	}
	name := req.Name
	if name == "" {
		name = req.Host
	}
	all[req.Host] = routerCred{Name: name, User: strings.TrimSpace(req.User), Password: req.Password, Port: req.Port}
	if err := saveRouters(all); err != nil {
		fail(w, 500, "写凭据失败: "+err.Error())
		return
	}
	log.Printf("router credentials updated for %s (user=%s)", req.Host, req.User)
	writeJSON(w, 200, map[string]any{"ok": true, "host": req.Host, "user": req.User})
}

// handleRouterCredentialsDelete DELETE /router/credentials?host=
func handleRouterCredentialsDelete(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	host := strings.TrimSpace(r.URL.Query().Get("host"))
	if !routerAuth(w, r, host) {
		return
	}
	all, err := loadRouters()
	if err != nil {
		fail(w, 404, "没有已配置的凭据文件")
		return
	}
	if _, ok := all[host]; !ok {
		fail(w, 404, "该 host 没有配置")
		return
	}
	delete(all, host)
	if err := routerDeleteDB(host); err != nil {
		fail(w, 500, "写凭据失败: "+err.Error())
		return
	}
	log.Printf("router credentials removed for %s", host)
	writeJSON(w, 200, map[string]any{"ok": true, "host": host})
}

// keysOf 取 map 的键集合（白名单列表输出用）
func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
