import { DB, withTx } from "./db";
import { isoNow, rand } from "./util/clock";
import { dieGeometry } from "./domain/geometry";
import * as svc from "./service";

// 全部为虚构数据。随机性通过 util/clock 注入，测试可复现。
export interface SeedOptions {
  scenario?: "edge_ring" | "scratch" | "random" | "mixed";
  waferCount?: number;
  includeRetestImprovement?: boolean;
  includeDuplicates?: boolean;
  includeMissingCoords?: boolean;
  includeChamberChangeover?: boolean;
}

export function seed(db: DB, opts: SeedOptions = {}) {
  const scenario = opts.scenario ?? "mixed";
  const waferCount = opts.waferCount ?? 6;
  return withTx(db, () => {
    const t = isoNow();
    db.prepare("INSERT OR IGNORE INTO lots(name,product,status,created_at) VALUES ('LOT-FIC-001','P-A','active',?)").run(t);
    db.prepare("INSERT OR IGNORE INTO lots(name,product,status,created_at) VALUES ('LOT-FIC-002','P-B','active',?)").run(t);
    db.prepare("INSERT OR IGNORE INTO test_programs(name,version,created_at) VALUES ('FT','1.0',?)").run(t);
    db.prepare("INSERT OR IGNORE INTO defect_classes(code,name) VALUES ('PARTICLE','颗粒'),('SCRATCH','划痕'),('EDGE','边缘失效')").run();
    db.prepare("INSERT OR IGNORE INTO process_steps(id,name) VALUES (1,'ETCH')").run();
    db.prepare("INSERT OR IGNORE INTO tools(id,step_id,code) VALUES (1,1,'ETCH-01')").run();
    db.prepare("INSERT OR IGNORE INTO chambers(id,tool_id,code) VALUES (1,1,'A'),(2,1,'B')").run();

    const programId = 1;
    const waferIds: number[] = [];
    for (let i = 0; i < waferCount; i++) {
      const lotId = i < waferCount / 2 ? 1 : 2;
      db.prepare("INSERT OR IGNORE INTO wafers(lot_id,slot,status,created_at) VALUES (?,?, 'active', ?)")
        .run(lotId, i + 1, t);
      const w = db.prepare("SELECT * FROM wafers WHERE lot_id=? AND slot=?").get(lotId, i + 1) as any;
      waferIds.push(w.id);
      // 腔室换线：前半 A 腔，后半 B 腔
      const chamberId = opts.includeChamberChangeover === false ? 1 : i < waferCount / 2 ? 1 : 2;
      db.prepare(
        `INSERT INTO wafer_step_runs(wafer_id,step_id,tool_id,chamber_id,ran_at) VALUES (?,1,1,?,?)
         ON CONFLICT(wafer_id,step_id) DO UPDATE SET chamber_id=excluded.chamber_id`,
      ).run(w.id, chamberId, t);

      const geoms = dieGeometry(w.diameter_mm, w.die_x_mm, w.die_y_mm, w.edge_excl_mm);
      const effR = w.diameter_mm / 2 - w.edge_excl_mm;
      const dies: { x: number; y: number; passed: boolean }[] = [];
      for (const g of geoms) {
        if (!g.valid) continue;
        // 缺失坐标场景：随机跳过少量芯片（不测试 = 缺坐标数据）
        if (opts.includeMissingCoords && rand() < 0.02) continue;
        let fail = rand() < 0.02; // 随机底噪
        const sc = scenario === "mixed" ? (i % 3 === 0 ? "edge_ring" : i % 3 === 1 ? "scratch" : "random") : scenario;
        if (sc === "edge_ring" && g.r > effR - 10 && rand() < 0.7) fail = true;
        if (sc === "scratch" && Math.abs(g.cx * 0.3 - g.cy * 0.95) < 1.5 && rand() < 0.8) fail = true;
        dies.push({ x: g.x, y: g.y, passed: !fail });
      }
      svc.importResults(db, w.id, programId, dies);

      // 重复测试场景：同一芯片重复导入（不应重复计数）
      if (opts.includeDuplicates) {
        svc.importResults(db, w.id, programId, dies.slice(0, 20));
      }
      // 复测改善场景：部分失效复测翻转为通过
      if (opts.includeRetestImprovement) {
        const flips = dies.filter((d) => !d.passed).slice(0, 5)
          .map((d) => ({ x: d.x, y: d.y, passed: true }));
        if (flips.length) svc.recordRetest(db, w.id, flips, programId);
      }
    }
    return { waferIds, scenario };
  });
}
