package main

// public_rules.go — 「公网只读入口」写进路由器规则
//
// 两台路由的 config.json 里，route.rule_set 有 24 条 type=remote 的规则，url 形如
//   https://<公网入口>/rule-set/rs-node.srs
// 公网入口一旦换（例如改用 99 的只读端口或换域名），这些 url 都要跟着改。
// 这里提供「预览」和「写入」两个动作，写入复用既有的 /router/apply 通道
// （备份 → check → 原子替换 → 重启 → 健康检查 → 失败回滚）。
//
// 接口：
//   GET  /public/rules/preview?base=   预览：每台路由会改几条、样例 old→new
//   POST /public/rules/apply           写入：{base, hosts?, confirm:true}

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// ruleSetHost 从 url 里取出 host:port（用于识别哪些 url 属于"公网入口"）
func urlBase(u string) string {
	parsed, err := url.Parse(u)
	if err != nil {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

// rewriteRuleSetURLs 把 config 里 type=remote 且 url 指向 /rule-set/ 的条目换成新入口。
// 返回改写后的 JSON 文本、改动明细、以及改动条数。
func rewriteRuleSetURLs(configText, newBase string) (string, []map[string]string, int, error) {
	var cfg map[string]any
	if err := json.Unmarshal([]byte(configText), &cfg); err != nil {
		return "", nil, 0, fmt.Errorf("解析配置失败: %w", err)
	}
	route, _ := cfg["route"].(map[string]any)
	sets, _ := route["rule_set"].([]any)
	newBase = strings.TrimRight(newBase, "/")
	var changes []map[string]string
	for _, item := range sets {
		rs, ok := item.(map[string]any)
		if !ok {
			continue
		}
		u, _ := rs["url"].(string)
		if u == "" || !strings.Contains(u, "/rule-set/") {
			continue
		}
		tail := u[strings.Index(u, "/rule-set/"):]
		next := newBase + tail
		if next == u {
			continue
		}
		rs["url"] = next
		changes = append(changes, map[string]string{
			"tag": fmt.Sprint(rs["tag"]), "from": u, "to": next,
		})
	}
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return "", nil, 0, err
	}
	return string(out) + "\n", changes, len(changes), nil
}

// handlePublicRulesPreview GET /public/rules/preview?base=
func handlePublicRulesPreview(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !routerAuth(w, r, "") {
		return
	}
	base := strings.TrimSpace(r.URL.Query().Get("base"))
	if base == "" {
		base = currentShareCfg().PublicBase
	}
	if base == "" {
		fail(w, 400, "缺少 base（公网只读入口）")
		return
	}
	all, err := loadRouters()
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	var hosts []map[string]any
	for host, cred := range all {
		item := map[string]any{"host": host, "name": cred.Name, "ok": false}
		text, rerr := remoteReadConfig(host, cred)
		if rerr != nil {
			item["error"] = rerr.Error()
			hosts = append(hosts, item)
			continue
		}
		_, changes, n, werr := rewriteRuleSetURLs(text, base)
		if werr != nil {
			item["error"] = werr.Error()
			hosts = append(hosts, item)
			continue
		}
		item["ok"] = true
		item["changes"] = n
		if len(changes) > 3 {
			item["sample"] = changes[:3]
		} else if changes != nil {
			item["sample"] = changes
		}
		hosts = append(hosts, item)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "base": strings.TrimRight(base, "/"), "hosts": hosts})
}

// handlePublicRulesApply POST /public/rules/apply {base, hosts?, confirm}
func handlePublicRulesApply(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !routerAuth(w, r, "") {
		return
	}
	var req struct {
		Base    string   `json:"base"`
		Hosts   []string `json:"hosts"`
		Confirm bool     `json:"confirm"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, 400, "bad body")
		return
	}
	if !req.Confirm {
		fail(w, 400, "需要 confirm=true 才会写路由器配置")
		return
	}
	base := strings.TrimRight(strings.TrimSpace(req.Base), "/")
	if base == "" {
		base = currentShareCfg().PublicBase
	}
	if base == "" {
		fail(w, 400, "缺少 base")
		return
	}
	all, err := loadRouters()
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	want := map[string]bool{}
	for _, h := range req.Hosts {
		want[h] = true
	}
	var results []map[string]any
	for host, cred := range all {
		if len(want) > 0 && !want[host] {
			continue
		}
		res := map[string]any{"host": host, "name": cred.Name}
		cur, rerr := remoteReadConfig(host, cred)
		if rerr != nil {
			res["ok"] = false
			res["error"] = rerr.Error()
			results = append(results, res)
			continue
		}
		newText, _, n, werr := rewriteRuleSetURLs(cur, base)
		if werr != nil {
			res["ok"] = false
			res["error"] = werr.Error()
			results = append(results, res)
			continue
		}
		res["changes"] = n
		if n == 0 {
			res["ok"] = true
			res["changed"] = false
			results = append(results, res)
			continue
		}
		// 复用配置应用通道：expectSha 用刚读到的内容算（内容一致才允许写）
		sha := sha256Hex(cur)
		ar, aerr := remoteApplyConfig(host, cred, newText, sha)
		if aerr != nil {
			res["ok"] = false
			res["error"] = aerr.Error()
			results = append(results, res)
			continue
		}
		res["ok"] = true
		res["changed"] = ar.Changed
		res["log"] = ar.Log
		logApply(host, ar.Changed, sha, sha256Hex(newText), "", 0)
		results = append(results, res)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "base": base, "hosts": results})
}
