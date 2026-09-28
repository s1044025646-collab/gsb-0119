import type { DatabaseSync } from "node:sqlite";
import { ApiError, type AnalysisResult, type EffectiveTest, type PatternResult, type YieldGroup } from "./types.js";
import { assert } from "./validation.js";

interface DieRow { id: number; x: number; y: number; valid: number }
interface TestRow {
  die_id: number; program_id: number; program_version: string; kind: "initial" | "retest";
  attempt: number; passed: number; defect_code: string | null; tested_at: string;
}

export function analyzeWafer(db: DatabaseSync, waferId: number): AnalysisResult {
  const wafer = db.prepare("SELECT id,batch_id,status FROM wafers WHERE id=?").get(waferId) as { id: number; batch_id: number; status: string } | undefined;
  assert(wafer, "WAFER_NOT_FOUND", "wafer was not found", 404);
  return buildAnalysis(db, [waferId!], "wafer");
}

export function analyzeBatch(db: DatabaseSync, batchId: number): AnalysisResult {
  const batch = db.prepare("SELECT id FROM batches WHERE id=?").get(batchId) as { id: number } | undefined;
  assert(batch, "BATCH_NOT_FOUND", "batch was not found", 404);
  const wafers = db.prepare("SELECT id FROM wafers WHERE batch_id=? ORDER BY id").all(batchId) as Array<{ id: number }>;
  return buildAnalysis(db, wafers.map((w) => w.id), "batch");
}

function buildAnalysis(db: DatabaseSync, waferIds: number[], scope: "wafer" | "batch"): AnalysisResult {
  if (waferIds.length === 0) return emptyResult(scope);
  const placeholders = waferIds.map(() => "?").join(",");
  const dies = db.prepare(`SELECT d.id,d.x,d.y,d.valid FROM dies d WHERE d.wafer_id IN (${placeholders}) ORDER BY d.wafer_id,d.y,d.x`).all(...waferIds) as unknown as DieRow[];
  const valid = new Map(dies.filter((d) => d.valid === 1).map((d) => [d.id, d]));
  const invalidCount = dies.filter((d) => d.valid === 0).length;
  const radiusRows = db.prepare("SELECT MIN(radius_units) AS min_radius,MAX(radius_units) AS max_radius FROM wafers WHERE id IN (" + placeholders + ")").all(...waferIds) as unknown as Array<{ min_radius: number; max_radius: number }>;
  const radius = radiusRows[0]?.max_radius ?? 0;
  const present = new Set(dies.map((die) => `${die.x},${die.y}`));
  let missingCount = 0;
  if (radiusRows[0]?.min_radius === radius) for (let y = -radius; y <= radius; y += 1) for (let x = -radius; x <= radius; x += 1) if (!present.has(`${x},${y}`)) missingCount += 1;
  const rows = db.prepare(`
    SELECT t.die_id,t.program_id,p.version AS program_version,t.kind,t.attempt,t.passed,t.defect_code,t.tested_at
    FROM tests t JOIN test_programs p ON p.id=t.program_id
    WHERE t.die_id IN (SELECT id FROM dies WHERE wafer_id IN (${placeholders}))
    ORDER BY t.die_id,t.tested_at,t.id`).all(...waferIds) as unknown as TestRow[];
  const latest = new Map<number, TestRow>();
  let duplicateRows = 0;
  for (const row of rows) {
    if (!valid.has(row.die_id)) continue;
    if (latest.has(row.die_id)) duplicateRows += 1;
    latest.set(row.die_id, row);
  }
  const tests: EffectiveTest[] = [...latest.entries()].map(([dieId, row]) => ({
    dieId,
    x: valid.get(dieId)!.x,
    y: valid.get(dieId)!.y,
    passed: row.passed === 1,
    defectCategory: row.defect_code,
    kind: row.kind,
    attempt: row.attempt,
    testedAt: row.tested_at,
    programId: row.program_id,
    programVersion: row.program_version,
  }));
  const programs = [...new Set(tests.map((t) => t.programVersion))].sort();
  const patterns = waferIds.length === 1 ? classifyPatterns(tests) : [];
  const yieldGroups = groupYield(db, waferIds, latest);
  const testedSet = new Set(tests.map((t) => t.dieId));
  return {
    scope,
    denominator: {
      validDieCount: valid.size,
      invalidEdgeDieCount: invalidCount,
      missingCoordinateCount: missingCount,
      testedUniqueDieCount: testedSet.size,
      untestedDieCount: valid.size - testedSet.size,
      excludedDuplicateTestCount: duplicateRows,
    },
    programs,
    patterns,
    yieldGroups,
    conclusion: conclusions(patterns, yieldGroups),
  };
}

function emptyResult(scope: "wafer" | "batch"): AnalysisResult {
  return { scope, denominator: { validDieCount: 0, invalidEdgeDieCount: 0, missingCoordinateCount: 0, testedUniqueDieCount: 0, untestedDieCount: 0, excludedDuplicateTestCount: 0 }, programs: [], patterns: [], yieldGroups: [], conclusion: ["No wafers in scope; no denominator is reported."] };
}

function classifyPatterns(tests: EffectiveTest[]): PatternResult[] {
  const fails = tests.filter((t) => !t.passed);
  if (fails.length === 0) return [{ type: "none", detected: false, threshold: { minFailures: 3 }, evidence: { failures: 0 }, falsePositiveBasis: "No failing valid chips.", dieIds: [] }];
  const xs = tests.map((t) => t.x);
  const ys = tests.map((t) => t.y);
  const maxRadius = Math.max(...tests.map((t) => Math.hypot(t.x, t.y)), 1);
  const edgeFails = fails.filter((t) => Math.hypot(t.x, t.y) > maxRadius - 2.05);
  const edgeRatio = edgeFails.length / fails.length;
  const edge: PatternResult = {
    type: "edge_ring",
    detected: edgeFails.length >= 5 && edgeRatio >= 0.6,
    threshold: { minEdgeFailures: 5, minEdgeFailureRatio: 0.6, edgeBandUnits: 2.05 },
    evidence: { edgeFailures: edgeFails.length, totalFailures: fails.length, edgeRatio: Number(edgeRatio.toFixed(3)) },
    falsePositiveBasis: edgeFails.length >= 5 && edgeRatio < 0.6 ? "Failures touch the edge but do not dominate the ring." : "Invalid edge chips are excluded from denominator.",
    dieIds: edgeFails.map((t) => t.dieId),
  };
  const scratch = bestLine(fails);
  const scratchPattern: PatternResult = {
    type: "scratch",
    detected: scratch.count >= 5 && scratch.count / fails.length >= 0.35,
    threshold: { minCollinearFailures: 5, minFailureRatio: 0.35, toleranceUnits: 0.65 },
    evidence: { collinearFailures: scratch.count, totalFailures: fails.length, orientation: scratch.orientation, line: scratch.line },
    falsePositiveBasis: "A short row or isolated alignment is not called a scratch.",
    dieIds: scratch.dieIds,
  };
  const cluster = bestCluster(fails);
  const clusterPattern: PatternResult = {
    type: "local_cluster",
    detected: cluster.count >= 4 && cluster.count / fails.length >= 0.25,
    threshold: { minClusterFailures: 4, radiusUnits: 2.25, minFailureRatio: 0.25 },
    evidence: { clusterFailures: cluster.count, totalFailures: fails.length, centerX: cluster.x, centerY: cluster.y },
    falsePositiveBasis: "Widespread or isolated failures do not satisfy the compact neighborhood threshold.",
    dieIds: cluster.dieIds,
  };
  const structured = edge.detected || scratchPattern.detected || clusterPattern.detected;
  const random: PatternResult = {
    type: "random",
    detected: !structured,
    threshold: { requireNoStructuredPattern: 1 },
    evidence: { totalFailures: fails.length },
    falsePositiveBasis: structured ? "A spatial pattern explains more failures than the random fallback." : "Failure set failed edge, scratch, and cluster thresholds.",
    dieIds: fails.map((t) => t.dieId),
  };
  return [edge, scratchPattern, clusterPattern, random];
}

function bestLine(fails: EffectiveTest[]): { count: number; orientation: string; line: string; dieIds: number[] } {
  let best: EffectiveTest[] = [];
  for (const anchor of fails) {
    for (const slope of [0, Infinity, 1, -1]) {
      const members = fails.filter((p) => Number.isFinite(slope)
        ? Math.abs((p.y - anchor.y) - slope * (p.x - anchor.x)) / Math.sqrt(1 + slope * slope) <= 0.65
        : p.x === anchor.x);
      if (members.length > best.length) best = members;
    }
  }
  const orientation = best.length && best[0] && best.some((p) => p.x !== best[0]!.x) ? "horizontal_or_diagonal" : "vertical";
  return { count: best.length, orientation, line: "least-square candidate through failure points", dieIds: best.map((p) => p.dieId) };
}

function bestCluster(fails: EffectiveTest[]): { count: number; x: number; y: number; dieIds: number[] } {
  let best: EffectiveTest[] = [];
  for (const center of fails) {
    const members = fails.filter((p) => Math.hypot(p.x - center.x, p.y - center.y) <= 2.25);
    if (members.length > best.length) best = members;
  }
  const first = best[0];
  return { count: best.length, x: first?.x ?? 0, y: first?.y ?? 0, dieIds: best.map((p) => p.dieId) };
}

function groupYield(db: DatabaseSync, waferIds: number[], latest: Map<number, TestRow>): YieldGroup[] {
  const placeholders = waferIds.map(() => "?").join(",");
  const events = db.prepare(`SELECT e.process_step,e.equipment_id,eq.name AS equipment_name,e.chamber_id,c.name AS chamber_name,e.product_id,e.wafer_id
    FROM process_events e LEFT JOIN equipment eq ON eq.id=e.equipment_id LEFT JOIN chambers c ON c.id=e.chamber_id
    WHERE e.wafer_id IN (${placeholders})`).all(...waferIds) as Array<{ process_step: string; equipment_id: number; equipment_name: string; chamber_id: number | null; chamber_name: string | null; product_id: number; wafer_id: number }>;
  const groups = new Map<string, Omit<YieldGroup, "restriction"> & { restriction?: string; waferSet: Set<number> }>();
  for (const event of events) {
    const key = [event.process_step, event.equipment_id ?? "", event.chamber_id ?? ""].join("|");
    const dies = db.prepare("SELECT id FROM dies WHERE wafer_id=? AND valid=1").all(event.wafer_id) as Array<{ id: number }>;
    let group = groups.get(key);
    if (!group) {
      group = { key, processStep: event.process_step, equipmentId: event.equipment_id, equipmentName: event.equipment_name, chamberId: event.chamber_id, chamberName: event.chamber_name, productIds: [], waferCount: 0, dieCount: 0, passCount: 0, failCount: 0, yield: 0, comparable: true, deltaVsBest: null, waferSet: new Set() };
      groups.set(key, group);
    }
    if (!group.productIds.includes(event.product_id)) group.productIds.push(event.product_id);
    group.waferSet.add(event.wafer_id);
    for (const die of dies) {
      const test = latest.get(die.id);
      if (!test) continue;
      group.dieCount += 1;
      if (test.passed === 1) group.passCount += 1;
      else group.failCount += 1;
    }
  }
  const output = [...groups.values()].map((group) => {
    const { waferSet, ...plain } = group;
    plain.waferCount = waferSet.size;
    plain.yield = plain.dieCount ? plain.passCount / plain.dieCount : 0;
    plain.comparable = plain.waferCount >= 3 && plain.productIds.length === 1;
    if (plain.productIds.length > 1) plain.restriction = "Mixed products: descriptive only.";
    else if (plain.waferCount < 3) plain.restriction = "Small sample: descriptive only.";
    return plain;
  });
  for (const step of [...new Set(output.map((g) => g.processStep))]) {
    const peers = output.filter((g) => g.processStep === step && g.comparable);
    const best = Math.max(-1, ...peers.map((g) => g.yield));
    if (peers.length > 1) for (const group of peers) group.deltaVsBest = Number((group.yield - best).toFixed(6));
  }
  return output;
}

function conclusions(patterns: PatternResult[], groups: YieldGroup[]): string[] {
  const result = patterns.filter((p) => p.detected && p.type !== "none").map((p) => `Detected ${p.type.replace("_", " ")} based on configured spatial thresholds.`);
  for (const group of groups) {
    if (!group.comparable) result.push(`${group.processStep}/${group.equipmentName}/${group.chamberName ?? "-"}: ${group.restriction}`);
    else if (group.deltaVsBest !== null && group.deltaVsBest < -0.05) result.push(`${group.processStep}/${group.equipmentName}/${group.chamberName ?? "-"} differs by ${(group.deltaVsBest * 100).toFixed(1)} percentage points; association is not causal proof.`);
  }
  return result.length ? result : ["No statistically assertive spatial or equipment attribution."];
}
