package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"
)

// bucketEntry 是 /rule-set/index 里的一条桶：名字 + .json/.srs 各自的大小与修改时间（缺哪个就省略）。
type bucketEntry struct {
	Name     string `json:"name"`
	JSONSize int64  `json:"jsonSize,omitempty"`
	JSONTime string `json:"jsonTime,omitempty"`
	SRSSize  int64  `json:"srsSize,omitempty"`
	SRSTime  string `json:"srsTime,omitempty"`
}

// handleRuleSetIndex 列出存储通道（NAS 桶目录）里的规则桶，供管理台下拉使用。
// 直接读目录而不是维护前端硬编码清单：桶的新增/删除/改名后页面自动跟上。
// 只回名字与文件元信息，不读内容；公开只读，口径与 /rule-set/<桶>.json 一致。
func handleRuleSetIndex(w http.ResponseWriter, r *http.Request) {
	fsys := currentShareFS()
	files, err := fsys.List()
	if err != nil {
		fail(w, 503, "存储通道不可用："+errText(err))
		return
	}
	byName := map[string]*bucketEntry{}
	for _, fi := range files {
		if fi.IsDir() {
			continue
		}
		name := fi.Name()
		if !rsFileRe.MatchString(name) {
			continue
		}
		base := strings.TrimSuffix(strings.TrimSuffix(name, ".json"), ".srs")
		e := byName[base]
		if e == nil {
			e = &bucketEntry{Name: base}
			byName[base] = e
		}
		mtime := fi.ModTime().UTC().Format(time.RFC3339)
		if strings.HasSuffix(name, ".json") {
			e.JSONSize, e.JSONTime = fi.Size(), mtime
		} else {
			e.SRSSize, e.SRSTime = fi.Size(), mtime
		}
	}
	list := make([]*bucketEntry, 0, len(byName))
	for _, e := range byName {
		list = append(list, e)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	writeJSON(w, 200, map[string]any{"ok": true, "dir": fsys.Describe(), "buckets": list})
}

// bucketWriteAuth 桶写操作鉴权：管理台页面同源（与 /publish 同口径）或携带密钥（脚本）。
func bucketWriteAuth(w http.ResponseWriter, r *http.Request) bool {
	if publishAllowedOrigin(r) {
		return true
	}
	return routerAuth(w, r, "")
}

// emptyBucketDoc 新桶的初始内容：rules 为空（等用户在页面里填规则后再 /publish 编译 .srs）。
var emptyBucketDoc = []byte("{\n  \"version\": 1,\n  \"rules\": []\n}\n")

// handleRuleSetCreate 新建空桶：只写 <桶>.json，不生成 .srs（空规则无法编译）。
// 鉴权与删除同口径（VAULT_KEY 或路由 clash 密钥）；重名返回 409。
func handleRuleSetCreate(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !bucketWriteAuth(w, r) {
		return
	}
	var req struct {
		Bucket string `json:"bucket"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		fail(w, 400, "bad json")
		return
	}
	name := strings.TrimSpace(req.Bucket)
	if !bucketRe.MatchString(name) {
		fail(w, 400, "桶名不合法："+name+"（只能是 rs-小写字母/数字/- 或 bard-domains）")
		return
	}
	fsys := currentShareFS()
	file := name + ".json"
	if _, err := fsys.Stat(file); err == nil {
		fail(w, 409, "桶已存在："+name)
		return
	}
	if err := fsys.WriteFile(file, emptyBucketDoc); err != nil {
		fail(w, 502, "写入失败："+errText(err))
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "bucket": name})
}

// handleRuleSetRename 重命名桶：.json 与 .srs 一起搬（.srs 不存在就只搬 .json）。
// 鉴权同新建；目标已存在返回 409。先读旧→写新→删旧，失败时按 step 回明确错误。
func handleRuleSetRename(w http.ResponseWriter, r *http.Request) {
	if preflight(w, r) {
		return
	}
	if !bucketWriteAuth(w, r) {
		return
	}
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		fail(w, 400, "bad json")
		return
	}
	from, to := strings.TrimSpace(req.From), strings.TrimSpace(req.To)
	if !bucketRe.MatchString(from) || !bucketRe.MatchString(to) {
		fail(w, 400, "桶名不合法："+from+" → "+to)
		return
	}
	if from == to {
		fail(w, 400, "新旧桶名相同")
		return
	}
	fsys := currentShareFS()
	if _, err := fsys.Stat(from + ".json"); err != nil {
		fail(w, 404, "源桶不存在："+from)
		return
	}
	if _, err := fsys.Stat(to + ".json"); err == nil {
		fail(w, 409, "目标桶已存在："+to)
		return
	}
	// .json：只有源存在时才会走到这里
	data, _, err := fsys.ReadFile(from + ".json")
	if err != nil {
		fail(w, 502, "读取源 json 失败："+errText(err))
		return
	}
	if err := fsys.WriteFile(to+".json", data); err != nil {
		fail(w, 502, "写入新 json 失败："+errText(err))
		return
	}
	if err := fsys.Remove(from + ".json"); err != nil {
		fail(w, 502, "新 json 已写入，但删旧 json 失败："+errText(err))
		return
	}
	// .srs：有就一起搬，没有不影响结果
	if srs, _, err := fsys.ReadFile(from + ".srs"); err == nil {
		if err := fsys.WriteFile(to+".srs", srs); err != nil {
			fail(w, 502, "json 已改名，但写新 srs 失败："+errText(err))
			return
		}
		if err := fsys.Remove(from + ".srs"); err != nil {
			fail(w, 502, "json/srs 已改名，但删旧 srs 失败："+errText(err))
			return
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "from": from, "to": to})
}
