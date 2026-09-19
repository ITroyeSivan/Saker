// dsh-hunter store：独立 SQLite（~/.dsh/hunter/hunter.db）
//   - configs：三平台 API key（只存密文值，UI 回显末 4 位）
//   - history：实测流水线历史（可审计）
//   - authorized：用户标记授权的资产白名单（L1 验证只对这些资产执行）
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS configs (
  platform TEXT NOT NULL PRIMARY KEY,
  key_value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  finding_id TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'code-audit',
  query TEXT NOT NULL DEFAULT '',
  platforms TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS authorized (
  key TEXT NOT NULL PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
`;

const PLATFORMS = ["fofa", "hunter", "quake"];
const nowIso = () => new Date().toISOString();

/**
 * 库文件坏了（不是 SQLite 格式）时的自愈：备份原文件再重建空库。
 *
 * 为什么必须有：`new DatabaseSync` 遇到坏文件会直接抛 `file is not a database`，
 * 而 hunter 的**全部功能**（key 配置 / 历史 / 授权白名单）都挂在这个库上 —— 一抛全废。
 * 磁盘满、进程被强杀、网盘/杀软回写、误把别的文件改名成 .db 都会造成这种文件。
 * 数据已经读不出来，能做的是**保住原文件**（改名备份，不删）并让插件继续可用。
 */
function healCorruptDb(dbPath, force = false) {
	if (dbPath === ":memory:") return;
	let head = "";
	try { head = readFileSync(dbPath).subarray(0, 16).toString("latin1"); } catch { return; }
	if (!force && head.startsWith("SQLite format 3")) return;   // 正常的库头
	let bak = dbPath + ".corrupt-" + Date.now();
	let n = 1;
	while (existsSync(bak)) bak = dbPath + ".corrupt-" + Date.now() + "-" + n++;   // 绝不覆盖已有备份
	try {
		renameSync(dbPath, bak);
		// WAL/SHM 属于**已损坏的那个库**：留着会被回放到新库上，导致新库也打不开。
		for (const ext of ["-wal", "-shm"]) {
			try { rmSync(dbPath + ext, { force: true }); } catch { /* 被占用：留给下次启动 */ }
		}
		console.error("[存储] hunter 数据库不是 SQLite 格式，已备份为 " + bak + " 并重建空库（原数据可从此文件找回）");
	} catch (e) {
		// EBUSY（文件被占用）时**不硬来**：如实抛出，让用户看到真实原因。
		console.error("[存储] hunter 数据库损坏且无法备份：" + (e && e.message ? e.message : e) + "（文件被占用时请关闭其它 dsh 实例后重启）");
		throw e;
	}
}

export function openHunterStore(dbPath) {
	if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
	const deadline = Date.now() + 5000;
	let waitMs = 10;
	let db;
	for (;;) {
		try {
			db = new DatabaseSync(dbPath);
			// node:sqlite 在构造时不读文件头，坏库错误要到首条 SQL 才出现。
			db.exec("PRAGMA busy_timeout = 5000;");
			db.exec("PRAGMA journal_mode = WAL;");
			break;
		} catch (error) {
			try { db?.close(); } catch { /* 打开失败时可能没有可关闭的句柄 */ }
			const message = String(error?.message ?? error);
			// journal_mode 首次切换在多进程首开时可能仍报 LOCKED；短退避后重试，不误判坏库。
			if (/database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(message) && Date.now() < deadline) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
				waitMs = Math.min(250, waitMs * 2);
				continue;
			}
			// 只有 SQLite 明确判为 NOTADB 时才备份重建；普通 BUSY/LOCKED 必须原样抛出。
			if (!/not a database|SQLITE_NOTADB/i.test(message)) throw error;
			healCorruptDb(dbPath, true);
			db = new DatabaseSync(dbPath);
			db.exec("PRAGMA busy_timeout = 5000;");
			db.exec("PRAGMA journal_mode = WAL;");
			break;
		}
	}
	db.exec(SCHEMA);
	return {
		dbPath,
		db,
		setKey: db.prepare("INSERT INTO configs (platform, key_value, updated_at) VALUES (?,?,?) ON CONFLICT(platform) DO UPDATE SET key_value=excluded.key_value, updated_at=excluded.updated_at"),
		getKeys: db.prepare("SELECT platform, key_value, updated_at FROM configs"),
		insertHistory: db.prepare("INSERT INTO history (created_at, finding_id, mode, query, platforms, verdict, details) VALUES (?,?,?,?,?,?,?)"),
		listHistory: db.prepare("SELECT * FROM history ORDER BY id DESC LIMIT ?"),
		authorize: db.prepare("INSERT INTO authorized (key, note, created_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET note=excluded.note, created_at=excluded.created_at"),
		unauthorize: db.prepare("DELETE FROM authorized WHERE key = ?"),
		listAuthorized: db.prepare("SELECT key, note, created_at FROM authorized ORDER BY created_at DESC"),
		close: () => { try { db.close(); } catch { /* 已关闭 */ } }
	};
}

/** 配置视图：只返回「是否已配置 + 末 4 位」，绝不回传完整 key。 */
export function configView(store) {
	const rows = store.getKeys.all();
	const out = {};
	for (const p of PLATFORMS) out[p] = { configured: false, tail: "" };
	for (const row of rows) {
		const key = String(row.key_value ?? "");
		out[row.platform] = { configured: key.length > 0, tail: key.length > 4 ? "…" + key.slice(-4) : key };
	}
	return out;
}

export function getKey(store, platform) {
	const row = store.getKeys.all().find((r) => r.platform === platform);
	return row ? String(row.key_value ?? "") : "";
}

export { PLATFORMS, nowIso };
