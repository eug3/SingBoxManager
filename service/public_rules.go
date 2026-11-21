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

// normalizePublicBase 规整「规则路径」：不带文件名的全路径，结尾带 /。
// 兼容旧配置只写域名（无路径）的情况，自动补 /rule-set/。
// 例：https://x.com/rule-set/ → 原样；https://x.com → https://x.com/rule-set/。
func normalizePublicBase(base string) string {
	base = strings.TrimSpace(base)
	if base == "" {
		return ""
	}
	parsed, err := url.Parse(base)
	if err != nil {
		return strings.TrimRight(base, "/") + "/"
	}
	if parsed.Path == "" || parsed.Path == "/" {
		parsed.Path = "/rule-set/"
	}
	out := parsed.String()
	return strings.TrimRight(out, "/") + "/"
}

// ruleSetFilename 取 url 的最后一段文件名；缺失时用 tag.srs
func ruleSetFilename(u, tag string) string {
	if i := strings.LastIndex(u, "/"); i >= 0 && i+1 < len(u) {
		return u[i+1:]
	}
	return tag + ".srs"
}

// rewriteRuleSetURLs 把 config 里 type=remote 的 rule_set url 换成「规则路径 + 文件名」。
// newBase 为不带文件名的全路径（normalizePublicBase 规整）。返回改写文本/明细/条数。
//
// 改写优先级（每条 remote 规则集）：
//  1. 文件名沿用旧 url 的最后一段（桶文件名不随入口变化）；
//  2. 旧 url 没有文件名时回退 <tag>.srs；
//  3. 新旧 url 相同则跳过，不计入变更。
//
// local/inline 规则集不动；输出统一 2 空格缩进 + 末尾换行（与 /router/apply 口径一致）。
func rewriteRuleSetURLs(configText, newBase string) (string, []map[string]string, int, error) {
	var cfg map[string]any
	if err := json.Unmarshal([]byte(configText), &cfg); err != nil {
		return "", nil, 0, fmt.Errorf("解析配置失败: %w", err)
	}
	route, _ := cfg["route"].(map[string]any)
	sets, _ := route["rule_set"].([]any)
	newBase = normalizePublicBase(newBase)
	var changes []map[string]string
	for _, item := range sets {
		rs, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if t, _ := rs["type"].(string); t != "remote" {
			continue // local/inline 不动
		}
		u, _ := rs["url"].(string)
		tag := fmt.Sprint(rs["tag"])
		next := newBase + ruleSetFilename(u, tag)
		if next == u {
			continue
		}
		rs["url"] = next
		changes = append(changes, map[string]string{
			"tag": tag, "from": u, "to": next,
		})
	}
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return "", nil, 0, err
	}
	return string(out) + "\n", changes, len(changes), nil
}

// previewPublicBaseOnRouter 预览单台路由：读配置 → 试改写，汇总成一条结果。
// 读取或解析失败时 ok=false 并带 error 文案，不影响其它路由。
func previewPublicBaseOnRouter(host string, cred routerCred, base string) map[string]any {
	item := map[string]any{"host": host, "name": cred.Name, "ok": false}
	text, rerr := remoteReadConfig(host, cred)
	if rerr != nil {
		item["error"] = rerr.Error()
		return item
	}
	_, changes, n, werr := rewriteRuleSetURLs(text, base)
	if werr != nil {
		item["error"] = werr.Error()
		return item
	}
	item["ok"] = true
	item["changes"] = n
	// 样例最多给 3 条 old→new；无变更时不带 sample 字段
	if len(changes) > 3 {
		item["sample"] = changes[:3]
	} else if changes != nil {
		item["sample"] = changes
	}
	return item
}

// handlePublicRulesPreview GET /public/rules/preview?base=
// base 缺省用当前存储配置的 publicBase；逐台路由预览，汇总 {ok, base, hosts}。
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
		fail(w, 400, "缺少 base（规则路径）")
		return
	}
	all, err := loadRouters()
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	var hosts []map[string]any
	for host, cred := range all {
		hosts = append(hosts, previewPublicBaseOnRouter(host, cred, base))
	}
	writeJSON(w, 200, map[string]any{"ok": true, "base": normalizePublicBase(base), "hosts": hosts})
}

// applyPublicBaseToRouter 对单台路由执行改写并走 /router/apply 同款应用通道。
// 返回一条结果：读取/改写/应用失败 ok=false 带 error；无变更 changed=false；
// 成功时带 changed/log，并落 apply_log 留痕。
func applyPublicBaseToRouter(host string, cred routerCred, base string) map[string]any {
	res := map[string]any{"host": host, "name": cred.Name}
	cur, rerr := remoteReadConfig(host, cred)
	if rerr != nil {
		res["ok"] = false
		res["error"] = rerr.Error()
		return res
	}
	newText, _, n, werr := rewriteRuleSetURLs(cur, base)
	if werr != nil {
		res["ok"] = false
		res["error"] = werr.Error()
		return res
	}
	res["changes"] = n
	if n == 0 {
		res["ok"] = true
		res["changed"] = false
		return res
	}
	// 复用配置应用通道：expectSha 用刚读到的内容算（内容一致才允许写）
	sha := sha256Hex(cur)
	ar, aerr := remoteApplyConfig(host, cred, newText, sha)
	if aerr != nil {
		res["ok"] = false
		res["error"] = aerr.Error()
		return res
	}
	res["ok"] = true
	res["changed"] = ar.Changed
	res["log"] = ar.Log
	logApply(host, ar.Changed, sha, sha256Hex(newText), "", 0)
	return res
}

// handlePublicRulesApply POST /public/rules/apply {base, hosts?, confirm}
// 必须 confirm=true；hosts 缺省=全部已配置路由。逐台写入，单台失败不阻断其它路由。
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
	base := normalizePublicBase(req.Base)
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
		results = append(results, applyPublicBaseToRouter(host, cred, base))
	}
	writeJSON(w, 200, map[string]any{"ok": true, "base": base, "hosts": results})
}
