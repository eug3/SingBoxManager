package main

// vault-edit — 规则桶发布 + 内网管理台服务（SingBoxManager 的一部分）
//
// 仅监听内网（99号机 192.168.31.99:9099），页面只在 http://192.168.31.99:9099/edit/：
//   管理台     GET  /edit/                    编辑台页面（本地文件，改页面不用重编二进制）
//   桶源只读   GET  /rule-set/<桶>.{json,srs}  读 NAS 共享（白名单桶名，no-store）
//   发布       POST /publish                   校验 → sing-box 编译 → 写回 NAS → 路由 60s 自动拉取
//   注：clash_api（看分组/切节点）由浏览器直连两台路由，路由侧白名单需含本页来源
//   健康       GET  /health
//
// 鉴权：X-Vault-Key（=两台路由 clash_api secret）只从环境变量 VAULT_KEY 读，不落源码。
// 部署：99号机 /usr/local/bin/vault-edit（systemd: vault-edit.service，EnvironmentFile=/etc/vault-edit.env）

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

var (
	listen    = env("LISTEN", ":9099")
	shareDir  = env("SHARE_DIR", "/mnt/hdd/WebEdit/rule-set")
	pageDir   = env("PAGE_DIR", "/usr/local/share/vault-edit/edit")
	staticDir = env("STATIC_DIR", "/usr/local/share/vault-edit/static")
	singBox   = env("SINGBOX", "/usr/local/bin/sing-box")
	vaultKey  = os.Getenv("VAULT_KEY")

	allowOrigins = []string{"http://192.168.31.99:9099"}
	bucketRe     = regexp.MustCompile(`^(rs-[a-z0-9-]+|bard-domains)$`)
	rsFileRe     = regexp.MustCompile(`^(rs-[a-z0-9-]+|bard-domains)\.(json|srs)$`)
	ruleKeys     = map[string]bool{"domain": true, "domain_suffix": true, "domain_keyword": true, "ip_cidr": true}
)

type publishReq struct {
	Bucket  string          `json:"bucket"`
	Content json.RawMessage `json:"content"`
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	b, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(b)))
	w.WriteHeader(code)
	w.Write(b)
}

func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"error": msg})
}

// parseRules: content 可以是对象或 JSON 字符串；返回 rules 数组或错误
func parseRules(raw json.RawMessage) ([]map[string]any, string) {
	var doc map[string]any
	if len(raw) > 0 && raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return nil, "bad json: " + err.Error()
		}
		raw = json.RawMessage(s)
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, "bad json: " + err.Error()
	}
	rules, ok := doc["rules"].([]any)
	if !ok || len(rules) == 0 {
		return nil, "rules[] required"
	}
	out := make([]map[string]any, 0, len(rules))
	for i, r := range rules {
		m, ok := r.(map[string]any)
		if !ok || len(m) == 0 {
			return nil, fmt.Sprintf("rules[%d]: must be a non-empty object", i)
		}
		for k, v := range m {
			if !ruleKeys[k] {
				return nil, fmt.Sprintf("rules[%d]: unknown key %q", i, k)
			}
			arr, ok := v.([]any)
			if !ok || len(arr) == 0 {
				return nil, fmt.Sprintf("rules[%d]: %s must be a non-empty array", i, k)
			}
			for _, e := range arr {
				s, ok := e.(string)
				if !ok || s == "" {
					return nil, fmt.Sprintf("rules[%d]: %s entries must be non-empty strings", i, k)
				}
			}
		}
		out = append(out, m)
	}
	return out, ""
}

func setCors(h http.Header, origin string) {
	for _, o := range allowOrigins {
		if o == origin {
			h.Set("Access-Control-Allow-Origin", o)
			break
		}
	}
	h.Set("Access-Control-Allow-Headers", "Content-Type,X-Vault-Key")
	h.Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
	h.Set("Cache-Control", "no-store")
}

// ── 只读桶源：/rule-set/<桶>.{json,srs} ────────────────────────────
func serveRuleSet(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/rule-set/")
	if !rsFileRe.MatchString(name) {
		fail(w, 404, "bad rule-set name")
		return
	}
	if strings.HasSuffix(name, ".json") {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, filepath.Join(shareDir, name))
}

// ── 管理台页面：/edit/（Angular 产物：index.html + /edit/<asset>）────
func servePage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	rel := strings.TrimPrefix(r.URL.Path, "/edit/")
	if rel != "" && rel != "index.html" {
		if f, err := safeJoin(pageDir, rel); err == nil {
			if st, err := os.Stat(f); err == nil && st.Mode().IsRegular() {
				http.ServeFile(w, r, f)
				return
			}
		}
	}
	http.ServeFile(w, r, filepath.Join(pageDir, "index.html"))
}

// ── 静态资源：/static/（Monaco 等，随 99 本地部署，不依赖 CDN）───────
func serveStatic(w http.ResponseWriter, r *http.Request) {
	f, err := safeJoin(staticDir, strings.TrimPrefix(r.URL.Path, "/static/"))
	if err != nil {
		fail(w, 404, "bad path")
		return
	}
	st, err := os.Stat(f)
	if err != nil || !st.Mode().IsRegular() {
		fail(w, 404, "not found")
		return
	}
	switch {
	case strings.HasSuffix(f, ".js"):
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	case strings.HasSuffix(f, ".css"):
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	case strings.HasSuffix(f, ".json"):
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(w, r, f)
}

// safeJoin 拼接并防目录穿越（base 外的路径一律拒绝）
func safeJoin(base, rel string) (string, error) {
	full := filepath.Join(base, filepath.Clean("/"+rel))
	baseClean := filepath.Clean(base)
	if full != baseClean && !strings.HasPrefix(full, baseClean+string(os.PathSeparator)) {
		return "", fmt.Errorf("path escape: %s", rel)
	}
	return full, nil
}

func main() {
	if vaultKey == "" {
		log.Fatal("VAULT_KEY 未设置（应为两台路由 clash_api secret；systemd 从 /etc/vault-edit.env 注入）")
	}
	if st, err := os.Stat(shareDir); err != nil || !st.IsDir() {
		log.Printf("警告：共享目录当前不可用（%s）：发布接口会返回 503", shareDir)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		_, rerr := os.Stat(routersFile())
		writeJSON(w, 200, map[string]any{
			"ok": true, "lang": "go", "share": shareDir, "page": pageDir, "static": staticDir,
			"routers": routersFile(), "routersReady": rerr == nil,
		})
	})

	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/edit/", http.StatusFound)
	})

	mux.HandleFunc("GET /edit/", servePage)
	mux.HandleFunc("GET /edit/index.html", servePage)
	mux.HandleFunc("GET /static/", serveStatic)
	mux.HandleFunc("GET /rule-set/", serveRuleSet)

	mux.HandleFunc("/publish", handlePublish)

	// 路由操作（受限 SSH → 路由器本地 singbox-apply 脚本）
	mux.HandleFunc("GET /router/config", handleRouterConfig)
	mux.HandleFunc("POST /router/restart", handleRouterRestart)
	mux.HandleFunc("POST /router/check", handleRouterCheck)
	mux.HandleFunc("POST /router/apply", handleRouterApply)
	mux.HandleFunc("GET /router/credentials", handleRouterCredentialsList)
	mux.HandleFunc("POST /router/credentials", handleRouterCredentialsSet)
	mux.HandleFunc("DELETE /router/credentials", handleRouterCredentialsDelete)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		setCors(w.Header(), r.Header.Get("Origin"))
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		fail(w, 404, "not found")
	})

	srv := &http.Server{Addr: listen, Handler: mux}
	log.Printf("vault-edit (go) listening on %s · share=%s · page=%s · static=%s", listen, shareDir, pageDir, staticDir)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func handlePublish(w http.ResponseWriter, r *http.Request) {
	setCors(w.Header(), r.Header.Get("Origin"))
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Header.Get("X-Vault-Key") != vaultKey {
		fail(w, 401, "bad key")
		return
	}
	var req publishReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, "bad body: "+err.Error())
		return
	}
	if !bucketRe.MatchString(req.Bucket) {
		fail(w, 400, "bad bucket name")
		return
	}
	rules, emsg := parseRules(req.Content)
	if emsg != "" {
		fail(w, 400, emsg)
		return
	}
	if st, err := os.Stat(shareDir); err != nil || !st.IsDir() {
		fail(w, 503, "share not mounted")
		return
	}
	jdoc, _ := json.MarshalIndent(map[string]any{"version": 1, "rules": rules}, "", "  ")
	jtxt := append(jdoc, '\n')

	tmp, err := os.MkdirTemp("", "vault")
	if err != nil {
		fail(w, 500, "tmp: "+err.Error())
		return
	}
	defer os.RemoveAll(tmp)
	jp, sp := filepath.Join(tmp, "a.json"), filepath.Join(tmp, "a.srs")
	if err := os.WriteFile(jp, jtxt, 0644); err != nil {
		fail(w, 500, "write tmp: "+err.Error())
		return
	}
	cmd := exec.Command(singBox, "rule-set", "compile", jp, "-o", sp)
	out, err := cmd.CombinedOutput()
	if err != nil {
		fail(w, 500, "compile failed: "+string(trunc(out, 400)))
		return
	}
	srs, err := os.ReadFile(sp)
	if err != nil {
		fail(w, 500, "read srs: "+err.Error())
		return
	}
	if err := os.WriteFile(filepath.Join(shareDir, req.Bucket+".json"), jtxt, 0644); err != nil {
		fail(w, 500, "write json: "+err.Error())
		return
	}
	if err := os.WriteFile(filepath.Join(shareDir, req.Bucket+".srs"), srs, 0644); err != nil {
		fail(w, 500, "write srs: "+err.Error())
		return
	}
	sum := sha256.Sum256(srs)
	log.Printf("published %s: json=%dB srs=%dB sha=%s", req.Bucket, len(jtxt), len(srs), hex.EncodeToString(sum[:])[:16])
	writeJSON(w, 200, map[string]any{
		"ok": true, "bucket": req.Bucket,
		"json": len(jtxt), "srs": len(srs),
		"sha256": hex.EncodeToString(sum[:])[:16],
		"hint":   "两台路由约 60s 内自动刷新",
	})
}

func trunc(b []byte, n int) []byte {
	if len(b) > n {
		return b[len(b)-n:]
	}
	return b
}
