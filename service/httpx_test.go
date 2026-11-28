package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 请求体上限：超限的 JSON 必须被拒，而不是被整个读进内存。
// 原先 11 处接口是裸 json.NewDecoder(r.Body)，无上限。
func TestReadJSON_RejectsOversizedBody(t *testing.T) {
	// 构造一个合法但超过 jsonBodyMax 的 JSON：{"pad":"xxxx..."}
	big := `{"pad":"` + strings.Repeat("x", jsonBodyMax+16) + `"}`
	var req struct {
		Pad string `json:"pad"`
	}
	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader([]byte(big)))
	w := httptest.NewRecorder()
	if readJSON(w, r, &req) {
		t.Fatal("超过上限的请求体不应解析成功")
	}
	if w.Code != http.StatusBadRequest {
		t.Fatalf("应回 400，实际 %d", w.Code)
	}
}

func TestReadJSON_AcceptsNormalBody(t *testing.T) {
	var req struct {
		Host string `json:"host"`
	}
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"host":"192.168.1.1"}`))
	w := httptest.NewRecorder()
	if !readJSON(w, r, &req) || req.Host != "192.168.1.1" {
		t.Fatalf("正常请求体应解析成功：%+v", req)
	}
	if w.Body.Len() != 0 {
		t.Fatalf("成功时不应写应答体（否则后续 writeJSON 双写）：%q", w.Body.String())
	}
}

// lenient 版：解析失败不写应答（否则 /router/restart 这类「body 可省略」的接口会双写）
func TestReadJSONLenient_NoResponseOnFailure(t *testing.T) {
	var req struct {
		Host string `json:"host"`
	}
	for _, body := range []string{"", "not json", `{"host":"x"} trailing garbage that is not valid json at all`} {
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		w := httptest.NewRecorder()
		_ = readJSONLenient(w, r, &req)
		if w.Body.Len() != 0 || w.Code != http.StatusOK {
			t.Fatalf("lenient 版失败时不应写应答（body=%q）：code=%d body=%q", body, w.Code, w.Body.String())
		}
	}
	// 合法 body 仍要能解出来
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"host":"y"}`))
	w := httptest.NewRecorder()
	if !readJSONLenient(w, r, &req) || req.Host != "y" {
		t.Fatalf("lenient 版应能解析合法 body：%+v", req)
	}
}

// 超限在 lenient 路径同样生效（不能因为「宽容」就没有上限）
func TestReadJSONLenient_StillLimited(t *testing.T) {
	big := `{"pad":"` + strings.Repeat("x", jsonBodyMax+16) + `"}`
	var req map[string]any
	r := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader([]byte(big)))
	w := httptest.NewRecorder()
	if readJSONLenient(w, r, &req) {
		t.Fatal("lenient 版也必须拒绝超限请求体")
	}
}
