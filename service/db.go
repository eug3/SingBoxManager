package main

// db.go — SQLite 后端（纯 Go 驱动 modernc.org/sqlite，无 CGO，可交叉编译）。
//
// 取代散落的 JSON 文件：存储配置、路由 SSH 凭据、发布记录、配置应用记录都进库。
// 位置：/etc/vault-edit/sbm.db（0600，WAL）；可用 DB_FILE 覆盖。
//
// 首次启动时如果库是空的，会自动把旧的 share.json / routers.json 导入（一次性迁移），
// 之后以库为准；旧文件留着不删，方便回滚。
//
// 表：
//   kv(key, value, updated_at)                     —— 存储配置等键值
//   routers(host, name, user, password, port, ...) —— 路由 SSH 凭据
//   publish_log(id, bucket, json_bytes, srs_bytes, sha256, actor, ts)
//   apply_log(id, host, changed, sha_from, sha_to, backup, ms, actor, ts)

import (
	"database/sql"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

var (
	dbOnce sync.Once
	dbConn *sql.DB
	dbErr  error
)

// dbFile 数据库文件路径（可用 DB_FILE 覆盖，默认 /etc/vault-edit/sbm.db）
func dbFile() string { return env("DB_FILE", "/etc/vault-edit/sbm.db") }

// db 惰性打开（进程内单例），并建表 + 迁移。
// 返回 (连接, 错误)：打开失败时连接为 nil，错误只发生一次（sync.Once），
// 之后所有调用都拿到同一份结果，不会反复重试。
func db() (*sql.DB, error) {
	dbOnce.Do(func() {
		path := dbFile()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			dbErr = err
			return
		}
		conn, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
		if err != nil {
			dbErr = err
			return
		}
		conn.SetMaxOpenConns(1) // SQLite 单写者，串行化最省心
		if _, err := conn.Exec(schemaSQL); err != nil {
			dbErr = err
			_ = conn.Close()
			return
		}
		_ = os.Chmod(path, 0o600)
		dbConn = conn
		if err := migrateFromFiles(conn); err != nil {
			log.Printf("旧文件迁移失败（忽略，继续用库）：%v", err)
		}
	})
	return dbConn, dbErr
}

const schemaSQL = `
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routers (
  host       TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  user       TEXT NOT NULL DEFAULT 'root',
  password   TEXT NOT NULL DEFAULT '',
  port       INTEGER NOT NULL DEFAULT 22,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS publish_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket     TEXT NOT NULL,
  json_bytes INTEGER NOT NULL,
  srs_bytes  INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  actor      TEXT NOT NULL DEFAULT '',
  ts         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS apply_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  host       TEXT NOT NULL,
  changed    INTEGER NOT NULL,
  sha_from   TEXT NOT NULL DEFAULT '',
  sha_to     TEXT NOT NULL DEFAULT '',
  backup     TEXT NOT NULL DEFAULT '',
  ms         INTEGER NOT NULL DEFAULT 0,
  actor      TEXT NOT NULL DEFAULT '',
  ts         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publish_ts ON publish_log(ts);
CREATE INDEX IF NOT EXISTS idx_apply_ts   ON apply_log(ts);
`

// nowStr 当前时间的 RFC3339 文本（各表 updated_at/ts 统一用它）
func nowStr() string { return time.Now().Format(time.RFC3339) }

// ---- kv ----

// kvGet 读键值；键不存在或库不可用都返回 ("", false)，调用方按「未配置」兜底
func kvGet(key string) (string, bool) {
	conn, err := db()
	if err != nil {
		return "", false
	}
	var v string
	if err := conn.QueryRow(`SELECT value FROM kv WHERE key=?`, key).Scan(&v); err != nil {
		return "", false
	}
	return v, true
}

// kvSet 写键值（upsert）；库不可用或写失败返回 error
func kvSet(key, value string) error {
	conn, err := db()
	if err != nil {
		return err
	}
	return kvSetRaw(conn, key, value)
}

// kvSetRaw 直接对给定连接写（迁移阶段用，避免 dbOnce 重入死锁）
func kvSetRaw(conn *sql.DB, key, value string) error {
	_, err := conn.Exec(
		`INSERT INTO kv(key,value,updated_at) VALUES(?,?,?)
		 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
		key, value, nowStr(),
	)
	return err
}

// ---- 路由凭据 ----

// routersFromDB 读全部路由凭据（host → 凭据）；user/port 缺省补 root/22。
// 库不可用或查询失败返回 error；空表返回空 map（不是 error）。
func routersFromDB() (map[string]routerCred, error) {
	conn, err := db()
	if err != nil {
		return nil, err
	}
	rows, err := conn.Query(`SELECT host,name,user,password,port FROM routers`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]routerCred{}
	for rows.Next() {
		var host string
		var c routerCred
		if err := rows.Scan(&host, &c.Name, &c.User, &c.Password, &c.Port); err != nil {
			return nil, err
		}
		if c.User == "" {
			c.User = "root"
		}
		if c.Port == 0 {
			c.Port = 22
		}
		out[host] = c
	}
	return out, rows.Err()
}

// routersToDB 整表 upsert 路由凭据（事务内逐台写入）
func routersToDB(m map[string]routerCred) error {
	conn, err := db()
	if err != nil {
		return err
	}
	return routersToDBRaw(conn, m)
}

// routersToDBRaw 直接对给定连接写（迁移阶段用）
func routersToDBRaw(conn *sql.DB, m map[string]routerCred) error {
	tx, err := conn.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for host, c := range m {
		if _, err := tx.Exec(
			`INSERT INTO routers(host,name,user,password,port,updated_at) VALUES(?,?,?,?,?,?)
			 ON CONFLICT(host) DO UPDATE SET name=excluded.name, user=excluded.user,
			   password=excluded.password, port=excluded.port, updated_at=excluded.updated_at`,
			host, c.Name, c.User, c.Password, c.Port, nowStr(),
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// routerDeleteDB 删除一台路由的凭据；host 不存在时不报错（DELETE 幂等）
func routerDeleteDB(host string) error {
	conn, err := db()
	if err != nil {
		return err
	}
	_, err = conn.Exec(`DELETE FROM routers WHERE host=?`, host)
	return err
}

// ---- 日志表 ----

// logPublish 留痕一次发布（桶名/双文件字节数/srs 摘要）。
// 尽力而为：库不可用或写失败只打日志，绝不影响发布主流程。
func logPublish(bucket string, jsonBytes, srsBytes int, sha string) {
	conn, err := db()
	if err != nil {
		return
	}
	_, err = conn.Exec(`INSERT INTO publish_log(bucket,json_bytes,srs_bytes,sha256,ts) VALUES(?,?,?,?,?)`,
		bucket, jsonBytes, srsBytes, sha, nowStr())
	if err != nil {
		log.Printf("写 publish_log 失败：%v", err)
	}
}

// logApply 留痕一次配置应用/重启（是否变更/前后摘要/备份路径/耗时）。
// 与 logPublish 同样是尽力而为，失败只打日志。
func logApply(host string, changed bool, shaFrom, shaTo, backup string, ms int64) {
	conn, err := db()
	if err != nil {
		return
	}
	_, err = conn.Exec(`INSERT INTO apply_log(host,changed,sha_from,sha_to,backup,ms,ts) VALUES(?,?,?,?,?,?,?)`,
		host, boolInt(changed), shaFrom, shaTo, backup, ms, nowStr())
	if err != nil {
		log.Printf("写 apply_log 失败：%v", err)
	}
}

// logApplyWrap 供 handler 调用：把 res.Log 里的 backup= 抽出来一起留痕
func logApplyWrap(host string, changed bool, shaFrom, shaTo, detail string, ms int64) {
	backup := ""
	for _, line := range strings.Split(detail, "\n") {
		if strings.HasPrefix(line, "BACKUP=") {
			backup = strings.TrimPrefix(line, "BACKUP=")
		}
	}
	logApply(host, changed, shaFrom, shaTo, backup, ms)
	log.Printf("router op %s changed=%v (%dms) %s", host, changed, ms, cleanLine(detail))
}

// boolInt bool → 0/1（SQLite 没有布尔列，changed 用整数存）
func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// dbStats 给 /db/info 与页面用：库文件路径、四张表行数、最近发布/应用时间。
// 库不可用或任一计数查询失败返回 error；最近时间查询失败则留空串。
func dbStats() (map[string]any, error) {
	conn, err := db()
	if err != nil {
		return nil, err
	}
	out := map[string]any{"file": dbFile()}
	for _, t := range []string{"kv", "routers", "publish_log", "apply_log"} {
		var n int
		if err := conn.QueryRow(`SELECT COUNT(*) FROM ` + t).Scan(&n); err != nil {
			return nil, err
		}
		out[t] = n
	}
	var lastPublish, lastApply string
	_ = conn.QueryRow(`SELECT COALESCE(MAX(ts),'') FROM publish_log`).Scan(&lastPublish)
	_ = conn.QueryRow(`SELECT COALESCE(MAX(ts),'') FROM apply_log`).Scan(&lastApply)
	out["lastPublish"] = lastPublish
	out["lastApply"] = lastApply
	return out, nil
}

// recentPublishes 最近 limit 条发布记录（新→旧），给页面显示最近动作。
// 库不可用或查询失败返回 nil（页面按空列表渲染）。
func recentPublishes(limit int) []map[string]any {
	conn, err := db()
	if err != nil {
		return nil
	}
	rows, err := conn.Query(`SELECT bucket,json_bytes,srs_bytes,sha256,ts FROM publish_log ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var bucket, sha, ts string
		var jb, sb int
		if err := rows.Scan(&bucket, &jb, &sb, &sha, &ts); err == nil {
			out = append(out, map[string]any{"bucket": bucket, "json": jb, "srs": sb, "sha256": sha, "ts": ts})
		}
	}
	return out
}

// migrateFromFiles 一次性把旧的 JSON 文件导入库（只在对应表为空时）
func migrateFromFiles(conn *sql.DB) error {
	// 存储配置
	var kvCount int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM kv WHERE key='shareConfig'`).Scan(&kvCount); err == nil && kvCount == 0 {
		if b, err := os.ReadFile(shareConfigFile()); err == nil && len(b) > 0 {
			if err := kvSetRaw(conn, "shareConfig", string(b)); err != nil {
				return err
			}
			log.Printf("已从 %s 迁移存储配置到 SQLite", shareConfigFile())
		}
	}
	// 路由凭据
	var rCount int
	if err := conn.QueryRow(`SELECT COUNT(*) FROM routers`).Scan(&rCount); err == nil && rCount == 0 {
		if all, err := loadRoutersFile(); err == nil && len(all) > 0 {
			if err := routersToDBRaw(conn, all); err != nil {
				return err
			}
			log.Printf("已从 %s 迁移 %d 台路由凭据到 SQLite", routersFile(), len(all))
		}
	}
	return nil
}

// dbHealthy 给 /health 快速判断：库能打开且 SELECT 1 成功 → (true, "")；
// 否则 (false, 错误文案)。
func dbHealthy() (bool, string) {
	if _, err := db(); err != nil {
		return false, err.Error()
	}
	var one int
	if err := dbConn.QueryRow(`SELECT 1`).Scan(&one); err != nil {
		return false, err.Error()
	}
	return true, ""
}
