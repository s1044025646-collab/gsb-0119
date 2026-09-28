import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    product TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wafers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lot_id INTEGER NOT NULL REFERENCES lots(id),
    slot INTEGER NOT NULL,
    diameter_mm REAL NOT NULL DEFAULT 300,
    die_x_mm REAL NOT NULL DEFAULT 10,
    die_y_mm REAL NOT NULL DEFAULT 10,
    edge_excl_mm REAL NOT NULL DEFAULT 3,
    status TEXT NOT NULL DEFAULT 'active', -- active | scrapped
    created_at TEXT NOT NULL,
    UNIQUE(lot_id, slot)
  );
  CREATE TABLE IF NOT EXISTS test_programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(name, version)
  );
  CREATE TABLE IF NOT EXISTS defect_classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS process_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    step_id INTEGER NOT NULL REFERENCES process_steps(id),
    code TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS chambers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id INTEGER NOT NULL REFERENCES tools(id),
    code TEXT NOT NULL,
    UNIQUE(tool_id, code)
  );
  CREATE TABLE IF NOT EXISTS wafer_step_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wafer_id INTEGER NOT NULL REFERENCES wafers(id),
    step_id INTEGER NOT NULL REFERENCES process_steps(id),
    tool_id INTEGER NOT NULL REFERENCES tools(id),
    chamber_id INTEGER NOT NULL REFERENCES chambers(id),
    ran_at TEXT NOT NULL,
    UNIQUE(wafer_id, step_id)
  );
  CREATE TABLE IF NOT EXISTS die_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wafer_id INTEGER NOT NULL REFERENCES wafers(id),
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    program_id INTEGER NOT NULL REFERENCES test_programs(id),
    kind TEXT NOT NULL DEFAULT 'prime', -- prime | retest
    passed INTEGER NOT NULL,
    defect_class_id INTEGER REFERENCES defect_classes(id),
    tested_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_die_wafer ON die_results(wafer_id, x, y);
  CREATE TABLE IF NOT EXISTS manual_fa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wafer_id INTEGER NOT NULL REFERENCES wafers(id),
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    defect_class_id INTEGER NOT NULL REFERENCES defect_classes(id),
    analyst TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS analysis_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope TEXT NOT NULL,           -- wafer | lot
    scope_id INTEGER NOT NULL,
    version_no INTEGER NOT NULL,
    reason TEXT NOT NULL,          -- retest_flip | program_change | scrap | lot_split | initial | fa_update
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft', -- draft | approved
    created_at TEXT NOT NULL,
    UNIQUE(scope, scope_id, version_no)
  );
  CREATE TABLE IF NOT EXISTS lot_splits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_lot_id INTEGER NOT NULL REFERENCES lots(id),
    to_lot_id INTEGER NOT NULL REFERENCES lots(id),
    created_at TEXT NOT NULL
  );
  `,
];

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

// 可重复执行：user_version 记录已应用的迁移
export function migrate(db: DB): void {
  db.exec("PRAGMA user_version;");
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let v = row.user_version;
  while (v < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    v++;
  }
}

const txDepth = new WeakMap<DB, number>();

// 事务边界：并发写入统一走 withTx；支持嵌套（内层并入外层事务）
export function withTx<T>(db: DB, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth > 0) {
    txDepth.set(db, depth + 1);
    try { return fn(); } finally { txDepth.set(db, depth); }
  }
  db.exec("BEGIN IMMEDIATE");
  txDepth.set(db, 1);
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    txDepth.set(db, 0);
  }
}
