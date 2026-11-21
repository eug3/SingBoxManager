package main

// rules_summary_test.go — summarizeRules 纯函数单测：counts 与免重启/结构分类字段。
// 运行：cd service && go test ./...

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// sampleRulesConfig 内嵌样例：一条 remote + 一条 local 规则集，两条路由规则
// （第一条 rule_set 引用为字符串、缺省 action；第二条为数组引用、显式 action）
const sampleRulesConfig = `{
  "log": {"level": "info"},
  "route": {
    "rule_set": [
      {"tag": "cn-domain", "type": "remote", "format": "binary", "url": "https://example.com/rule-set/cn-domain.srs", "update_interval": "1m"},
      {"tag": "lan-ip", "type": "local", "format": "source", "path": "/etc/sing-box/lan-ip.json"}
    ],
    "rules": [
      {"rule_set": "cn-domain", "outbound": "direct"},
      {"action": "route", "rule_set": ["lan-ip"], "outbound": "direct", "ip_cidr": ["192.168.0.0/16", "10.0.0.0/8"]}
    ],
    "final": "proxy"
  }
}`

func TestSummarizeRules(t *testing.T) {
	cases := []struct {
		name       string
		config     string
		wantErr    string         // 空 = 期望通过；非空 = 期望错误文案包含它
		wantCounts map[string]any // nil = 不校验 counts（错误用例）
		inspect    func(t *testing.T, got map[string]any)
	}{
		{
			name:   "样例配置",
			config: sampleRulesConfig,
			wantCounts: map[string]any{
				"ruleSets": 2, "ruleSetsRemote": 1, "ruleSetsLocal": 1, "routeRules": 2,
			},
			inspect: func(t *testing.T, got map[string]any) {
				sets := got["ruleSets"].([]map[string]any)
				if len(sets) != 2 {
					t.Fatalf("ruleSets 条数 = %d，期望 2", len(sets))
				}
				rsRemote, rsLocal := sets[0], sets[1]
				// remote 桶：免重启标注 + url/format 提取
				if rsRemote["tag"] != "cn-domain" || rsRemote["type"] != "remote" {
					t.Errorf("remote 规则集 tag/type 不对：%v", rsRemote)
				}
				if rsRemote["contentRestartFree"] != true {
					t.Errorf("remote 规则集应 contentRestartFree=true：%v", rsRemote)
				}
				if rsRemote["url"] != "https://example.com/rule-set/cn-domain.srs" || rsRemote["format"] != "binary" {
					t.Errorf("remote 规则集 url/format 提取不对：%v", rsRemote)
				}
				if _, has := rsRemote["path"]; has {
					t.Errorf("remote 规则集不应带 path：%v", rsRemote)
				}
				// local 桶：改内容要重启
				if rsLocal["tag"] != "lan-ip" || rsLocal["type"] != "local" {
					t.Errorf("local 规则集 tag/type 不对：%v", rsLocal)
				}
				if rsLocal["contentRestartFree"] != false {
					t.Errorf("local 规则集应 contentRestartFree=false：%v", rsLocal)
				}
				if rsLocal["path"] != "/etc/sing-box/lan-ip.json" || rsLocal["format"] != "source" {
					t.Errorf("local 规则集 path/format 提取不对：%v", rsLocal)
				}

				rules := got["routeRules"].([]map[string]any)
				if len(rules) != 2 {
					t.Fatalf("routeRules 条数 = %d，期望 2", len(rules))
				}
				r0, r1 := rules[0], rules[1]
				// 两条规则都是结构改动（需重启）
				for i, ru := range rules {
					if ru["structural"] != true {
						t.Errorf("routeRules[%d] 应 structural=true：%v", i, ru)
					}
					if ru["index"] != i {
						t.Errorf("routeRules[%d].index = %v，期望 %d", i, ru["index"], i)
					}
				}
				// 第一条：字符串引用归一化为列表；缺省 action 补 route
				if r0["action"] != "route" || r0["outbound"] != "direct" {
					t.Errorf("r0 action/outbound 不对：%v", r0)
				}
				if !reflect.DeepEqual(r0["ruleSets"], []string{"cn-domain"}) {
					t.Errorf("r0 ruleSets = %v，期望 [cn-domain]", r0["ruleSets"])
				}
				// 第二条：数组引用；其它键进 other，已提取键不重复出现
				if !reflect.DeepEqual(r1["ruleSets"], []string{"lan-ip"}) {
					t.Errorf("r1 ruleSets = %v，期望 [lan-ip]", r1["ruleSets"])
				}
				other := r1["other"].(map[string]any)
				if !reflect.DeepEqual(other["ip_cidr"], []any{"192.168.0.0/16", "10.0.0.0/8"}) {
					t.Errorf("r1 other.ip_cidr 摘要不对：%v", other["ip_cidr"])
				}
				for _, k := range []string{"action", "outbound", "rule_set"} {
					if _, has := other[k]; has {
						t.Errorf("r1 other 不应重复包含已提取键 %q：%v", k, other)
					}
				}
			},
		},
		{
			name:   "无route段",
			config: `{"log":{"level":"info"}}`,
			wantCounts: map[string]any{
				"ruleSets": 0, "ruleSetsRemote": 0, "ruleSetsLocal": 0, "routeRules": 0,
			},
		},
		{
			name:   "空route",
			config: `{"route":{}}`,
			wantCounts: map[string]any{
				"ruleSets": 0, "ruleSetsRemote": 0, "ruleSetsLocal": 0, "routeRules": 0,
			},
		},
		{
			name:    "坏JSON",
			config:  `{route`,
			wantErr: "解析配置失败",
		},
		{
			name:   "inline规则集按local口径",
			config: `{"route":{"rule_set":[{"tag":"inline-rs","type":"inline","source":{"rules":[]}}]}}`,
			wantCounts: map[string]any{
				"ruleSets": 1, "ruleSetsRemote": 0, "ruleSetsLocal": 1, "routeRules": 0,
			},
			inspect: func(t *testing.T, got map[string]any) {
				rs := got["ruleSets"].([]map[string]any)[0]
				if rs["contentRestartFree"] != false {
					t.Errorf("inline 内容在 config 里，应 contentRestartFree=false：%v", rs)
				}
			},
		},
		{
			name:   "缺省type按local",
			config: `{"route":{"rule_set":[{"tag":"no-type","path":"/tmp/x.json"}]}}`,
			wantCounts: map[string]any{
				"ruleSets": 1, "ruleSetsRemote": 0, "ruleSetsLocal": 1, "routeRules": 0,
			},
			inspect: func(t *testing.T, got map[string]any) {
				rs := got["ruleSets"].([]map[string]any)[0]
				if rs["type"] != "local" || rs["contentRestartFree"] != false {
					t.Errorf("缺省 type 应补 local 且不免重启：%v", rs)
				}
			},
		},
		{
			name: "logical嵌套与长列表摘要",
			config: `{"route":{"rules":[
				{"type":"logical","mode":"or","rules":[
					{"rule_set":"a","outbound":"direct"},
					{"action":"reject","domain_suffix":["d0","d1","d2","d3","d4","d5","d6","d7","d8","d9"]}
				]}
			]}}`,
			wantCounts: map[string]any{
				"ruleSets": 0, "ruleSetsRemote": 0, "ruleSetsLocal": 0, "routeRules": 1,
			},
			inspect: func(t *testing.T, got map[string]any) {
				ru := got["routeRules"].([]map[string]any)[0]
				other := ru["other"].(map[string]any)
				if other["type"] != "logical" || other["mode"] != "or" {
					t.Errorf("logical 的 type/mode 应留在 other：%v", other)
				}
				subs, ok := other["rules"].([]map[string]any)
				if !ok || len(subs) != 2 {
					t.Fatalf("嵌套子规则应递归摘要为 2 条：%v", other["rules"])
				}
				if subs[0]["structural"] != true || subs[1]["action"] != "reject" {
					t.Errorf("子规则摘要不对：%v", subs)
				}
				// 超过阈值的长列表只留 count+sample
				long := subs[1]["other"].(map[string]any)["domain_suffix"]
				want := map[string]any{"count": 10, "sample": []any{"d0", "d1", "d2"}}
				if !reflect.DeepEqual(long, want) {
					t.Errorf("长列表摘要 = %v，期望 %v", long, want)
				}
			},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := summarizeRules(c.config)
			if c.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("期望错误含 %q，得到 %v", c.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("期望通过，得到错误：%v", err)
			}
			if c.wantCounts != nil {
				counts := got["counts"].(map[string]any)
				if !reflect.DeepEqual(counts, c.wantCounts) {
					t.Errorf("counts = %v，期望 %v", counts, c.wantCounts)
				}
			}
			// 摘要必须可 JSON 序列化（handler 直接 writeJSON）
			if _, merr := json.Marshal(got); merr != nil {
				t.Fatalf("摘要无法序列化：%v", merr)
			}
			if c.inspect != nil {
				c.inspect(t, got)
			}
		})
	}
}
