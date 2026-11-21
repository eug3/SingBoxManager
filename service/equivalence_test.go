package main

// equivalence_test.go — 等价重构的纯函数护栏测试：
// 客户端名册合并（租约+ARP）、公网规则路径规整与改写、口令沿用口径、远端脚本标记。
// 运行：cd service && go test ./...

import (
	"strings"
	"testing"
)

// ---- parseClients：dhcp.leases + /proc/net/arp 合并 ----

func TestParseClients(t *testing.T) {
	leases := strings.Join([]string{
		"1700000000 AA:BB:CC:DD:EE:01 192.168.31.100 desktop *",
		"1700000000 aa:bb:cc:dd:ee:02 192.168.31.101 * *", // hostname=* 视为无名
		"bad line", // 字段不足，跳过
	}, "\n")
	arp := strings.Join([]string{
		"IP address       HW type     Flags       HW address            Mask     Device",
		"192.168.31.100   0x1         0x2         aa:bb:cc:dd:ee:01     *        br-lan",
		"192.168.31.102   0x1         0x2         aa:bb:cc:dd:ee:03     *        br-lan",
		"192.168.31.103   0x1         0x0         00:00:00:00:00:00     *        br-lan", // 全零 MAC 丢弃
	}, "\n")

	got := parseClients(leases, arp)
	byIP := map[string]map[string]string{}
	for _, e := range got {
		byIP[e["ip"]] = e
	}
	if len(byIP) != 3 {
		t.Fatalf("应合并出 3 个 IP（100/101/102），得到 %v", got)
	}
	// 租约带主机名；ARP 同 IP 覆盖 mac 但保留 name；MAC 统一小写
	if e := byIP["192.168.31.100"]; e["mac"] != "aa:bb:cc:dd:ee:01" || e["name"] != "desktop" {
		t.Errorf("租约+ARP 合并不对：%v", e)
	}
	// hostname=* 不带名字
	if e := byIP["192.168.31.101"]; e["name"] != "" || e["mac"] != "aa:bb:cc:dd:ee:02" {
		t.Errorf("hostname=* 应无名：%v", e)
	}
	// 仅 ARP 出现的 IP 也要进名册（只有 mac 没有 name）
	if e := byIP["192.168.31.102"]; e["mac"] != "aa:bb:cc:dd:ee:03" || e["name"] != "" {
		t.Errorf("ARP 补漏不对：%v", e)
	}
	if _, has := byIP["192.168.31.103"]; has {
		t.Error("全零 MAC 不应进名册")
	}
}

// ---- normalizePublicBase / ruleSetFilename：公网规则路径口径 ----

func TestNormalizePublicBase(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},
		{"https://x.com", "https://x.com/rule-set/"},
		{"https://x.com/", "https://x.com/rule-set/"},
		{"https://x.com/rule-set/", "https://x.com/rule-set/"},
		{"https://x.com/rule-set", "https://x.com/rule-set/"},
		{"  https://x.com/custom/  ", "https://x.com/custom/"},
	}
	for _, c := range cases {
		if got := normalizePublicBase(c.in); got != c.want {
			t.Errorf("normalizePublicBase(%q) = %q，期望 %q", c.in, got, c.want)
		}
	}
}

func TestRuleSetFilename(t *testing.T) {
	if got := ruleSetFilename("https://x.com/rule-set/rs-a.srs", "rs-a"); got != "rs-a.srs" {
		t.Errorf("应取 url 末段文件名，得到 %q", got)
	}
	if got := ruleSetFilename("https://x.com/rule-set/", "rs-b"); got != "rs-b.srs" {
		t.Errorf("无文件名应回退 tag.srs，得到 %q", got)
	}
	if got := ruleSetFilename("", "rs-c"); got != "rs-c.srs" {
		t.Errorf("空 url 应回退 tag.srs，得到 %q", got)
	}
}

// ---- rewriteRuleSetURLs：只改 remote、文件名沿用、相同跳过 ----

func TestRewriteRuleSetURLs(t *testing.T) {
	config := `{
  "route": {
    "rule_set": [
      {"tag": "rs-a", "type": "remote", "url": "https://old.example.com/rule-set/rs-a.srs"},
      {"tag": "rs-b", "type": "remote", "url": "https://old.example.com/no-name/"},
      {"tag": "rs-c", "type": "remote", "url": "https://new.example.com/rule-set/rs-c.srs"},
      {"tag": "lan", "type": "local", "path": "/etc/sing-box/lan.json"}
    ]
  }
}`
	out, changes, n, err := rewriteRuleSetURLs(config, "https://new.example.com")
	if err != nil {
		t.Fatalf("期望通过，得到错误：%v", err)
	}
	// rs-a 换入口沿用文件名；rs-b 无文件名回退 tag.srs；rs-c 已一致跳过；local 不动
	if n != 2 || len(changes) != 2 {
		t.Fatalf("应恰好 2 条变更，得到 n=%d changes=%v", n, changes)
	}
	if changes[0]["tag"] != "rs-a" || changes[0]["to"] != "https://new.example.com/rule-set/rs-a.srs" {
		t.Errorf("rs-a 改写不对：%v", changes[0])
	}
	if changes[1]["tag"] != "rs-b" || changes[1]["to"] != "https://new.example.com/rule-set/rs-b.srs" {
		t.Errorf("rs-b 应按 tag.srs 回退：%v", changes[1])
	}
	if !strings.Contains(out, `"path": "/etc/sing-box/lan.json"`) {
		t.Error("local 规则集不应被改动")
	}
	if !strings.HasSuffix(out, "\n") {
		t.Error("输出应以换行结尾（与 /router/apply 口径一致）")
	}
	// 幂等：对改写结果再改一次应零变更
	_, _, n2, err := rewriteRuleSetURLs(out, "https://new.example.com")
	if err != nil || n2 != 0 {
		t.Errorf("二次改写应零变更，得到 n=%d err=%v", n2, err)
	}
}

func TestRewriteRuleSetURLsBadJSON(t *testing.T) {
	if _, _, _, err := rewriteRuleSetURLs(`{route`, "https://x.com"); err == nil || !strings.Contains(err.Error(), "解析配置失败") {
		t.Fatalf("坏 JSON 应报「解析配置失败」，得到 %v", err)
	}
}

// ---- keepStoredPasswords：口令留空沿用旧值 ----

func TestKeepStoredPasswords(t *testing.T) {
	old := ShareConfig{
		SMB:  SMBConfig{Pass: "old-smb"},
		SFTP: SFTPConfig{Pass: "old-sftp"},
	}
	c := ShareConfig{}
	got := keepStoredPasswords(c, old)
	if got.SMB.Pass != "old-smb" || got.SFTP.Pass != "old-sftp" {
		t.Errorf("留空应沿用旧口令：%+v", got)
	}
	c = ShareConfig{SMB: SMBConfig{Pass: "new-smb"}, SFTP: SFTPConfig{Pass: "new-sftp"}}
	got = keepStoredPasswords(c, old)
	if got.SMB.Pass != "new-smb" || got.SFTP.Pass != "new-sftp" {
		t.Errorf("非空应保留新口令：%+v", got)
	}
}

// ---- applyScript / restartScript：远端脚本关键标记与内插 ----

func TestRemoteScripts(t *testing.T) {
	s := applyScript("/tmp/vault-apply-123.json", "abc123")
	for _, marker := range []string{
		"/tmp/vault-apply-123.json", "abc123",
		"CHECK_FAILED", "BACKUP_FAILED", "INSTALL_FAILED", "BACKUP=",
		"APPLIED", "UNHEALTHY_ROLLBACK", "ROLLBACK_OK", "ROLLBACK_FAILED",
	} {
		if !strings.Contains(s, marker) {
			t.Errorf("applyScript 缺标记 %q", marker)
		}
	}
	// 健康判定必须同时看新 pid 与 9090 端口
	if !strings.Contains(s, `"$pid" != "$old"`) || !strings.Contains(s, ":9090 ") {
		t.Error("applyScript 应内嵌「新 pid + 9090 监听」双条件健康判定")
	}
	r := restartScript()
	for _, marker := range []string{"RESTARTED", "RESTART_UNHEALTHY", "downtime_s"} {
		if !strings.Contains(r, marker) {
			t.Errorf("restartScript 缺标记 %q", marker)
		}
	}
}
