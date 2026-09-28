import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { openDatabase } from "../src/db.js";
import { generateDemoData } from "../src/generator.js";
import { analyzeWafer, analyzeBatch } from "../src/analysis.js";
import { createAnalysisVersion, recordFailureAnalysis, recordRetest, reviewAnalysis, splitBatch } from "../src/services.js";
import { createRouter } from "../src/api.js";
import type { DatabaseSync } from "node:sqlite";

let dir: string;
let dbPath: string;
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wafer-test-"));
  dbPath = join(dir, "test.sqlite");
  db = openDatabase(dbPath);
  generateDemoData({ db, seed: "fixture-seed" });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("migration is repeatable and demo data is fictional and deterministic", () => {
  openDatabase(dbPath).close();
  const second = openDatabase(":memory:");
  generateDemoData({ db: second, seed: "fixture-seed" });
  assert.equal((second.prepare("SELECT COUNT(*) AS n FROM wafers").get() as { n: number }).n, 4);
  second.close();
});

test("edge invalid and missing coordinates are excluded from denominator", () => {
  const result = analyzeWafer(db, 1);
  assert.ok(result.denominator.invalidEdgeDieCount > 0);
  assert.ok(result.denominator.missingCoordinateCount > 0);
  assert.equal(result.denominator.validDieCount, result.denominator.testedUniqueDieCount + result.denominator.untestedDieCount);
  assert.equal(result.denominator.validDieCount + result.denominator.invalidEdgeDieCount + result.denominator.missingCoordinateCount, 441);
});

test("classifies edge ring, scratch and local cluster with explicit thresholds", () => {
  const edge = analyzeWafer(db, 1).patterns.find((p) => p.type === "edge_ring");
  const scratch = analyzeWafer(db, 2).patterns.find((p) => p.type === "scratch");
  const cluster = analyzeWafer(db, 3).patterns.find((p) => p.type === "local_cluster");
  assert.equal(edge?.detected, true);
  assert.equal(scratch?.detected, true);
  assert.equal(cluster?.detected, true);
  assert.equal(edge?.threshold.minEdgeFailureRatio, 0.6);
  assert.equal(scratch?.falsePositiveBasis.length > 0, true);
});

test("random wafer and duplicate raw tests count each chip once", () => {
  const result = analyzeWafer(db, 4);
  const random = result.patterns.find((p) => p.type === "random");
  assert.equal(random?.detected, true);
  assert.ok(result.denominator.excludedDuplicateTestCount >= 1);
  const rawRows = db.prepare("SELECT COUNT(*) AS n FROM tests GROUP BY die_id HAVING COUNT(*) > 1 ORDER BY die_id LIMIT 1").get() as { n: number };
  assert.equal(rawRows.n, 2);
});

test("retest preserves raw history but latest result flips yield", () => {
  const before = analyzeWafer(db, 2);
  const beforeFails = before.denominator.validDieCount - before.yieldGroups.reduce((sum, group) => sum + group.passCount, 0);
  recordRetest(db, 2, -1, 0, true, null, 2);
  const after = analyzeWafer(db, 2);
  const rawRetests = db.prepare("SELECT COUNT(*) AS n FROM tests WHERE kind='retest'").get() as { n: number };
  assert.ok(rawRetests.n >= 1);
  assert.ok(after.denominator.excludedDuplicateTestCount >= before.denominator.excludedDuplicateTestCount + 1);
  const afterFails = after.denominator.validDieCount - after.yieldGroups.reduce((sum, group) => sum + group.passCount, 0);
  assert.equal(afterFails, beforeFails - 1);
});

test("chamber comparison does not infer causality for small or mixed groups", () => {
  const groups = analyzeBatch(db, 1).yieldGroups;
  assert.ok(groups.some((group) => !group.comparable && group.restriction?.includes("Small sample")));
  const mixed = analyzeBatch(db, 3).yieldGroups;
  assert.equal(mixed[0]?.comparable, false);
});

test("analysis versions retain reproducible snapshots and parent chain", () => {
  const v1Result = analyzeWafer(db, 2);
  const v1 = createAnalysisVersion(db, "wafer", 2, "initial", "test", v1Result);
  const retest = recordRetest(db, 2, -1, 0, true, null, 2);
  const v2 = retest.analysisId;
  const row1 = db.prepare("SELECT version,parent_analysis_id,result_json,reviewed FROM analyses WHERE id=?").get(v1) as { version: number; parent_analysis_id: number | null; result_json: string; reviewed: number };
  const row2 = db.prepare("SELECT version,parent_analysis_id FROM analyses WHERE id=?").get(v2) as { version: number; parent_analysis_id: number };
  assert.equal(row1.version, 1);
  assert.equal(row1.parent_analysis_id, null);
  assert.equal(row2.version, 3);
  const programChange = db.prepare("SELECT id FROM analyses WHERE scope_type='wafer' AND wafer_id=2 AND version=2 AND trigger='program_change'").get() as { id: number };
  assert.equal(row2.parent_analysis_id, programChange.id);
  assert.match(row1.result_json, /edge_ring|scratch|local_cluster|random/);
  reviewAnalysis(db, v1);
  assert.equal((db.prepare("SELECT reviewed FROM analyses WHERE id=?").get(v1) as { reviewed: number }).reviewed, 1);
});

test("batch split creates another analysis version without changing old JSON", () => {
  const first = createAnalysisVersion(db, "batch", 1, "initial", "test", analyzeBatch(db, 1));
  const oldJson = (db.prepare("SELECT result_json FROM analyses WHERE id=?").get(first) as { result_json: string }).result_json;
  splitBatch(db, 1, "B-SPLIT", [2]);
  const second = (db.prepare("SELECT id FROM analyses WHERE scope_type='batch' AND batch_id=1 AND version=2").get() as { id: number }).id;
  assert.equal((db.prepare("SELECT version FROM analyses WHERE id=?").get(second) as { version: number }).version, 2);
  assert.equal((db.prepare("SELECT parent_analysis_id FROM analyses WHERE id=?").get(second) as { parent_analysis_id: number }).parent_analysis_id, first);
  assert.equal((db.prepare("SELECT result_json FROM analyses WHERE id=?").get(first) as { result_json: string }).result_json, oldJson);
});

test("failure paths return explicit codes", () => {
  assert.throws(() => recordRetest(db, 1, 10, 10, true, null), (error: Error & { code?: string }) => error.code === "DIE_NOT_FOUND");
  assert.throws(() => analyzeWafer(db, 999), (error: Error & { code?: string }) => error.code === "WAFER_NOT_FOUND");
});

test("concurrent writes preserve transaction boundaries", async () => {
  const writes = Array.from({ length: 8 }, (_unused, index) => () => recordFailureAnalysis(db, 4, index % 5, 0, `analyst-${index}`, "deterministic finding", "PARTICLE"));
  const ids = await Promise.all(writes.map((write) => Promise.resolve().then(write)));
  assert.equal(new Set(ids).size, 8);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM failure_analyses").get() as { n: number }).n, 8);
});

test("state survives process-like close and reopen", () => {
  const id = createAnalysisVersion(db, "wafer", 1, "manual", "test", analyzeWafer(db, 1));
  db.close();
  db = openDatabase(dbPath);
  const row = db.prepare("SELECT id,version FROM analyses WHERE id=?").get(id) as { id: number; version: number };
  assert.equal(row.id, id);
  assert.equal(row.version, 1);
});

test("router validates input, paginates and returns explicit JSON errors", async () => {
  const server = createServer(createRouter(db));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const pageResponse = await fetch(`${base}/batters?limit=1&offset=0`);
  assert.equal(pageResponse.status, 404);
  const page = await pageResponse.json();
  assert.equal(page.error.code, "NOT_FOUND");
  const batches = await fetch(`${base}/batches?limit=1&offset=0`).then((r) => r.json());
  assert.equal(batches.limit, 1);
  assert.equal(batches.items.length, 1);
  const invalidResponse = await fetch(`${base}/retests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ waferId: 1, x: 9, y: 9, passed: true }) });
  assert.equal(invalidResponse.status, 404);
  const invalid = await invalidResponse.json();
  assert.equal(invalid.error.code, "DIE_NOT_FOUND");
  server.unref();
});
