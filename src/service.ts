import { DB, withTx } from "./db";
import { isoNow } from "./util/clock";
import { dieGeometry } from "./domain/geometry";
import { classifyFails, FailPoint, DEFAULT_THRESHOLDS, SpatialThresholds } from "./domain/spatial";
import { badRequest, notFound, conflict, unprocessable } from "./errors";

export const MIN_SAMPLE = 5; // 小样本阈值：低于此不做因果断言

interface WaferRow {
  id: number; lot_id: number; slot: number; diameter_mm: number;
  die_x_mm: number; die_y_mm: number; edge_excl_mm: number; status: string;
}

function getWafer(db: DB, id: number): WaferRow {
  const w = db.prepare("SELECT * FROM wafers WHERE id=?").get(id) as WaferRow | undefined;
  if (!w) throw notFound(`wafer ${id} not found`);
  return w;
}

// 有效芯片集合：无效边缘芯片不计入分母
export function validDieSet(w: WaferRow) {
  const geoms = dieGeometry(w.diameter_mm, w.die_x_mm, w.die_y_mm, w.edge_excl_mm);
  const valid = new Map<string, { cx: number; cy: number; r: number }>();
  for (const g of geoms) if (g.valid) valid.set(`${g.x},${g.y}`, { cx: g.cx, cy: g.cy, r: g.r });
  return valid;
}

export interface EffectiveResult { x: number; y: number; passed: number; kind: string; id: number; }

// 同一芯片重复测试不重复计数：每颗芯片取最新一条（复测优先，因 tested_at 更晚 / id 更大）
export function effectiveResults(db: DB, waferId: number): EffectiveResult[] {
  const rows = db.prepare(
    `SELECT d.id, d.x, d.y, d.passed, d.kind FROM die_results d
     JOIN (SELECT x, y, MAX(id) AS max_id FROM die_results WHERE wafer_id=? GROUP BY x, y) m
       ON d.id = m.max_id`,
  ).all(waferId) as unknown as EffectiveResult[];
  return rows;
}

export function waferYield(db: DB, waferId: number) {
  const w = getWafer(db, waferId);
  const valid = validDieSet(w);
  const eff = effectiveResults(db, waferId).filter((r) => valid.has(`${r.x},${r.y}`));
  const tested = eff.length;
  const passed = eff.filter((r) => r.passed === 1).length;
  return {
    waferId,
    validDie: valid.size,
    testedDie: tested,
    passedDie: passed,
    yield: tested ? passed / tested : null,
    note: "分母为有效区域内已测芯片；无效边缘芯片已排除；重复测试按芯片去重",
  };
}

export function defectMap(db: DB, waferId: number, th: SpatialThresholds = DEFAULT_THRESHOLDS) {
  const w = getWafer(db, waferId);
  const valid = validDieSet(w);
  const eff = effectiveResults(db, waferId).filter((r) => valid.has(`${r.x},${r.y}`));
  const fails: FailPoint[] = eff.filter((r) => r.passed === 0).map((r) => {
    const g = valid.get(`${r.x},${r.y}`)!;
    return { x: r.x, y: r.y, cx: g.cx, cy: g.cy, r: g.r };
  });
  const effRadius = w.diameter_mm / 2 - w.edge_excl_mm;
  const cls = classifyFails(fails, effRadius, th);
  return {
    waferId,
    pattern: cls.pattern,
    confidence: cls.confidence,
    thresholds: th,
    evidence: cls.evidence,
    fails: fails.map((f, i) => ({ ...f, class: cls.assigned[i] ?? "random" })),
  };
}

// 创建新分析版本（旧版本保持可复现，不修改）
export function newAnalysisVersion(
  db: DB, scope: "wafer" | "lot", scopeId: number, reason: string, payload: unknown,
): number {
  const row = db.prepare(
    "SELECT COALESCE(MAX(version_no),0) AS v FROM analysis_versions WHERE scope=? AND scope_id=?",
  ).get(scope, scopeId) as { v: number };
  const version = row.v + 1;
  db.prepare(
    `INSERT INTO analysis_versions(scope, scope_id, version_no, reason, payload_json, status, created_at)
     VALUES (?,?,?,?,?,'draft',?)`,
  ).run(scope, scopeId, version, reason, JSON.stringify(payload), isoNow());
  return version;
}

export function buildWaferAnalysis(db: DB, waferId: number) {
  return { yield: waferYield(db, waferId), map: defectMap(db, waferId) };
}

// 按工序/设备/腔室比较良率；小样本或混合产品不断言因果
export function compareChambers(db: DB, stepId: number) {
  const runs = db.prepare(
    `SELECT r.chamber_id, c.code AS chamber, t.code AS tool, r.wafer_id, l.product
     FROM wafer_step_runs r
     JOIN chambers c ON c.id=r.chamber_id
     JOIN tools t ON t.id=r.tool_id
     JOIN wafers w ON w.id=r.wafer_id
     JOIN lots l ON l.id=w.lot_id
     WHERE r.step_id=? AND w.status='active'`,
  ).all(stepId) as { chamber_id: number; chamber: string; tool: string; wafer_id: number; product: string }[];
  const groups = new Map<string, { chamber: string; tool: string; wafers: number[]; products: Set<string> }>();
  for (const r of runs) {
    const key = `${r.tool}/${r.chamber}`;
    if (!groups.has(key)) groups.set(key, { chamber: r.chamber, tool: r.tool, wafers: [], products: new Set() });
    const g = groups.get(key)!;
    g.wafers.push(r.wafer_id);
    g.products.add(r.product);
  }
  const out = [...groups.values()].map((g) => {
    let tested = 0, passed = 0;
    for (const wid of g.wafers) {
      const y = waferYield(db, wid);
      tested += y.testedDie;
      passed += y.passedDie;
    }
    const mixedProduct = g.products.size > 1;
    const smallSample = g.wafers.length < MIN_SAMPLE;
    return {
      tool: g.tool,
      chamber: g.chamber,
      waferCount: g.wafers.length,
      products: [...g.products],
      testedDie: tested,
      yield: tested ? passed / tested : null,
      causalClaimAllowed: !mixedProduct && !smallSample,
      caveat: mixedProduct
        ? "混合产品：不可直接断言腔室因果"
        : smallSample
          ? `样本不足(${g.wafers.length}<${MIN_SAMPLE})：差异仅供参考`
          : null,
    };
  });
  return { stepId, minSample: MIN_SAMPLE, groups: out };
}

export function recordRetest(
  db: DB, waferId: number, dies: { x: number; y: number; passed: boolean }[], programId: number,
) {
  return withTx(db, () => {
    getWafer(db, waferId);
    let flips = 0;
    for (const d of dies) {
      const last = db.prepare(
        "SELECT passed FROM die_results WHERE wafer_id=? AND x=? AND y=? ORDER BY id DESC LIMIT 1",
      ).get(waferId, d.x, d.y) as { passed: number } | undefined;
      if (!last) throw unprocessable(`die ${d.x},${d.y} 无原始测试记录，不能复测`);
      db.prepare(
        `INSERT INTO die_results(wafer_id,x,y,program_id,kind,passed,defect_class_id,tested_at)
         VALUES (?,?,?,?,'retest',?,NULL,?)`,
      ).run(waferId, d.x, d.y, programId, d.passed ? 1 : 0, isoNow());
      if (last.passed !== (d.passed ? 1 : 0)) flips++;
    }
    let version: number | null = null;
    if (flips > 0) {
      version = newAnalysisVersion(db, "wafer", waferId, "retest_flip", buildWaferAnalysis(db, waferId));
    }
    return { waferId, retested: dies.length, flips, newVersion: version };
  });
}

export function importResults(
  db: DB, waferId: number, programId: number,
  dies: { x: number; y: number; passed: boolean; defectClassId?: number }[],
) {
  return withTx(db, () => {
    const w = getWafer(db, waferId);
    if (w.status === "scrapped") throw conflict(`wafer ${waferId} 已报废，拒绝导入`);
    const stmt = db.prepare(
      `INSERT INTO die_results(wafer_id,x,y,program_id,kind,passed,defect_class_id,tested_at)
       VALUES (?,?,?,?,'prime',?,?,?)`,
    );
    for (const d of dies) {
      if (!Number.isInteger(d.x) || !Number.isInteger(d.y)) throw badRequest("die 坐标必须为整数");
      stmt.run(waferId, d.x, d.y, programId, d.passed ? 1 : 0, d.defectClassId ?? null, isoNow());
    }
    return { waferId, imported: dies.length };
  });
}

export function scrapWafer(db: DB, waferId: number) {
  return withTx(db, () => {
    getWafer(db, waferId);
    db.prepare("UPDATE wafers SET status='scrapped' WHERE id=?").run(waferId);
    const version = newAnalysisVersion(db, "wafer", waferId, "scrap", { note: "wafer scrapped" });
    return { waferId, status: "scrapped", newVersion: version };
  });
}

export function splitLot(db: DB, fromLotId: number, toLotName: string, waferIds: number[]) {
  return withTx(db, () => {
    const from = db.prepare("SELECT * FROM lots WHERE id=?").get(fromLotId) as any;
    if (!from) throw notFound(`lot ${fromLotId} not found`);
    if (!waferIds.length) throw badRequest("waferIds 不能为空");
    db.prepare("INSERT INTO lots(name, product, status, created_at) VALUES (?,?, 'active', ?)")
      .run(toLotName, from.product, isoNow());
    const to = db.prepare("SELECT id FROM lots WHERE name=?").get(toLotName) as any;
    for (const wid of waferIds) {
      const w = getWafer(db, wid);
      if (w.lot_id !== fromLotId) throw conflict(`wafer ${wid} 不属于 lot ${fromLotId}`);
      db.prepare("UPDATE wafers SET lot_id=? WHERE id=?").run(to.id, wid);
      newAnalysisVersion(db, "wafer", wid, "lot_split", buildWaferAnalysis(db, wid));
    }
    db.prepare("INSERT INTO lot_splits(from_lot_id,to_lot_id,created_at) VALUES (?,?,?)")
      .run(fromLotId, to.id, isoNow());
    return { fromLotId, toLotId: to.id, moved: waferIds.length };
  });
}

export function changeProgram(db: DB, name: string, version: string): number {
  return withTx(db, () => {
    const exists = db.prepare("SELECT id FROM test_programs WHERE name=? AND version=?").get(name, version);
    if (exists) throw conflict(`程序 ${name}@${version} 已存在`);
    db.prepare("INSERT INTO test_programs(name,version,created_at) VALUES (?,?,?)").run(name, version, isoNow());
    const p = db.prepare("SELECT id FROM test_programs WHERE name=? AND version=?").get(name, version) as any;
    // 换版触发所有相关晶圆生成新分析版本
    const wafers = db.prepare(
      `SELECT DISTINCT wafer_id FROM die_results WHERE program_id IN (SELECT id FROM test_programs WHERE name=?)`,
    ).all(name) as { wafer_id: number }[];
    for (const { wafer_id } of wafers) {
      newAnalysisVersion(db, "wafer", wafer_id, "program_change", { newProgram: `${name}@${version}` });
    }
    return p.id;
  });
}

export function approveAnalysis(db: DB, analysisId: number, approver: string) {
  return withTx(db, () => {
    const a = db.prepare("SELECT * FROM analysis_versions WHERE id=?").get(analysisId) as any;
    if (!a) throw notFound(`analysis ${analysisId} not found`);
    if (a.status === "approved") throw conflict("该版本已审核");
    db.prepare("UPDATE analysis_versions SET status='approved' WHERE id=?").run(analysisId);
    return { id: analysisId, status: "approved", approver };
  });
}
