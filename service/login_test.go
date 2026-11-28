package main

import (
	"bytes"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// loadLogin 的四条路径。重点是两条安全口径：
//  1. 口令永远不出现在日志里（原写法每次启动都打印 loginDefaultPW）；
//  2. 配置文件存在但坏了 → fail-closed（随机口令，页面登录必败），而不是悄悄回落默认口令。

// captureLog 跑 fn 期间收集日志输出
func captureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	old := log.Writer()
	oldFlags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() { log.SetOutput(old); log.SetFlags(oldFlags) }()
	fn()
	return buf.String()
}

func TestLoadLogin_CreatesDefaultWhenMissing_NoPasswordInLog(t *testing.T) {
	path := filepath.Join(t.TempDir(), "login.json")
	t.Setenv("LOGIN_FILE", path)
	out := captureLog(t, loadLogin)
	if currentLogin.Password != loginDefaultPW {
		t.Fatalf("首次启动应用默认口令")
	}
	if strings.Contains(out, loginDefaultPW) {
		t.Fatalf("日志泄露了口令：%q", out)
	}
	if !strings.Contains(out, "默认口令") {
		t.Fatalf("日志应说明当前是默认口令：%q", out)
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("应创建 0600 的配置文件：%v %v", fi, err)
	}
}

func TestLoadLogin_CustomPassword_NotLogged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "login.json")
	c := loginCfg{Password: "my-own-secret-pw", SessionSecret: "s3cret", SessionDays: 3}
	b, _ := json.Marshal(c)
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOGIN_FILE", path)
	out := captureLog(t, loadLogin)
	if currentLogin.Password != "my-own-secret-pw" || currentLogin.SessionDays != 3 {
		t.Fatalf("未按配置加载：%+v", currentLogin)
	}
	// 原写法这里会恒打印「默认口令 rvnc1984」——既泄密又误导
	if strings.Contains(out, "my-own-secret-pw") || strings.Contains(out, loginDefaultPW) {
		t.Fatalf("日志泄露了口令：%q", out)
	}
	if strings.Contains(out, "默认口令") {
		t.Fatalf("自定义口令不应被说成默认口令：%q", out)
	}
}

func TestLoadLogin_BrokenJson_FailClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "login.json")
	if err := os.WriteFile(path, []byte("{ this is not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOGIN_FILE", path)
	out := captureLog(t, loadLogin)
	if currentLogin.Password == loginDefaultPW {
		t.Fatal("配置坏了却回落到默认口令 —— fail-open")
	}
	if currentLogin.Password == "" || len(currentLogin.Password) < 32 {
		t.Fatalf("fail-closed 应使用随机口令，实际长度 %d", len(currentLogin.Password))
	}
	if strings.Contains(out, currentLogin.Password) {
		t.Fatal("日志泄露了随机口令")
	}
	if !strings.Contains(out, "fail-closed") {
		t.Fatalf("日志应明确说明已 fail-closed：%q", out)
	}
}

func TestLoadLogin_EmptyPassword_FailClosed(t *testing.T) {
	path := filepath.Join(t.TempDir(), "login.json")
	if err := os.WriteFile(path, []byte(`{"password":"","sessionSecret":"x","sessionDays":7}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOGIN_FILE", path)
	captureLog(t, loadLogin)
	if currentLogin.Password == loginDefaultPW {
		t.Fatal("口令为空却回落到默认口令 —— fail-open")
	}
}

func TestLoadLogin_Unreadable_FailClosed(t *testing.T) {
	// 用一个文件占住目录名，让 ReadFile 必然失败且不是 IsNotExist
	blocker := filepath.Join(t.TempDir(), "blocked")
	if err := os.WriteFile(blocker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOGIN_FILE", filepath.Join(blocker, "login.json"))
	captureLog(t, loadLogin)
	if currentLogin.Password == loginDefaultPW {
		t.Fatal("读不出配置却回落到默认口令 —— fail-open")
	}
}

func TestLoadLogin_FillsMissingNonSecretFields(t *testing.T) {
	// sessionSecret / sessionDays 缺了只是补默认，不应 fail-closed
	path := filepath.Join(t.TempDir(), "login.json")
	if err := os.WriteFile(path, []byte(`{"password":"pw-ok"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("LOGIN_FILE", path)
	captureLog(t, loadLogin)
	if currentLogin.Password != "pw-ok" {
		t.Fatalf("口令应保持：%q", currentLogin.Password)
	}
	if len(currentLogin.SessionSecret) < 32 {
		t.Fatalf("应补随机 sessionSecret")
	}
	if currentLogin.SessionDays != loginDefaultDay {
		t.Fatalf("应补默认天数：%d", currentLogin.SessionDays)
	}
	// 补上的 sessionSecret 要落盘，否则重启后所有会话失效
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved loginCfg
	if json.Unmarshal(b, &saved) != nil || saved.SessionSecret != currentLogin.SessionSecret {
		t.Fatalf("sessionSecret 未写回文件：%s", b)
	}
}
