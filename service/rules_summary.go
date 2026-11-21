package main

// rules_summary.go — /router/rules：路由规则结构摘要（只读，不改配置）。
//
// 给管理台「规则」页用：把 config.json 的 route 段拆成两份清单 ——
//   rule_set[]：remote 桶内容托管在 NAS，改内容走 /publish 热加载，免重启
//               （contentRestartFree=true）；local/inline 内容在 config 里，
//               改它必须走 /router/apply（重启），标 false。
//   rules[]：  每条规则都是 config 结构的一部分，改它=改 config=需重启，
//               一律标 structural=true。
//
// handler 口径与 router_http.go 的 handleRouterConfig 一致：
// 先 pickRouter 再鉴权（「未配置路由凭据」400 文案是前端门禁触发条件），读取失败 502。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// 其它键里长数组的摘要阈值：超过就只给 count+前几条样例，
// 避免内联大域名表把摘要响应撑爆（完整内容仍可走 /router/config 取）。
const (
	otherListLimit  = 8
	otherListSample = 3
)

// strOf 宽松取字符串（缺失或非字符串 → ""）：摘要只读，不做配置校验
func strOf(v any) string {
	s, _ := v.(string)
	return s
}

// summarizeRules 解析 sing-box config.json，产出规则结构摘要（纯函数，无副作用）。
// 返回 {"ruleSets": [...], "routeRules": [...], "counts": {...}}；JSON 解析失败返回 error。
// route 段缺失时给空清单与零计数（合法配置可以没有 route）。
func summarizeRules(configText string) (map[string]any, error) {
	var cfg map[string]any
	if err := json.Unmarshal([]byte(configText), &cfg); err != nil {
		return nil, fmt.Errorf("解析配置失败: %w", err)
	}
	route, _ := cfg["route"].(map[string]any)

	// ---- route.rule_set[]：tag/type/url/path/format + 免重启标注 ----
	rawSets, _ := route["rule_set"].([]any)
	ruleSets := make([]map[string]any, 0, len(rawSets))
	remote := 0
	for _, item := range rawSets {
		rs, ok := item.(map[string]any)
		if !ok {
			continue
		}
		typ := strOf(rs["type"])
		if typ == "" {
			typ = "local" // sing-box 缺省 type=local
		}
		entry := map[string]any{
			"tag":  strOf(rs["tag"]),
			"type": typ,
			// remote 桶改内容走 /publish（update_interval 热加载），免重启；
			// local/inline 的内容在 config 里，改它要重启。
			"contentRestartFree": typ == "remote",
		}
		for _, k := range []string{"url", "path", "format"} {
			if s := strOf(rs[k]); s != "" {
				entry[k] = s
			}
		}
		if typ == "remote" {
			remote++
		}
		ruleSets = append(ruleSets, entry)
	}

	// ---- route.rules[]：index/action/outbound/rule_set 引用 + 其它键摘要 ----
	rawRules, _ := route["rules"].([]any)
	routeRules := make([]map[string]any, 0, len(rawRules))
	for i, item := range rawRules {
		ru, ok := item.(map[string]any)
		if !ok {
			continue
		}
		routeRules = append(routeRules, summarizeRouteRule(ru, i))
	}

	return map[string]any{
		"ruleSets":   ruleSets,
		"routeRules": routeRules,
		"counts": map[string]any{
			"ruleSets":       len(ruleSets),
			"ruleSetsRemote": remote,
			"ruleSetsLocal":  len(ruleSets) - remote, // 含 inline：内容在 config 里，同样要重启
			"routeRules":     len(routeRules),        // 只数顶层；logical 嵌套子规则在 other.rules 里
		},
	}, nil
}

// summarizeRouteRule 摘要单条 route.rule。index 是它在 route.rules[] 里的原始下标。
// 每条规则都标 structural=true —— 规则属于 config 结构，改它必须重启。
func summarizeRouteRule(ru map[string]any, index int) map[string]any {
	action := strOf(ru["action"])
	if action == "" {
		action = "route" // sing-box 缺省 action=route
	}
	entry := map[string]any{
		"index":      index,
		"action":     action,
		"ruleSets":   ruleSetRefs(ru["rule_set"]),
		"structural": true,
	}
	if ob := strOf(ru["outbound"]); ob != "" {
		entry["outbound"] = ob
	}
	other := map[string]any{}
	for k, v := range ru {
		switch k {
		case "action", "outbound", "rule_set":
			continue // 已单独提取
		}
		if k == "rules" {
			if subs, ok := v.([]any); ok {
				// logical 规则的嵌套子规则：递归摘要（子规则同样 structural=true）
				list := make([]map[string]any, 0, len(subs))
				for j, sub := range subs {
					if m, ok := sub.(map[string]any); ok {
						list = append(list, summarizeRouteRule(m, j))
					}
				}
				other[k] = list
				continue
			}
		}
		other[k] = summarizeOtherValue(v)
	}
	entry["other"] = other
	return entry
}

// ruleSetRefs 归一化 rule_set 引用：sing-box 允许字符串或字符串数组，统一输出 []string
func ruleSetRefs(v any) []string {
	switch x := v.(type) {
	case string:
		if x == "" {
			return []string{}
		}
		return []string{x}
	case []any:
		out := make([]string, 0, len(x))
		for _, it := range x {
			if s := strOf(it); s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return []string{}
}

// summarizeOtherValue 其它键的摘要：长数组只留计数与前几条样例，其余原样保留
func summarizeOtherValue(v any) any {
	if arr, ok := v.([]any); ok && len(arr) > otherListLimit {
		return map[string]any{"count": len(arr), "sample": arr[:otherListSample]}
	}
	return v
}

// handleRouterRules GET /router/rules?host= —— 规则结构摘要（只读）
func handleRouterRules(w http.ResponseWriter, r *http.Request) {
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
	summary, err := summarizeRules(out)
	if err != nil {
		fail(w, 502, "解析失败: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "host": host, "name": cred.Name,
		"ruleSets": summary["ruleSets"], "routeRules": summary["routeRules"], "counts": summary["counts"],
		"sha256": sha256Hex(out), "size": len(out),
		"ms": time.Since(t0).Milliseconds(),
	})
}
