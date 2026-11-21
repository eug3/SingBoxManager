package main

// service_test.go — 纯函数单测：规则校验 / 路径安全 / 输出摘要 / 白名单。
// 运行：cd service && go test ./...

import (
	"encoding/json"
	"strings"
	"testing"
)

// ---- parseRules：/publish 的规则结构校验 ----

func TestParseRules(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantErr string // 空 = 期望通过；非空 = 期望错误文案包含它
	}{
		{"正常对象", `{"rules":[{"domain_suffix":["example.com"]}]}`, ""},
		{"JSON字符串形态", "\"{\\\"rules\\\":[{\\\"ip_cidr\\\":[\\\"10.0.0.0/8\\\"]}]}\"", ""},
		{"缺rules", `{"version":1}`, "rules[] required"},
		{"空rules", `{"rules":[]}`, "rules[] required"},
		{"空对象规则", `{"rules":[{}]}`, "non-empty object"},
		{"未知键", `{"rules":[{"port":[443]}]}`, `unknown key "port"`},
		{"值不是数组", `{"rules":[{"domain":"a.com"}]}`, "non-empty array"},
		{"数组含空串", `{"rules":[{"domain":[""]}]}`, "non-empty strings"},
		{"坏JSON", `{rules`, "bad json"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, emsg := parseRules(json.RawMessage(c.input))
			if c.wantErr == "" && emsg != "" {
				t.Fatalf("期望通过，得到错误：%s", emsg)
			}
			if c.wantErr != "" && !strings.Contains(emsg, c.wantErr) {
				t.Fatalf("期望错误含 %q，得到 %q", c.wantErr, emsg)
			}
		})
	}
}

// ---- safeJoin：静态目录防穿越 ----
// 实现把 rel 规范化为 base 内路径（Clean("/"+rel) 会把 .. 收敛到根），
// 安全性质是「结果永远不逃出 base」，而不是「必须报错」。

func TestSafeJoin(t *testing.T) {
	ok := []string{"main.js", "monaco/vs/loader.js", "./a/../b.css"}
	for _, rel := range ok {
		if _, err := safeJoin("/srv/page", rel); err != nil {
			t.Errorf("safeJoin(%q) 不应报错：%v", rel, err)
		}
	}
	base := "/srv/page"
	for _, rel := range []string{"../etc/passwd", "a/../../etc/shadow", "/etc/hosts", "....//....//x"} {
		full, err := safeJoin(base, rel)
		if err != nil {
			continue // 直接拒绝也符合安全性质
		}
		if full != base && !strings.HasPrefix(full, base+"/") {
			t.Errorf("safeJoin(%q) = %q 逃出了 base", rel, full)
		}
	}
}

// ---- 桶名 / 文件名白名单 ----

func TestBucketWhitelist(t *testing.T) {
	for _, n := range []string{"rs-tg", "rs-media", "bard-domains", "rs-custom-2"} {
		if !bucketRe.MatchString(n) {
			t.Errorf("桶名 %q 应合法", n)
		}
	}
	for _, n := range []string{"../rs-tg", "rs-TG", "other", "rs-tg.json"} {
		if bucketRe.MatchString(n) {
			t.Errorf("桶名 %q 应拒绝", n)
		}
	}
	if !rsFileRe.MatchString("rs-tg.srs") || rsFileRe.MatchString("rs-tg.txt") {
		t.Error("rsFileRe 只应放行 .json/.srs")
	}
}

// ---- cleanLine：远端输出摘要 ----

func TestCleanLine(t *testing.T) {
	got := cleanLine("a\r\n\n b \nc\nd\ne\nf\ng\nh")
	want := "a | b | c | d | e | f" // 最多 6 行、去空行与 \r
	if got != want {
		t.Fatalf("cleanLine = %q, want %q", got, want)
	}
	if cleanLine("  \n ") != "" {
		t.Fatal("全空白应得到空串")
	}
}

// ---- trunc：保留尾部 ----

func TestTrunc(t *testing.T) {
	if string(trunc([]byte("abcdef"), 3)) != "def" {
		t.Fatal("trunc 应保留末尾 n 字节")
	}
	if string(trunc([]byte("ab"), 5)) != "ab" {
		t.Fatal("不足 n 字节应原样返回")
	}
}

// ---- 路由 host 白名单与凭据解析 ----

func TestRouterHostsDefault(t *testing.T) {
	t.Setenv("ROUTER_HOSTS", "")
	m := routerHosts()
	if !m["192.168.31.32"] || !m["172.16.8.1"] || len(m) != 2 {
		t.Fatalf("默认白名单应为两台路由，得到 %v", m)
	}
	t.Setenv("ROUTER_HOSTS", " 1.1.1.1 , 2.2.2.2 ,")
	m = routerHosts()
	if !m["1.1.1.1"] || !m["2.2.2.2"] || len(m) != 2 {
		t.Fatalf("自定义白名单解析错误：%v", m)
	}
}

func TestPickRouterMissingFile(t *testing.T) {
	t.Setenv("ROUTERS_FILE", t.TempDir()+"/none.json")
	_, _, err := pickRouter("192.168.31.32")
	if err == nil || !strings.Contains(err.Error(), "未配置路由凭据") {
		t.Fatalf("缺凭据文件应报「未配置路由凭据」（前端门禁触发词），得到 %v", err)
	}
	if _, _, err := pickRouter("  "); err == nil {
		t.Fatal("空 host 应报错")
	}
}
