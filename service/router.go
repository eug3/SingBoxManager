package main

// router.go — 通过受限 SSH 操作两台路由上的 sing-box
//
// 背景：sing-box 没有任何 reload/写配置 API（Clash API 的 PUT /configs 是空实现，
// 1.15 的 services{type:"api"} 是 gRPC 运行时观测，同样不能改配置）。
// 因此「改节点配置 → 生效」只能落到「备份 → sing-box check → 替换 config.json → 重启 → 健康检查（失败回滚）」。
//
// 安全模型：
//   - 凭据只存在 99 的 /etc/vault-edit/routers.json（0600，root），不在源码/页面/日志出现；
//   - 只允许操作 routers.json 白名单内的 host；
//   - 所有危险动作都在路由器本地的 /usr/local/sbin/singbox-apply 内完成，本服务只会执行这一个脚本；
//   - 接口与 /publish 同样要求 X-Vault-Key。

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
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

const routerApplyPath = "/usr/local/sbin/singbox-apply"

type routerCred struct {
	Name     string `json:"name"`
	User     string `json:"user"`
	Password string `json:"password"`
	Port     int    `json:"port"`
}

type routerOpReq struct {
	Host      string `json:"host"`
	Config    string `json:"config"`
	ExpectSha string `json:"expectSha"`
}

func routersFile() string {
	return env("ROUTERS_FILE", "/etc/vault-edit/routers.json")
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
		return routerCred{}, "", fmt.Errorf("未配置路由凭据（%s）：%w", routersFile(), err)
	}
	c, ok := all[host]
	if !ok {
		return routerCred{}, "", fmt.Errorf("host %s 不在白名单", host)
	}
	return c, host, nil
}

// sshRun 在路由器上执行 singbox-apply，返回合并输出。
func sshRun(host string, cred routerCred, mode string, stdin []byte, timeout time.Duration) (string, error) {
	cfg := &ssh.ClientConfig{
		User:            cred.User,
		Auth:            []ssh.AuthMethod{ssh.Password(cred.Password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // 内网设备，无稳定 host key
		Timeout:         10 * time.Second,
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

	// 注意：x/crypto/ssh 不允许 Stdout/Stderr 共用同一个 writer（会丢输出），必须分开
	var outBuf, errBuf bytes.Buffer
	sess.Stdout = &outBuf
	sess.Stderr = &errBuf
	if len(stdin) > 0 {
		sess.Stdin = bytes.NewReader(stdin)
	}

	cmd := routerApplyPath + " " + mode
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

func routerAuthorized(w http.ResponseWriter, r *http.Request) bool {
	setCors(w.Header(), r.Header.Get("Origin"))
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	if r.Header.Get("X-Vault-Key") != vaultKey {
		fail(w, 401, "bad key")
		return false
	}
	return true
}

// GET /router/config?host=192.168.31.32
func handleRouterConfig(w http.ResponseWriter, r *http.Request) {
	if !routerAuthorized(w, r) {
		return
	}
	cred, host, err := pickRouter(r.URL.Query().Get("host"))
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	t0 := time.Now()
	out, err := sshRun(host, cred, "show", nil, 30*time.Second)
	if err != nil {
		fail(w, 502, "读取失败: "+err.Error()+" "+truncStr(out, 300))
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

// POST /router/restart {"host": "..."}
func handleRouterRestart(w http.ResponseWriter, r *http.Request) {
	if !routerAuthorized(w, r) {
		return
	}
	var req routerOpReq
	_ = json.NewDecoder(r.Body).Decode(&req)
	cred, host, err := pickRouter(req.Host)
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	t0 := time.Now()
	out, err := sshRun(host, cred, "restart", nil, 120*time.Second)
	ok := strings.Contains(out, "RESTARTED")
	if err != nil || !ok {
		log.Printf("router restart %s failed: %v %s", host, err, oneLine(out))
		fail(w, 502, "重启失败: "+oneLine(out))
		return
	}
	log.Printf("router restart %s ok (%dms) %s", host, time.Since(t0).Milliseconds(), oneLine(out))
	writeJSON(w, 200, map[string]any{"ok": true, "host": host, "log": out, "ms": time.Since(t0).Milliseconds()})
}

// POST /router/check {"host","config"}
func handleRouterCheck(w http.ResponseWriter, r *http.Request) {
	if !routerAuthorized(w, r) {
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
	out, err := sshRun(host, cred, "check", []byte(req.Config), 90*time.Second)
	ok := err == nil
	writeJSON(w, 200, map[string]any{"ok": ok, "host": host, "output": oneLine(out)})
}

// POST /router/apply {"host","config","expectSha"}
func handleRouterApply(w http.ResponseWriter, r *http.Request) {
	if !routerAuthorized(w, r) {
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
	mode := "apply"
	if req.ExpectSha != "" {
		mode = "apply " + req.ExpectSha
	}
	t0 := time.Now()
	out, err := sshRun(host, cred, mode, []byte(req.Config), 180*time.Second)
	trimmed := oneLine(out)
	switch {
	case err == nil && strings.Contains(out, "NO_CHANGE"):
		writeJSON(w, 200, map[string]any{"ok": true, "changed": false, "host": host, "log": out, "ms": time.Since(t0).Milliseconds()})
		return
	case err == nil && strings.Contains(out, "APPLIED"):
		log.Printf("router apply %s ok (%dms) %s", host, time.Since(t0).Milliseconds(), trimmed)
		writeJSON(w, 200, map[string]any{"ok": true, "changed": true, "host": host, "log": out, "ms": time.Since(t0).Milliseconds()})
		return
	case strings.Contains(out, "STALE"):
		fail(w, 409, "配置已被他人修改，请刷新后重试："+trimmed)
		return
	case strings.Contains(out, "CHECK_FAILED"):
		fail(w, 422, "sing-box check 未通过："+trimmed)
		return
	case strings.Contains(out, "ROLLBACK_OK"):
		fail(w, 502, "新配置重启后不健康，已自动回滚："+trimmed)
		return
	default:
		log.Printf("router apply %s failed: %v %s", host, err, trimmed)
		fail(w, 502, "应用失败："+trimmed)
		return
	}
}

func oneLine(s string) string {
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

func truncStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
