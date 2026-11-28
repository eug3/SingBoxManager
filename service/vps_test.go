package main

// vps_test.go — 远程 VPS 部署的纯函数回归（不连任何主机）

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestShqEscapesSingleQuote(t *testing.T) {
	cases := []struct{ in, want string }{
		{"abc", "'abc'"},
		{"a b", "'a b'"},
		{"it's", `'it'\''s'`},
		{"'; rm -rf / #", `''\''; rm -rf / #'`},
		{"", "''"},
	}
	for _, c := range cases {
		if got := shq(c.in); got != c.want {
			t.Fatalf("shq(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

func TestDefaultVpsTag(t *testing.T) {
	cases := []struct{ name, host, want string }{
		{"东京-01", "1.2.3.4", "vps-01"}, // 非 ASCII(含中文)被剥掉，只剩 01 → 加 vps- 前缀
		{"Tokyo A", "", "tokyo-a"},
		{"", "v6.sa.onino.xyz", "v6.sa.onino.xyz"},
		{"", "1.2.3.4", "vps-1.2.3.4"},
		{"HK_Edge#1", "", "hk_edge-1"},
	}
	for _, c := range cases {
		if got := defaultVpsTag(c.name, c.host); got != c.want {
			t.Fatalf("defaultVpsTag(%q,%q) = %q，期望 %q", c.name, c.host, got, c.want)
		}
	}
}

func TestNextAddrPool(t *testing.T) {
	if got := nextAddrPool(nil); got != "172.20.0.1/24" {
		t.Fatalf("空集应给 0，得到 %q", got)
	}
	if got := nextAddrPool([]string{"172.20.0.1/24", "172.20.1.1/24"}); got != "172.20.2.1/24" {
		t.Fatalf("应跳过已用，得到 %q", got)
	}
	// 非法/异网段条目不影响分配
	if got := nextAddrPool([]string{"10.0.0.1/24", "", "172.20.0.1/24"}); got != "172.20.1.1/24" {
		t.Fatalf("应忽略无关条目，得到 %q", got)
	}
}

func TestMasqueServerConfigJSON(t *testing.T) {
	plan := vpsDeployPlan{
		Host: "1.2.3.4", Tag: "vps-test", SNI: "test.onino.xyz",
		ListenPort: 443, AddrPool: "172.20.9.1/24", MasquePassword: "pw-123456",
		CertMode: "self", RemoteDir: "/etc/sing-box-masque",
	}
	out, err := masqueServerConfigJSON(plan)
	if err != nil {
		t.Fatalf("生成配置失败：%v", err)
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(out), &cfg); err != nil {
		t.Fatalf("生成的配置不是合法 JSON：%v\n%s", err, out)
	}
	eps, _ := cfg["endpoints"].([]any)
	if len(eps) != 1 {
		t.Fatalf("应有 1 个 endpoint，实际 %d", len(eps))
	}
	ep := eps[0].(map[string]any)
	for k, want := range map[string]any{
		"type": "masque-server", "tag": "masque-server", "listen": "::", "mtu": float64(1280),
	} {
		if ep[k] != want {
			t.Fatalf("endpoint.%s = %v，期望 %v", k, ep[k], want)
		}
	}
	if ep["listen_port"] != float64(443) {
		t.Fatalf("listen_port 错：%v", ep["listen_port"])
	}
	users := ep["users"].([]any)
	u := users[0].(map[string]any)
	if u["username"] != "masque" || u["password"] != "pw-123456" {
		t.Fatalf("用户字段错：%v", u)
	}
	addr := ep["address"].([]any)
	if len(addr) != 1 || addr[0] != "172.20.9.1/24" {
		t.Fatalf("address 错：%v", ep["address"])
	}
	tls := ep["tls"].(map[string]any)
	if tls["certificate_path"] != "/etc/sing-box-masque/cert.pem" ||
		tls["key_path"] != "/etc/sing-box-masque/key.pem" || tls["server_name"] != "test.onino.xyz" {
		t.Fatalf("tls 字段错：%v", tls)
	}
	// 校验失败分支
	bad := plan
	bad.ListenPort = 0
	if _, err := masqueServerConfigJSON(bad); err == nil {
		t.Fatal("端口 0 应报错")
	}
	bad = plan
	bad.MasquePassword = ""
	if _, err := masqueServerConfigJSON(bad); err == nil {
		t.Fatal("空密码应报错")
	}
	// existing 证书模式用给定路径
	ex := plan
	ex.CertMode, ex.CertPath, ex.KeyPath = "existing", "/c.pem", "/k.pem"
	out2, _ := masqueServerConfigJSON(ex)
	var cfg2 map[string]any
	_ = json.Unmarshal([]byte(out2), &cfg2)
	tls2 := cfg2["endpoints"].([]any)[0].(map[string]any)["tls"].(map[string]any)
	if tls2["certificate_path"] != "/c.pem" || tls2["key_path"] != "/k.pem" {
		t.Fatalf("existing 模式未用给定路径：%v", tls2)
	}
}

func TestMasqueClientEndpoint(t *testing.T) {
	n := masqueClientEndpoint("vps-tokyo", "tokyo.onino.xyz", "tokyo.onino.xyz", 443, "pw")
	for k, want := range map[string]any{
		"type": "masque-client", "tag": "vps-tokyo", "server": "tokyo.onino.xyz",
		"server_port": 443, "username": "masque", "password": "pw",
		"version": 3, "mtu": 1280,
	} {
		if n[k] != want {
			t.Fatalf("client.%s = %v，期望 %v", k, n[k], want)
		}
	}
	tls := n["tls"].(map[string]any)
	if tls["enabled"] != true || tls["insecure"] != true || tls["server_name"] != "tokyo.onino.xyz" {
		t.Fatalf("client.tls 错：%v", tls)
	}
	// SNI 空则回落到 server
	n2 := masqueClientEndpoint("t", "1.2.3.4", "", 443, "pw")
	if n2["tls"].(map[string]any)["server_name"] != "1.2.3.4" {
		t.Fatalf("SNI 空时应回落 server：%v", n2["tls"])
	}
}

// 脚本里绝不能出现未转义的注入串，且配置必须以 base64 原样嵌入
func TestVpsDeployScriptIsInjectionSafe(t *testing.T) {
	nasty := `a'; rm -rf / #`
	plan := vpsDeployPlan{
		Host: "1.2.3.4", Tag: "t", SNI: nasty,
		ListenPort: 443, AddrPool: "172.20.0.1/24", MasquePassword: "pw",
		CertMode: "self", RemoteDir: "/etc/sing-box-masque", RemoteBin: "/opt/sing-box-masque/sing-box",
	}
	cfg, err := masqueServerConfigJSON(plan)
	if err != nil {
		t.Fatalf("配置生成失败：%v", err)
	}
	script := vpsDeployScript(plan, cfg)
	if strings.Contains(script, "\nrm -rf / #") {
		t.Fatal("SNI 未转义，脚本里出现裸注入串")
	}
	if !strings.Contains(script, `'\''`) {
		t.Fatal("应含单引号转义形式")
	}
	// 配置正文必须是 base64（不含原始 JSON 片段）
	b64 := base64.StdEncoding.EncodeToString([]byte(cfg))
	if !strings.Contains(script, b64) {
		t.Fatal("配置未以 base64 嵌入脚本")
	}
	if strings.Contains(script, `"masque-server"`) {
		t.Fatal("脚本里不应出现原始配置明文")
	}
	// 关键步骤齐全
	for _, want := range []string{
		"OK_DEPLOYED", "CHECK_OK", "systemctl daemon-reload", "sing-box-masque.service",
		"install -m 0755", "base64 -d", "MISSING_UPLOAD", "cert.pem",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("脚本缺少关键步骤：%s", want)
		}
	}
	// existing 证书模式不生成自签
	plan.CertMode, plan.CertPath, plan.KeyPath = "existing", "/c.pem", "/k.pem"
	cfg2, _ := masqueServerConfigJSON(plan)
	s2 := vpsDeployScript(plan, cfg2)
	if strings.Contains(s2, "openssl req") {
		t.Fatal("existing 模式不该再生成自签证书")
	}
	if !strings.Contains(s2, "/c.pem") {
		t.Fatal("existing 模式应校验给定证书路径")
	}
}

func TestVpsProbeScriptMentionsPortAndMarkers(t *testing.T) {
	s := vpsProbeScript(24443)
	for _, want := range []string{"ARCH=", "LIBC=", "HAS_SYSTEMD=", "PORT_INUSE=", ":24443$", "PROBE_DONE"} {
		if !strings.Contains(s, want) {
			t.Fatalf("探测脚本缺少：%s", want)
		}
	}
}

func TestDeployFailReason(t *testing.T) {
	cases := map[string]string{
		"xxx MISSING_UPLOAD":  "上传的二进制不见了（可能 /tmp 不可写或被清理）",
		"CHECK_FAILED\nFATAL": "配置被拒",
		"NOT_ACTIVE":          "不是 active",
		"VERIFY_FAILED":       "跑不起来",
		"nothing-here":        "部署失败",
	}
	for out, want := range cases {
		got := deployFailReason(out)
		if !strings.Contains(got, want) {
			t.Fatalf("deployFailReason(%q) = %q，应含 %q", out, got, want)
		}
	}
}

func TestCleanANSI(t *testing.T) {
	in := "\x1b[31mFATAL\x1b[0m test"
	if got := cleanANSI(in); got != "FATAL test" {
		t.Fatalf("cleanANSI = %q", got)
	}
}
