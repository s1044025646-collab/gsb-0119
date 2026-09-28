import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS products(
    id INTEGER PRIMARY KEY CHECK(id > 0),
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS batches(
    id INTEGER PRIMARY KEY CHECK(id > 0),
    name TEXT NOT NULL UNIQUE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    parent_batch_id INTEGER REFERENCES batches(id),
    status TEXT NOT NULL CHECK(status IN ('active','split','closed')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wafers(
    id INTEGER PRIMARY KEY CHECK(id > 0),
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    slot INTEGER NOT NULL,
    radius_units REAL NOT NULL CHECK(radius_units > 0),
    edge_margin REAL NOT NULL DEFAULT 0 CHECK(edge_margin >= 0),
    status TEXT NOT NULL CHECK(status IN ('active','scrapped')),
    scrapped_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(batch_id, slot)
  );
  CREATE TABLE IF NOT EXISTS dies(
    id INTEGER PRIMARY KEY CHECK(id > 0),
    wafer_id INTEGER NOT NULL REFERENCES wafers(id),
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    valid INTEGER NOT NULL CHECK(valid IN (0,1)),
    UNIQUE(wafer_id,x,y)
  );
  CREATE INDEX IF NOT EXISTS idx_dies_wafer_valid ON dies(wafer_id, valid);
  CREATE TABLE IF NOT EXISTS test_programs(
    id INTEGER PRIMARY KEY CHECK(id > 0),
    product_id INTEGER NOT NULL REFERENCES products(id),
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    activated_at TEXT NOT NULL,
    UNIQUE(product_id,name,version)
  );
  CREATE TABLE IF NOT EXISTS equipment(
    id INTEGER PRIMARY KEY CHECK(id > 0),
    name TEXT NOT NULL UNIQUE,
    process_step TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chambers(
    id INTEGER PRIMARY KEY CHECK(id > 0),
    equipment_id INTEGER NOT NULL REFERENCES equipment(id),
    name TEXT NOT NULL,
    UNIQUE(equipment_id,name)
  );
  CREATE TABLE IF NOT EXISTS process_events(
    id INTEGER PRIMARY KEY CHECK(id > 0),
    wafer_id INTEGER NOT NULL REFERENCES wafers(id),
    process_step TEXT NOT NULL,
    equipment_id INTEGER NOT NULL REFERENCES equipment(id),
    chamber_id INTEGER REFERENCES chambers(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    occurred_at TEXT NOT NULL,
    UNIQUE(wafer_id,process_step)
  );
  CREATE INDEX IF NOT EXISTS idx_process_group ON process_events(process_step, equipment_id, chamber_id);
  CREATE TABLE IF NOT EXISTS defect_categories(
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tests(
    id INTEGER PRIMARY KEY CHECK(id > 0),
    die_id INTEGER NOT NULL REFERENCES dies(id),
    program_id INTEGER NOT NULL REFERENCES test_programs(id),
    kind TEXT NOT NULL CHECK(kind IN ('initial','retest')),
    attempt INTEGER NOT NULL CHECK(attempt >= 1),
    passed INTEGER NOT NULL CHECK(passed IN (0,1)),
    defect_code TEXT REFERENCES defect_categories(code),
    tested_at TEXT NOT NULL,
    raw_payload TEXT NOT NULL DEFAULT '{}',
    source_ref TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tests_die_time ON tests(die_id,tested_at,id);
  CREATE TABLE IF NOT EXISTS failure_analyses(
    id INTEGER PRIMARY KEY CHECK(id > 0),
    die_id INTEGER NOT NULL REFERENCES dies(id),
    analyst TEXT NOT NULL,
    finding TEXT NOT NULL,
    root_cause_code TEXT,
    reviewed INTEGER NOT NULL DEFAULT 0 CHECK(reviewed IN (0,1)),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS analyses(
    id INTEGER PRIMARY KEY CHECK(id > 0),
    scope_type TEXT NOT NULL CHECK(scope_type IN ('wafer','batch')),
    wafer_id INTEGER REFERENCES wafers(id),
    batch_id INTEGER REFERENCES batches(id),
    version INTEGER NOT NULL,
    parent_analysis_id INTEGER REFERENCES analyses(id),
    trigger TEXT NOT NULL CHECK(trigger IN ('initial','retest','program_change','wafer_scrap','batch_split','manual')),
    triggered_by TEXT,
    result_json TEXT NOT NULL,
    reviewed INTEGER NOT NULL DEFAULT 0 CHECK(reviewed IN (0,1)),
    created_at TEXT NOT NULL,
    UNIQUE(scope_type,wafer_id,batch_id,version)
  );
  CREATE INDEX IF NOT EXISTS idx_analyses_chain ON analyses(parent_analysis_id);
  `);
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function nowIso(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}
