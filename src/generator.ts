import type { DatabaseSync } from "node:sqlite";
import { nowIso, withTransaction } from "./db.js";
import { mulberry32 } from "./rng.js";

export interface DemoOptions {
  db: DatabaseSync;
  seed?: string | number;
  now?: () => Date;
  radius?: number;
}

export function generateDemoData(options: DemoOptions): void {
  const { db } = options;
  const rng = mulberry32(options.seed ?? "wafer-demo");
  const now = options.now ?? (() => new Date());
  const radius = options.radius ?? 10;
  const ts = nowIso(now);
  withTransaction(db, () => {
    db.prepare("INSERT OR IGNORE INTO defect_categories(code,name) VALUES (?,?)").run("SCRATCH", "Scratch");
    db.prepare("INSERT OR IGNORE INTO defect_categories(code,name) VALUES (?,?)").run("PARTICLE", "Particle cluster");
    db.prepare("INSERT OR IGNORE INTO defect_categories(code,name) VALUES (?,?)").run("RANDOM", "Random defect");
    db.prepare("INSERT OR IGNORE INTO defect_categories(code,name) VALUES (?,?)").run("EDGE", "Edge defect");
    for (const [id, name] of [[1, "MCU-A"], [2, "MCU-B"]] as const) {
      db.prepare("INSERT OR IGNORE INTO products(id,name,created_at) VALUES(?,?,?)").run(id, name, ts);
    }
    for (const [id, product, name, version] of [[1, 1, "ft", "1.0"], [2, 1, "ft", "1.1"], [3, 2, "ft", "1.0"]] as const) {
      db.prepare("INSERT OR IGNORE INTO test_programs(id,product_id,name,version,activated_at) VALUES(?,?,?,?,?)").run(id, product, name, version, ts);
    }
    for (const [id, step, name] of [[1, "etch", "ETCH-1"], [2, "etch", "ETCH-2"], [3, "dep", "DEP-1"]] as const) {
      db.prepare("INSERT OR IGNORE INTO equipment(id,name,process_step) VALUES(?,?,?)").run(id, name, step);
    }
    for (const [id, equipment, name] of [[1, 1, "A"], [2, 1, "B"], [3, 2, "A"]] as const) {
      db.prepare("INSERT OR IGNORE INTO chambers(id,equipment_id,name) VALUES(?,?,?)").run(id, equipment, name);
    }
    db.prepare("INSERT OR IGNORE INTO batches(id,name,product_id,status,created_at) VALUES(?,?,?,?,?)").run(1, "B-1001", 1, "active", ts);
    db.prepare("INSERT OR IGNORE INTO batches(id,name,product_id,parent_batch_id,status,created_at) VALUES(?,?,?,?,?,?)").run(2, "B-1001-S1", 1, 1, "split", ts);
    db.prepare("INSERT OR IGNORE INTO batches(id,name,product_id,status,created_at) VALUES(?,?,?,?,?)").run(3, "B-2001", 2, "active", ts);
    createWafer(db, rng, 1, 1, 1, radius, ts, 1, 1, 1, "active");
    createWafer(db, rng, 2, 1, 2, radius, ts, 1, 1, 2, "active");
    createWafer(db, rng, 3, 2, 1, radius, ts, 2, 1, 2, "active");
    createWafer(db, rng, 4, 3, 1, radius, ts, 3, 2, 3, "active");
    seedWaferTests(db, rng, radius, ts);
  });
}

function createWafer(
  db: DatabaseSync,
  rng: () => number,
  id: number,
  batchId: number,
  slot: number,
  radius: number,
  ts: string,
  programId: number,
  equipmentId: number,
  chamberId: number,
  status: "active" | "scrapped",
): void {
  db.prepare("INSERT OR IGNORE INTO wafers(id,batch_id,slot,radius_units,edge_margin,status,created_at,scrapped_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(id, batchId, slot, radius, 1.0, status, ts, status === "scrapped" ? ts : null);
  db.prepare("DELETE FROM dies WHERE wafer_id=?").run(id);
  const insertDie = db.prepare("INSERT INTO dies(id,wafer_id,x,y,valid) VALUES(?,?,?,?,?)");
  let dieId = id * 10000;
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      if (Math.max(Math.abs(x), Math.abs(y)) === radius && rng() < 0.12) continue;
      const valid = Math.hypot(x, y) <= radius - 1 ? 1 : 0;
      insertDie.run(dieId += 1, id, x, y, valid);
    }
  }
  db.prepare("INSERT OR IGNORE INTO process_events(id,wafer_id,process_step,equipment_id,chamber_id,product_id,occurred_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, id, "etch", equipmentId, chamberId, batchId === 3 ? 2 : 1, ts);
}

function seedWaferTests(db: DatabaseSync, rng: () => number, radius: number, ts: string): void {
  db.exec("DELETE FROM tests");
  const insert = db.prepare("INSERT INTO tests(die_id,program_id,kind,attempt,passed,defect_code,tested_at,raw_payload) VALUES(?,?,?,?,?,?,?,?)");
  const dies = db.prepare("SELECT id,x,y,valid FROM dies WHERE valid=1 ORDER BY x,y").all() as Array<{ id: number; x: number; y: number; valid: number }>;
  for (const die of dies) {
    if (die.id >= 40000 && rng() < 0.04) {
      insert.run(die.id, 3, "initial", 1, 0, "RANDOM", ts, "{}");
    } else if (die.id < 20000 && Math.hypot(die.x, die.y) > radius - 2.1) {
      insert.run(die.id, 1, "initial", 1, 0, "EDGE", ts, "{}");
    } else if (die.id >= 20000 && die.id < 30000 && die.y === 0 && Math.abs(die.x) < 7) {
      insert.run(die.id, 1, "initial", 1, 0, "SCRATCH", ts, "{}");
    } else if (die.id >= 30000 && die.id < 40000 && Math.hypot(die.x - 3, die.y + 2) < 2.1) {
      insert.run(die.id, 2, "initial", 1, 0, "PARTICLE", ts, "{}");
    } else if (rng() < 0.015) {
      insert.run(die.id, die.id < 40000 ? 1 : 3, "initial", 1, 0, "RANDOM", ts, "{}");
    } else {
      insert.run(die.id, die.id < 40000 ? 1 : 3, "initial", 1, 1, null, ts, "{}");
    }
  }
  const improving = dies.find((die) => die.id >= 20000 && die.id < 30000 && die.x === 0 && die.y === 0);
  if (improving) insert.run(improving.id, 2, "retest", 1, 1, null, ts, "{}");
  const duplicate = dies.find((die) => die.id >= 40000);
  if (duplicate) insert.run(duplicate.id, 3, "initial", 1, 1, null, ts, "{}");
}
