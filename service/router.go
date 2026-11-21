package main

// router.go — 从 99 通过 SSH 操作两台路由上的 sing-box 配置
//
// 背景：sing-box 没有任何 reload/写配置 API（Clash API 的 PUT /configs 是空实现，
// 1.15 的 services{type:"api"} 是 gRPC 运行时观测，同样不能改配置）。
// 因此「改节点配置 → 生效」只能落到「备份 → sing-box check → 替换 config.json → 重启 → 健康检查（失败回滚）」。
//
// 设计（2026-11-21 调整）：
//   - 全部编排都在 99 本服务里完成：通过 SSH 上传候选配置到路由 /tmp，再在路由上执行内联脚本；
//   - 路由上**不需要预装任何脚本**，只用到 /opt/sing-box/sing-box、/etc/init.d/sing-box、netstat 等既有命令；
//   - 凭据只存在 99 的 /etc/vault-edit/routers.json（0600 root），host 必须命中 ROUTER_HOSTS 白名单；
//   - 所有接口与 /publish 一样要求 X-Vault-Key。

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

const (
	defaultRouterConfig = "/etc/sing-box/config.json"
	defaultRouterBin    = "/opt/sing-box/sing-box"
	defaultRouterInit   = "/etc/init.d/sing-box"
)

type routerCred struct {
	Name     string `json:"name"`
	User     string `json:"user"`
	Password string `json:"password"`
	Port     int    `json:"port"`
}

type routerCredReq struct {
	Host     string `json:"host"`
	User     string `json:"user"`
	Password string `json:"password"`
	Port     int    `json:"port"`
	Name     string `json:"name"`
}

type routerOpReq struct {
	Host      string `json:"host"`
	Config    string `json:"config"`
	ExpectSha string `json:"expectSha"`
}

func routersFile() string {
	return env("ROUTERS_FILE", "/etc/vault-edit/routers.json")
}

// 允许配置凭据的主机白名单（默认两台路由），避免变成任意 SSH 跳板
func routerHosts() map[string]bool {
	out := map[string]bool{}
	for _, h := range strings.Split(env("ROUTER_HOSTS", "192.168.31.32,172.16.8.1"), ",") {
		if h = strings.TrimSpace(h); h != "" {
			out[h] = true
		}
	}
	return out
}

func loadRouters() (map[string]routerCred, error) {
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

// 写 routers.json：原子替换 + 0600
func saveRouters(m map[string]routerCred) error {
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

// ---- SSH 基础 ----

// sshExec 执行一条命令（stdin 可选）。dropbear 偶尔会在连续连接时握手失败，这里做 3 次重试。
func sshExec(host string, cred routerCred, cmd string, stdin []byte, timeout time.Duration) (string, error) {
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		out, err := sshExecOnce(host, cred, cmd, stdin, timeout)
		if err == nil {
			return out, nil
		}
		lastErr = err
		if strings.Contains(err.Error(), "Permission denied") {
			return out, err // 口令错就别重试
		}
		time.Sleep(time.Duration(attempt) * 400 * time.Millisecond)
	}
	return "", lastErr
}

func sshExecOnce(host string, cred routerCred, cmd string, stdin []byte, timeout time.Duration) (string, error) {
	cfg := &ssh.ClientConfig{
		User:            cred.User,
		Auth:            []ssh.AuthMethod{ssh.Password(cred.Password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // 内网设备，无稳定 host key
		Timeout:         8 * time.Second,
	}
	addr := net.JoinHostPort(host, fmt.Sprint(cred.Port))
	client, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return "", fmt.Errorf("ssh 连接 %s 失败: %w", addr, err)
	}
	defer client.Close()

	sess, err := client.NewSession()
	if err != nil {
		return "", fmt.Errorf("ssh session: %w", err)
	}
	defer sess.Close()

	// 注意：x/crypto/ssh 不允许 Stdout/Stderr 共用同一个 writer（会丢输出）
	var outBuf, errBuf bytes.Buffer
	sess.Stdout = &outBuf
	sess.Stderr = &errBuf
	if len(stdin) > 0 {
		sess.Stdin = bytes.NewReader(stdin)
	}

	done := make(chan error, 1)
	go func() { done <- sess.Run(cmd) }()
	select {
	case err = <-done:
	case <-time.After(timeout):
		_ = sess.Signal(ssh.SIGKILL)
		return outBuf.String() + errBuf.String(), fmt.Errorf("超时（%s）", timeout)
	}
	combined := outBuf.String()
	if errBuf.Len() > 0 {
		if combined != "" && !strings.HasSuffix(combined, "\n") {
			combined += "\n"
		}
		combined += errBuf.String()
	}
	return combined, err
}

func routerConfigPath() string { return env("ROUTER_CONFIG", defaultRouterConfig) }
func routerBin() string        { return env("ROUTER_SINGBOX", defaultRouterBin) }
func routerInit() string       { return env("ROUTER_INIT", defaultRouterInit) }

// 健康检查脚本片段：必须换新 pid 且 9090 在监听（只看端口会被旧进程残留 socket 骗过）
func healthSnippet() string {
	return `sbg_pid() { ps w 2>/dev/null | grep '[s]ing-box run' | awk '{print $1}' | head -1; }
health() {
  old="$1"; i=0
  while [ "$i" -lt 60 ]; do
    pid=$(sbg_pid)
    if [ -n "$pid" ] && [ "$pid" != "$old" ] && netstat -lnt 2>/dev/null | grep -q ':9090 '; then return 0; fi
    i=$((i+1)); sleep 1
  done
  return 1
}`
}

// ---- 具体动作（全部由 99 编排） ----

func remoteReadConfig(host string, cred routerCred) (string, error) {
	return sshExec(host, cred, "cat "+routerConfigPath(), nil, 30*time.Second)
}

func remoteConfigSha(host string, cred routerCred) (string, error) {
	out, err := sshExec(host, cred, "sha256sum "+routerConfigPath()+" | cut -d' ' -f1", nil, 20*time.Second)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(strings.SplitN(out, "\n", 2)[0]), nil
}

func remoteUpload(host string, cred routerCred, path string, content []byte) error {
	out, err := sshExec(host, cred, "umask 077; cat > "+path, content, 30*time.Second)
	if err != nil {
		return fmt.Errorf("上传失败: %w %s", err, cleanLine(out))
	}
	return nil
}

func remoteCheckConfig(host string, cred routerCred, content string) (bool, string) {
	tmp := fmt.Sprintf("/tmp/vault-check-%d.json", time.Now().UnixNano())
	if err := remoteUpload(host, cred, tmp, []byte(content)); err != nil {
		return false, err.Error()
	}
	out, err := sshExec(host, cred, routerBin()+" check -c "+tmp+"; rc=$?; rm -f "+tmp+"; exit $rc", nil, 90*time.Second)
	return err == nil, strings.TrimSpace(out)
}

// applyResult 是 apply 的解析结果
type applyResult struct {
	Changed bool   `json:"changed"`
	Log     string `json:"log"`
}

func remoteApplyConfig(host string, cred routerCred, content, expectSha string) (applyResult, error) {
	cur, err := remoteConfigSha(host, cred)
	if err != nil {
		return applyResult{}, fmt.Errorf("读取当前配置失败: %w", err)
	}
	newSum := sha256.Sum256([]byte(content))
	newSha := hex.EncodeToString(newSum[:])
	logLine := fmt.Sprintf("current_sha=%s\ncandidate_sha=%s\n", cur, newSha)

	if expectSha != "" && expectSha != cur {
		return applyResult{}, fmt.Errorf("STALE 配置已被他人修改（expected=%s current=%s），请刷新后重试", expectSha, cur)
	}
	if newSha == cur {
		return applyResult{Changed: false, Log: logLine + "NO_CHANGE"}, nil
	}

	tmp := fmt.Sprintf("/tmp/vault-apply-%d.json", time.Now().UnixNano())
	if err := remoteUpload(host, cred, tmp, []byte(content)); err != nil {
		return applyResult{}, err
	}

	cfg := routerConfigPath()
	script := healthSnippet() + `
set -u
TMP="` + tmp + `"
CFG="` + cfg + `"
SB="` + routerBin() + `"
INIT="` + routerInit() + `"
TS=$(date +%Y%m%d-%H%M%S)

if ! OUT=$("$SB" check -c "$TMP" 2>&1); then
  echo "CHECK_FAILED"; echo "$OUT"; rm -f "$TMP"; exit 13
fi
BAK="$CFG.bak-$TS-before-apply"
cp -p "$CFG" "$BAK" || { echo "BACKUP_FAILED"; rm -f "$TMP"; exit 14; }
cp -p "$TMP" "$CFG.tmp" && chmod 644 "$CFG.tmp" && mv "$CFG.tmp" "$CFG" || { echo "INSTALL_FAILED"; rm -f "$TMP"; exit 15; }
rm -f "$TMP"
echo "BACKUP=$BAK"

OLD=$(sbg_pid)
T0=$(date +%s)
"$INIT" restart >/dev/null 2>&1
if health "$OLD"; then
  echo "APPLIED"
  echo "sha=` + newShaPlaceholder() + `"
  echo "downtime_s=$(( $(date +%s) - T0 ))"
  exit 0
fi
echo "UNHEALTHY_ROLLBACK"
cp -p "$BAK" "$CFG"
OLD=$(sbg_pid)
"$INIT" restart >/dev/null 2>&1
if health "$OLD"; then echo "ROLLBACK_OK"; else echo "ROLLBACK_FAILED"; fi
exit 16
`
	// 用候选内容的 sha 回填脚本里的占位符（避免把整份配置塞进脚本）
	script = strings.ReplaceAll(script, newShaPlaceholder(), newSha)

	out, err := sshExec(host, cred, "sh -s", []byte(script), 180*time.Second)
	full := logLine + out
	switch {
	case strings.Contains(out, "CHECK_FAILED"):
		return applyResult{}, fmt.Errorf("sing-box check 未通过：%s", cleanLine(out))
	case strings.Contains(out, "ROLLBACK_OK"):
		return applyResult{}, fmt.Errorf("新配置重启后不健康，已自动回滚：%s", cleanLine(out))
	case strings.Contains(out, "APPLIED"):
		return applyResult{Changed: true, Log: full}, nil
	case err != nil:
		return applyResult{}, fmt.Errorf("应用失败：%v %s", err, cleanLine(full))
	default:
		return applyResult{}, fmt.Errorf("应用失败：%s", cleanLine(full))
	}
}

func newShaPlaceholder() string { return "__CANDIDATE_SHA__" }

func remoteRestart(host string, cred routerCred) (string, error) {
	script := healthSnippet() + `
set -u
INIT="` + routerInit() + `"
OLD=$(sbg_pid)
T0=$(date +%s)
"$INIT" restart >/dev/null 2>&1
if health "$OLD"; then
  echo "RESTARTED"
  echo "downtime_s=$(( $(date +%s) - T0 ))"
  exit 0
fi
echo "RESTART_UNHEALTHY"
exit 17
`
	out, err := sshExec(host, cred, "sh -s", []byte(script), 120*time.Second)
	if err != nil || !strings.Contains(out, "RESTARTED") {
		return out, fmt.Errorf("重启失败: %s", cleanLine(out))
	}
	return out, nil
}

func cleanLine(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	lines := strings.Split(strings.TrimSpace(s), "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
		if len(out) >= 6 {
			break
		}
	}
	return strings.Join(out, " | ")
}

// ---- HTTP handlers ----

func routerKeyFrom(r *http.Request) string {
	if k := strings.TrimSpace(r.Header.Get("X-Vault-Key")); k != "" {
		return k
	}
	return strings.TrimSpace(r.Header.Get("X-Router-Key"))
}

// routerKeyValid：密钥要么是 99 的 VAULT_KEY，要么能被路由 clash_api 接受
// （"能访问 clash_api 就是有密钥" —— 这样页面只需要用户本来就要填的 clash 密钥）
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
	client := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequest(http.MethodGet, "http://"+net.JoinHostPort(host, port)+"/version", nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// routerAuth 处理 CORS/OPTIONS 与密钥校验；host 为空表示"任意已配置路由接受即可"
func routerAuth(w http.ResponseWriter, r *http.Request, host string) bool {
	setCors(w.Header(), r.Header.Get("Origin"))
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	key := routerKeyFrom(r)
	if routerKeyValid(host, key) {
		return true
	}
	if host == "" {
		// 没有具体 host 时：只要任一已配置路由接受该密钥即可
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

// GET /router/config?host=
func handleRouterConfig(w http.ResponseWriter, r *http.Request) {
	setCors(w.Header(), r.Header.Get("Origin"))
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
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

// POST /router/restart {"host"}
func handleRouterRestart(w http.ResponseWriter, r *http.Request) {
	setCors(w.Header(), r.Header.Get("Origin"))
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var req routerOpReq
	_ = json.NewDecoder(r.Body).Decode(&req)
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

// POST /router/check {"host","config"}
func handleRouterCheck(w http.ResponseWriter, r *http.Request) {
	setCors(w.Header(), r.Header.Get("Origin"))
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
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

// POST /router/apply {"host","config","expectSha"}
func handleRouterApply(w http.ResponseWriter, r *http.Request) {
	setCors(w.Header(), r.Header.Get("Origin"))
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
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

// ---- 凭据管理 ----

// GET /router/credentials —— 只返回 host/user/port，绝不回显口令
func handleRouterCredentialsList(w http.ResponseWriter, r *http.Request) {
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

// POST /router/credentials {host,user,password,port?,name?}
func handleRouterCredentialsSet(w http.ResponseWriter, r *http.Request) {
	setCors(w.Header(), r.Header.Get("Origin"))
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
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

// DELETE /router/credentials?host=
func handleRouterCredentialsDelete(w http.ResponseWriter, r *http.Request) {
	setCors(w.Header(), r.Header.Get("Origin"))
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
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
	if err := saveRouters(all); err != nil {
		fail(w, 500, "写凭据失败: "+err.Error())
		return
	}
	log.Printf("router credentials removed for %s", host)
	writeJSON(w, 200, map[string]any{"ok": true, "host": host})
}

func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
