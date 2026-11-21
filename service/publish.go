package main

// publish.go — 规则桶发布：POST /publish
//
// 流程：鉴权（X-Vault-Key = VAULT_KEY）→ 桶名白名单 → 规则结构校验
//      → 本机 sing-box rule-set compile 编译 .srs → 双文件写回 NAS
//      → 两台路由约 60s 内自动拉取生效（remote rule-set）。
//
// 这里只接受「纯规则桶」（domain / domain_suffix / domain_keyword / ip_cidr），
// 完整 config.json 的修改走 /router/*（见 router_http.go）。

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
)

// publishReq 发布请求体；content 允许是对象，也允许是「JSON 字符串」（CLI 发布常这么传）
type publishReq struct {
	Bucket  string          `json:"bucket"`
	Content json.RawMessage `json:"content"`
}

// parseRules 校验规则文档，返回 rules 数组；第二个返回值非空即错误文案。
// 约束：rules 必须是非空数组，每条是非空对象，键只允许 ruleKeys 四类，值是非空字符串数组。
func parseRules(raw json.RawMessage) ([]map[string]any, string) {
	var doc map[string]any
	// 兼容 content 为 JSON 字符串的形态（先解一层字符串）
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

// compileRuleSet 在临时目录里把规范化桶 JSON 编译成 .srs（本机 sing-box）。
// 先写临时文件再编译，成功后才返回字节 —— 编译失败不落 NAS，避免半成品桶被路由拉走。
// 错误文案带阶段前缀（tmp/write tmp/compile failed/read srs），编译报错只留尾部 400 字节。
func compileRuleSet(jtxt []byte) ([]byte, error) {
	tmp, err := os.MkdirTemp("", "vault")
	if err != nil {
		return nil, fmt.Errorf("tmp: %w", err)
	}
	defer os.RemoveAll(tmp)
	jp, sp := filepath.Join(tmp, "a.json"), filepath.Join(tmp, "a.srs")
	if err := os.WriteFile(jp, jtxt, 0644); err != nil {
		return nil, fmt.Errorf("write tmp: %w", err)
	}
	cmd := exec.Command(singBox, "rule-set", "compile", jp, "-o", sp)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("compile failed: %s", trunc(out, 400))
	}
	srs, err := os.ReadFile(sp)
	if err != nil {
		return nil, fmt.Errorf("read srs: %w", err)
	}
	return srs, nil
}

// handlePublish 发布一个规则桶（.json + .srs 成对写回，编译失败不落盘）。
// 错误语义：401=密钥错；400=body/桶名/规则结构不合法；503=共享不可用；500=编译或写回失败。
func handlePublish(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
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
	// 共享可用性探测（SMB 会真的连一次；local 模式检查目录）
	if _, err := currentShareFS().List(); err != nil {
		fail(w, 503, "share 不可用："+err.Error())
		return
	}
	// 规范化输出：version=1 + 2 空格缩进 + 末尾换行（与页面「格式化」一致）
	jdoc, _ := json.MarshalIndent(map[string]any{"version": 1, "rules": rules}, "", "  ")
	jtxt := append(jdoc, '\n')

	srs, err := compileRuleSet(jtxt)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	// 成对写回（内部先写临时名再 rename，路由不会拉到半截文件）
	if err := currentShareFS().WriteFile(req.Bucket+".json", jtxt); err != nil {
		fail(w, 500, "write json: "+err.Error())
		return
	}
	if err := currentShareFS().WriteFile(req.Bucket+".srs", srs); err != nil {
		fail(w, 500, "write srs: "+err.Error())
		return
	}
	sum := sha256.Sum256(srs)
	log.Printf("published %s: json=%dB srs=%dB sha=%s", req.Bucket, len(jtxt), len(srs), hex.EncodeToString(sum[:])[:16])
	logPublish(req.Bucket, len(jtxt), len(srs), hex.EncodeToString(sum[:])[:16]) // 落 SQLite 留痕
	writeJSON(w, 200, map[string]any{
		"ok": true, "bucket": req.Bucket,
		"json": len(jtxt), "srs": len(srs),
		"sha256": hex.EncodeToString(sum[:])[:16],
		"hint":   "两台路由约 60s 内自动刷新",
	})
}
