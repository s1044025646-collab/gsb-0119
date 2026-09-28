import type { DatabaseSync } from "node:sqlite";
import { nowIso, withTransaction } from "./db.js";
import { analyzeBatch, analyzeWafer } from "./analysis.js";
import { ApiError, type AnalysisResult, type AnalysisTrigger, type TestKind } from "./types.js";
import { assert, positiveId, requireString } from "./validation.js";

export interface ImportTestInput {
  waferId: number;
  x: number;
  y: number;
  programId: number;
  kind?: TestKind;
  attempt?: number;
  passed: boolean;
  defectCode?: string | null;
  testedAt?: string;
  raw?: unknown;
  sourceRef?: string;
}

export function importTest(db: DatabaseSync, input: ImportTestInput, now: () => Date = () => new Date()): number {
  return withTransaction(db, () => {
    const testId = insertTest(db, input, now);
    return testId;
  });
}

function insertTest(db: DatabaseSync, input: ImportTestInput, now: () => Date = () => new Date()): number {
  const kind = input.kind ?? "initial";
  const attempt = input.attempt ?? 1;
  const testedAt = input.testedAt ?? nowIso(now);
  if (!Number.isInteger(input.x) || !Number.isInteger(input.y)) throw new ApiError(400, "VALIDATION_ERROR", "x and y must be integers");
  if (!Number.isInteger(attempt) || attempt < 1) throw new ApiError(400, "VALIDATION_ERROR", "attempt must be >= 1");
  const die = db.prepare("SELECT id,valid,wafer_id FROM dies WHERE wafer_id=? AND x=? AND y=?").get(input.waferId, input.x, input.y) as { id: number; valid: number; wafer_id: number } | undefined;
  assert(die, "DIE_NOT_FOUND", "chip coordinate was not found", 404);
  assert(die.valid === 1, "INVALID_EDGE_DIE", "invalid edge chip cannot enter the yield denominator");
  const previous = db.prepare("SELECT program_id FROM tests WHERE die_id=? ORDER BY tested_at DESC,id DESC LIMIT 1").get(die.id) as { program_id: number } | undefined;
  db.prepare("SELECT 1 FROM test_programs WHERE id=?").get(input.programId) ?? assert(false, "PROGRAM_NOT_FOUND", "test program version was not found", 404);
  if (input.defectCode) db.prepare("SELECT 1 FROM defect_categories WHERE code=?").get(input.defectCode) ?? assert(false, "DEFECT_NOT_FOUND", "defect category was not found", 404);
  const result = db.prepare(`INSERT INTO tests(die_id,program_id,kind,attempt,passed,defect_code,tested_at,raw_payload,source_ref)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(die.id, input.programId, kind, attempt, input.passed ? 1 : 0, input.defectCode ?? null, testedAt, JSON.stringify(input.raw ?? {}), input.sourceRef ?? null);
  if (previous && previous.program_id !== input.programId) insertAnalysisVersion(db, "wafer", die.wafer_id, null, "program_change", "test-import", analyzeWafer(db, die.wafer_id), now);
  return Number(result.lastInsertRowid);
}

export function recordRetest(db: DatabaseSync, waferId: number, x: number, y: number, passed: boolean, defectCode: string | null, programId?: number, now: () => Date = () => new Date()): { retestId: number; analysisId: number } {
  return withTransaction(db, () => {
    const die = db.prepare("SELECT id FROM dies WHERE wafer_id=? AND x=? AND y=? AND valid=1").get(waferId, x, y) as { id: number } | undefined;
    assert(die, "DIE_NOT_FOUND", "valid chip coordinate was not found", 404);
    const last = db.prepare("SELECT program_id, attempt FROM tests WHERE die_id=? ORDER BY tested_at DESC,id DESC LIMIT 1").get(die!.id) as { program_id: number; attempt: number } | undefined;
    assert(last, "INITIAL_TEST_REQUIRED", "an initial test must exist before retest", 409);
    const retestId = insertTest(db, { waferId, x, y, programId: programId ?? last!.program_id, kind: "retest", attempt: last!.attempt + 1, passed, defectCode }, now);
    const analysisId = insertAnalysisVersion(db, "wafer", waferId, null, "retest", "retest", analyzeWafer(db, waferId), now);
    return { retestId, analysisId };
  });
}

export function scrapWafer(db: DatabaseSync, waferId: number, now: () => Date = () => new Date()): number {
  return withTransaction(db, () => {
    const wafer = db.prepare("SELECT status FROM wafers WHERE id=?").get(waferId) as { status: string } | undefined;
    assert(wafer, "WAFER_NOT_FOUND", "wafer was not found", 404);
    assert(wafer.status !== "scrapped", "WAFER_ALREADY_SCRAPPED", "wafer is already scrapped", 409);
    db.prepare("UPDATE wafers SET status='scrapped', scrapped_at=? WHERE id=?").run(nowIso(now), waferId);
    return insertAnalysisVersion(db, "wafer", waferId, null, "wafer_scrap", "scrap", analyzeWafer(db, waferId), now);
  });
}

export function splitBatch(db: DatabaseSync, parentId: number, newName: string, waferIds: number[], now: () => Date = () => new Date()): number {
  return withTransaction(db, () => {
    const parent = db.prepare("SELECT id,product_id FROM batches WHERE id=?").get(parentId) as { id: number; product_id: number } | undefined;
    assert(parent, "BATCH_NOT_FOUND", "batch was not found", 404);
    const result = db.prepare("INSERT INTO batches(name,product_id,parent_batch_id,status,created_at) VALUES(?,?,?,'active',?)")
      .run(requireString(newName, "name"), parent.product_id, parentId, nowIso(now));
    const newId = Number(result.lastInsertRowid);
    for (const waferId of waferIds) {
      const wafer = db.prepare("SELECT batch_id FROM wafers WHERE id=?").get(waferId) as { batch_id: number } | undefined;
      assert(wafer?.batch_id === parentId, "WAFER_NOT_IN_BATCH", `wafer ${waferId} is not in parent batch`);
      db.prepare("UPDATE wafers SET batch_id=? WHERE id=?").run(newId, waferId);
      db.prepare("UPDATE process_events SET product_id=? WHERE wafer_id=?").run(parent.product_id, waferId);
    }
    db.prepare("UPDATE batches SET status='split' WHERE id=?").run(parentId);
    insertAnalysisVersion(db, "batch", null, parentId, "batch_split", "split", analyzeBatch(db, parentId), now);
    insertAnalysisVersion(db, "batch", null, newId, "batch_split", "split", analyzeBatch(db, newId), now);
    return newId;
  });
}

export function recordFailureAnalysis(db: DatabaseSync, waferId: number, x: number, y: number, analyst: string, finding: string, rootCauseCode?: string): number {
  return withTransaction(db, () => {
    const die = db.prepare("SELECT id FROM dies WHERE wafer_id=? AND x=? AND y=?").get(waferId, x, y) as { id: number } | undefined;
    assert(die, "DIE_NOT_FOUND", "chip coordinate was not found", 404);
    const result = db.prepare("INSERT INTO failure_analyses(die_id,analyst,finding,root_cause_code,created_at) VALUES(?,?,?,?,?)")
      .run(die!.id, requireString(analyst, "analyst"), requireString(finding, "finding"), rootCauseCode ?? null, nowIso());
    return Number(result.lastInsertRowid);
  });
}

export function reviewAnalysis(db: DatabaseSync, analysisId: number): void {
  withTransaction(db, () => {
    const result = db.prepare("UPDATE analyses SET reviewed=1 WHERE id=?").run(positiveId(analysisId, "analysisId"));
    assert(result.changes === 1, "ANALYSIS_NOT_FOUND", "analysis version was not found", 404);
  });
}

export function createAnalysisVersion(db: DatabaseSync, scope: "wafer" | "batch", scopeId: number, trigger: AnalysisTrigger, triggeredBy: string, result: AnalysisResult, now: () => Date = () => new Date()): number {
  return withTransaction(db, () => insertAnalysisVersion(db, scope, scope === "wafer" ? scopeId : null, scope === "batch" ? scopeId : null, trigger, triggeredBy, result, now));
}

function insertAnalysisVersion(db: DatabaseSync, scope: "wafer" | "batch", waferId: number | null, batchId: number | null, trigger: AnalysisTrigger, triggeredBy: string, result: AnalysisResult, now: () => Date): number {
  const previous = db.prepare("SELECT id,version FROM analyses WHERE scope_type=? AND COALESCE(wafer_id,-1)=COALESCE(?,-1) AND COALESCE(batch_id,-1)=COALESCE(?,-1) ORDER BY version DESC LIMIT 1")
    .get(scope, waferId, batchId) as { id: number; version: number } | undefined;
  const version = (previous?.version ?? 0) + 1;
  const row = db.prepare("INSERT INTO analyses(scope_type,wafer_id,batch_id,version,parent_analysis_id,trigger,triggered_by,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(scope, waferId, batchId, version, previous?.id ?? null, trigger, triggeredBy, JSON.stringify(result), nowIso(now));
  return Number(row.lastInsertRowid);
}
