// 可重复端到端演示：固定时钟与随机种子，全程虚构数据
import fs from "node:fs";
import { openDb } from "../src/db";
import { seed } from "../src/seed";
import * as svc from "../src/service";
import { setClock, setRng, seededRng } from "../src/util/clock";

const DB = "demo.db";
for (const s of ["", "-wal", "-shm"]) fs.rmSync(DB + s, { force: true });

setClock(() => 1_700_000_000_000);
setRng(seededRng(42));

const db = openDb(DB);
const show = (title: string, v: unknown) => {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(v, null, 2).slice(0, 1200));
};

// 1. 生成虚构数据（边缘环/划痕/随机混合 + 复测改善 + 腔室换线）
const { waferIds } = seed(db, { scenario: "mixed", waferCount: 6, includeRetestImprovement: true });
show("1. 已生成 6 片虚构晶圆", { waferIds });

// 2. 缺陷图谱（含阈值与误判依据）
const map = svc.defectMap(db, waferIds[0]);
show("2. 晶圆1 缺陷图谱", { pattern: map.pattern, confidence: map.confidence, evidence: map.evidence, thresholds: map.thresholds });

// 3. 良率（分母口径说明）
show("3. 晶圆1 良率", svc.waferYield(db, waferIds[0]));

// 4. 腔室比较（小样本警示）
show("4. 工序1 腔室比较", svc.compareChambers(db, 1));

// 5. 复测翻转 -> 新版本
const fails = svc.effectiveResults(db, waferIds[1]).filter((r) => r.passed === 0).slice(0, 3);
show("5. 复测翻转", svc.recordRetest(db, waferIds[1], fails.map((f) => ({ x: f.x, y: f.y, passed: true })), 1));

// 6. 程序换版 / 报废 / 拆分 -> 版本链
svc.changeProgram(db, "FT", "2.0");
svc.scrapWafer(db, waferIds[5]);
svc.splitLot(db, 2, "LOT-FIC-002B", [waferIds[3]]);
show("6. 版本链", db.prepare(
  "SELECT scope, scope_id, version_no, reason, status FROM analysis_versions ORDER BY id").all());

// 7. 审核最新归因版本
const last = db.prepare("SELECT id FROM analysis_versions ORDER BY id DESC LIMIT 1").get() as any;
show("7. 审核", svc.approveAnalysis(db, last.id, "demo-reviewer"));

// 8. 导出良率报告
const wafers = db.prepare("SELECT id FROM wafers WHERE lot_id=1 AND status='active'").all() as any[];
show("8. LOT-FIC-001 良率报告", wafers.map((w) => svc.waferYield(db, w.id)));

db.close();
console.log("\n演示完成。数据库保留在 demo.db，可重复运行本脚本（会先清空重建）。");
