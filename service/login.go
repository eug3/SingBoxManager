package main

// login.go — 单口令登录门（2026-11-28）
//
// 需求：控制台加一个只要密码、不要用户名的登录窗口；浏览器登录状态保持一周；
// 默认口令 rvnc1984；默认口令由**启动时读的配置文件**给出（文件不存在则用默认值创建）。
//
// 配置：LOGIN_FILE，默认 /etc/vault-edit/login.json
//
//	{"password":"rvnc1984","sessionSecret":"<启动时随机生成并落盘>","sessionDays":7}
//
// 会话：Cookie sbm_session = v1.<过期Unix>.<HMAC-SHA256(exp|<口令哈希>)>，HttpOnly、SameSite=Lax、
// 默认 7 天；改口令会让所有旧 Cookie 立即失效（HMAC 里含口令哈希）。
//
// 安全口径：口令**从不写进日志**；配置文件存在但坏了（解析失败 / 口令为空 / 读不出）时
// **fail-closed** —— 用一个随机且不落盘的口令，页面登录必然失败，但服务不退出，
// /health 与带 X-Vault-Key 的脚本 / 发布链照常可用（详见 loadLogin）。
//
// 放行：/login、/health、/favicon.ico；带正确 X-Vault-Key 的请求照旧放行（脚本 / 发布链不受影响）。

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// loginCfg 登录配置（启动时读一次）
type loginCfg struct {
	Password      string `json:"password"`
	SessionSecret string `json:"sessionSecret"`
	SessionDays   int    `json:"sessionDays"`
}

const (
	loginCookieName = "sbm_session"
	loginDefaultPW  = "rvnc1984"
	loginDefaultDay = 7
)

// loginFile 登录配置文件路径（LOGIN_FILE 可覆盖）
func loginFile() string { return env("LOGIN_FILE", "/etc/vault-edit/login.json") }

var currentLogin loginCfg

// loadLogin 启动时读配置。
//
// 口径（与需求一致，但不再把口令写进日志、配置坏了不再静默回落默认值）：
//
//	· 文件不存在（首次启动）→ 按默认口令创建，日志只说「用的是默认口令」，不打印口令本身；
//	· 文件存在但解析失败 / password 为空 → **fail-closed**：用一个随机且不落盘、不打印的口令，
//	  页面登录必然失败（操作员能立刻从日志看出并去修文件），但服务不退出——
//	  /health 与带 X-Vault-Key 的脚本 / 发布链不受影响，仍可正常工作；
//	  （原来的做法是悄悄回落到默认口令，等于登录门的强度就是一个公开值）
//	· 其它字段缺失（sessionSecret / sessionDays）→ 补默认值，这些不影响安全性。
//
// 任何路径都**不把口令写进日志**：原写法每次启动都打印 loginDefaultPW，
// 即使配置里早已改成别的口令（既泄密又误导）。
func loadLogin() {
	path := loginFile()
	b, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("警告：登录配置读不出（%s）：%v；已 fail-closed（页面登录将被拒绝，脚本通道不受影响），请检查文件权限", path, err)
			currentLogin = loginCfg{Password: randomToken(32), SessionSecret: randomToken(32), SessionDays: loginDefaultDay}
			return
		}
		c := loginCfg{Password: loginDefaultPW, SessionSecret: randomToken(32), SessionDays: loginDefaultDay}
		if werr := writeLoginFile(path, c); werr != nil {
			log.Printf("警告：登录配置不存在且写入失败（%s）：%v；本次使用内存默认口令与随机会话密钥（重启后已登录会话会全部失效）", path, werr)
		} else {
			log.Printf("登录配置已创建：%s（当前为默认口令，建议改掉后重启服务）", path)
		}
		currentLogin = c
		return
	}
	var c loginCfg
	if jerr := json.Unmarshal(b, &c); jerr != nil {
		log.Printf("警告：登录配置解析失败（%s）：%v；已 fail-closed（页面登录将被拒绝，脚本通道不受影响），请修正该文件后重启", path, jerr)
		currentLogin = loginCfg{Password: randomToken(32), SessionSecret: randomToken(32), SessionDays: loginDefaultDay}
		return
	}
	if strings.TrimSpace(c.Password) == "" {
		log.Printf("警告：登录配置里 password 为空（%s）；已 fail-closed（页面登录将被拒绝，脚本通道不受影响），请填入口令后重启", path)
		currentLogin = loginCfg{Password: randomToken(32), SessionSecret: randomToken(32), SessionDays: loginDefaultDay}
		return
	}
	if c.SessionSecret == "" {
		c.SessionSecret = randomToken(32)
		if werr := writeLoginFile(path, c); werr != nil {
			log.Printf("警告：登录配置补写 sessionSecret 失败：%v", werr)
		}
	}
	if c.SessionDays <= 0 {
		c.SessionDays = loginDefaultDay
	}
	currentLogin = c
	// 只报「是不是默认口令」，绝不打印口令本身
	source := "自定义口令"
	if c.Password == loginDefaultPW {
		source = "默认口令（建议改掉后重启服务）"
	}
	log.Printf("登录已启用：配置 %s · 会话 %d 天 · %s", path, c.SessionDays, source)
}

// writeLoginFile 写配置文件（0600，目录 0700）
func writeLoginFile(path string, c loginCfg) error {
	if dir := filepath.Dir(path); dir != "" {
		_ = os.MkdirAll(dir, 0o700)
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(path, append(b, '\n'), 0o600)
}

// randomToken 生成 n 字节的十六进制随机串
func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// loginPWHash 口令哈希（只进 HMAC，不落日志）
func loginPWHash(pw string) string {
	sum := sha256.Sum256([]byte(pw))
	return hex.EncodeToString(sum[:])
}

// signSession 生成会话 Cookie 值
func signSession(exp int64) string {
	mac := hmac.New(sha256.New, []byte(currentLogin.SessionSecret))
	mac.Write([]byte(strconv.FormatInt(exp, 10) + "|" + loginPWHash(currentLogin.Password)))
	return fmt.Sprintf("v1.%d.%s", exp, hex.EncodeToString(mac.Sum(nil)))
}

// sessionValid 校验 Cookie 值：签名对 + 未过期
func sessionValid(v string) bool {
	parts := strings.Split(v, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return false
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return false
	}
	want := signSession(exp)
	return subtle.ConstantTimeCompare([]byte(want), []byte(v)) == 1
}

// hasSession 请求是否已登录（Cookie 有效）
func hasSession(r *http.Request) bool {
	c, err := r.Cookie(loginCookieName)
	return err == nil && sessionValid(c.Value)
}

// hasVaultKeyHeader 脚本通道：带正确 X-Vault-Key 直接放行
func hasVaultKeyHeader(r *http.Request) bool {
	k := r.Header.Get("X-Vault-Key")
	if k == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(k), []byte(vaultKey)) == 1
}

// loginPublic 无需登录即可访问的路径
func loginPublic(r *http.Request) bool {
	switch r.URL.Path {
	case "/login", "/health", "/favicon.ico", "/logout":
		return true
	}
	return false
}

// setSessionCookie 下发一周有效的会话 Cookie
func setSessionCookie(w http.ResponseWriter, r *http.Request) {
	days := currentLogin.SessionDays
	if days <= 0 {
		days = loginDefaultDay
	}
	exp := time.Now().Add(time.Duration(days) * 24 * time.Hour)
	http.SetCookie(w, &http.Cookie{
		Name:     loginCookieName,
		Value:    signSession(exp.Unix()),
		Path:     "/",
		Expires:  exp,
		MaxAge:   days * 24 * 3600,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
	})
}

// loginWantsHTML 浏览器导航请求（决定了未登录时是 302 还是 401 JSON）
func loginWantsHTML(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	p := r.URL.Path
	if p == "/" || strings.HasSuffix(p, "/") || strings.HasSuffix(p, ".html") ||
		strings.HasPrefix(p, "/static/") || strings.HasSuffix(p, ".js") || strings.HasSuffix(p, ".css") {
		return true
	}
	return strings.Contains(r.Header.Get("Accept"), "text/html")
}

// loginGate 全站登录门：未登录时页面跳 /login、接口回 401
func loginGate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if loginPublic(r) || hasSession(r) || hasVaultKeyHeader(r) {
			next.ServeHTTP(w, r)
			return
		}
		if loginWantsHTML(r) {
			http.Redirect(w, r, "/login", http.StatusFound)
			return
		}
		if preflight(w, r) {
			return
		}
		fail(w, 401, "未登录：请先在页面登录（一周内免登录）")
	})
}

// handleLoginPage GET /login（已登录则直接进管理台）
func handleLoginPage(w http.ResponseWriter, r *http.Request) {
	if hasSession(r) {
		http.Redirect(w, r, "/edit/", http.StatusFound)
		return
	}
	renderLogin(w, http.StatusOK, "")
}

// handleLoginSubmit POST /login（也接受 GET 方便脚本？——不接受，避免口令进 URL/日志）
func handleLoginSubmit(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		renderLogin(w, http.StatusBadRequest, "请求格式不对")
		return
	}
	pw := r.PostFormValue("password")
	if pw == "" {
		renderLogin(w, http.StatusBadRequest, "请输入密码")
		return
	}
	if subtle.ConstantTimeCompare([]byte(loginPWHash(pw)), []byte(loginPWHash(currentLogin.Password))) != 1 {
		time.Sleep(300 * time.Millisecond) // 轻微延迟，压一压暴力猜
		log.Printf("登录失败：来源 %s", r.RemoteAddr)
		renderLogin(w, http.StatusUnauthorized, "密码不正确")
		return
	}
	setSessionCookie(w, r)
	log.Printf("登录成功：来源 %s（%d 天免登录）", r.RemoteAddr, currentLogin.SessionDays)
	http.Redirect(w, r, "/edit/", http.StatusFound)
}

// handleLogout GET/POST /logout：清 Cookie 回登录页
func handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name: loginCookieName, Value: "", Path: "/", MaxAge: -1,
		HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, "/login", http.StatusFound)
}

// renderLogin 输出登录页（内联模板，无外部资源）
func renderLogin(w http.ResponseWriter, code int, errMsg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = loginTmpl.Execute(w, map[string]any{"Err": errMsg, "Days": currentLogin.SessionDays})
}

var loginTmpl = template.Must(template.New("login").Parse(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>登录 · 多路由 Singbox 管理系统</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E%F0%9F%9B%A1%3C/text%3E%3C/svg%3E" />
<style>
  :root { --acc:#1f9d63; --line:#e3e9f0; --dim:#6b7b8e; }
  * { box-sizing: border-box; }
  body {
    margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#f5f8fb; color:#16202c;
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;
  }
  .card {
    width:min(380px, 92vw); background:#fff; border:1px solid var(--line); border-radius:8px;
    padding:28px 26px 22px; box-shadow:0 8px 28px rgba(23,43,77,.08);
  }
  h1 { margin:0 0 6px; font-size:17px; font-weight:600; letter-spacing:.5px; }
  h1 b { color:var(--acc); }
  .sub { color:var(--dim); font-size:12px; margin-bottom:18px; }
  label { display:block; font-size:12px; color:var(--dim); margin-bottom:6px; }
  input[type=password] {
    width:100%; padding:10px 12px; font-size:15px; letter-spacing:2px;
    border:1px solid var(--line); border-radius:5px; outline:none; background:#fbfdff;
  }
  input[type=password]:focus { border-color:var(--acc); background:#fff; }
  .err {
    margin:0 0 12px; padding:8px 10px; border:1px solid #f0b4ae; background:#fdf3f2;
    color:#b42318; border-radius:4px; font-size:12px;
  }
  button {
    width:100%; margin-top:14px; padding:10px 14px; border:0; border-radius:5px;
    background:var(--acc); color:#fff; font-size:14px; font-weight:600; cursor:pointer;
  }
  button:hover { filter:brightness(.96); }
  .foot { margin-top:14px; color:var(--dim); font-size:11px; text-align:center; }
</style>
</head>
<body>
  <form class="card" method="post" action="/login" autocomplete="off">
    <h1>◆ <b>多路由 Singbox 管理系统</b></h1>
    <div class="sub">请输入访问密码（登录后本浏览器 {{.Days}} 天内免登录）</div>
    {{if .Err}}<div class="err">✗ {{.Err}}</div>{{end}}
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus />
    <button type="submit">登录</button>
    <div class="foot">密码由服务端配置文件管理 · 忘记可改 /etc/vault-edit/login.json</div>
  </form>
</body>
</html>
`))
