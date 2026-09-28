#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase } from "./db.js";
import { generateDemoData } from "./generator.js";
import { analyzeBatch, analyzeWafer } from "./analysis.js";
import { createAnalysisVersion, importTest, recordRetest, reviewAnalysis, scrapWafer, splitBatch } from "./services.js";
import type { AnalysisResult } from "./types.js";

const args = process.argv.slice(2);
const command = args[0];
const dbPath = process.env.WAFER_DB ?? "data/wafer.sqlite";
const db = openDatabase(dbPath);

try {
  if (!command || command === "help") usage();
  else if (command === "generate") {
    before("wafers", "SELECT COUNT(*) AS n FROM wafers");
    generateDemoData({ db, seed: option("--seed") ?? "demo" });
    after("wafers", "SELECT COUNT(*) AS n FROM wafers");
  } else if (command === "import-test") {
    const input = JSON.parse(requireOption("--json"));
    const id = importTest(db, input);
    console.log(JSON.stringify({ importedTestId: id }, null, 2));
  } else if (command === "retest") {
    beforeWafer(numberOption("--wafer"));
    const result = recordRetest(db, numberOption("--wafer"), numberOption("--x"), numberOption("--y"), option("--passed") === "true", option("--defect") ?? null, option("--program") ? numberOption("--program") : undefined);
    console.log(JSON.stringify(result, null, 2));
    afterWafer(numberOption("--wafer"));
  } else if (command === "map") {
    const waferId = numberOption("--wafer");
    const result = analyzeWafer(db, waferId);
    printMap(result);
    if (option("--save") === "true") console.log(JSON.stringify({ analysisId: createAnalysisVersion(db, "wafer", waferId, "manual", "cli", result) }, null, 2));
  } else if (command === "compare-chambers") {
    const result = analyzeBatch(db, numberOption("--batch"));
    for (const group of result.yieldGroups) {
      console.log([group.processStep, group.equipmentName, group.chamberName ?? "-", `${group.waferCount}w`, `${group.dieCount}d`, `${(group.yield * 100).toFixed(2)}%`, group.comparable ? "comparable" : group.restriction].join("\t"));
    }
  } else if (command === "scrap-wafer") {
    const id = numberOption("--wafer");
    beforeWafer(id);
    scrapWafer(db, id);
    afterWafer(id);
  } else if (command === "split-batch") {
    const parent = numberOption("--batch");
    const wafers = (option("--wafers") ?? "").split(",").filter(Boolean).map((value) => Number(value));
    const id = splitBatch(db, parent, requireOption("--name"), wafers);
    console.log(JSON.stringify({ newBatchId: id }, null, 2));
  } else if (command === "review") {
    const id = numberOption("--analysis");
    reviewAnalysis(db, id);
    console.log(JSON.stringify({ analysisId: id, reviewed: true }, null, 2));
  } else if (command === "export-report") {
    const batchId = option("--batch") ? numberOption("--batch") : undefined;
    const waferId = option("--wafer") ? numberOption("--wafer") : undefined;
    const result = batchId ? analyzeBatch(db, batchId) : analyzeWafer(db, waferId!);
    const out = requireOption("--out");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), result }, null, 2), "utf8");
    console.log(JSON.stringify({ exported: out, validDieCount: result.denominator.validDieCount }, null, 2));
  } else usage(1);
} finally {
  db.close();
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function requireOption(name: string): string { const value = option(name); if (value === undefined) throw new Error(`${name} is required`); return value; }
function numberOption(name: string): number { const value = Number(requireOption(name)); if (!Number.isFinite(value)) throw new Error(`${name} must be a number`); return value; }
function before(label: string, sql: string): void { console.log(`before ${label}:`, String((db.prepare(sql).get() as { n: number }).n)); }
function after(label: string, sql: string): void { console.log(`after ${label}:`, String((db.prepare(sql).get() as { n: number }).n)); }
function beforeWafer(id: number): void { const row = db.prepare("SELECT status, COUNT(*) AS dies FROM wafers LEFT JOIN dies ON dies.wafer_id=wafers.id WHERE wafers.id=? GROUP BY wafers.id").get(id) as { status: string; dies: number } | undefined; console.log("before", JSON.stringify(row ?? null)); }
function afterWafer(id: number): void { beforeWafer(id); }
function printMap(result: AnalysisResult): void {
  console.log("denominator", JSON.stringify(result.denominator));
  for (const pattern of result.patterns.filter((p) => p.detected)) console.log(pattern.type, JSON.stringify(pattern.evidence), pattern.falsePositiveBasis);
  for (const line of result.conclusion) console.log(line);
}
function usage(code = 0): never {
  console.log(`Commands:
  generate [--seed seed]
  import-test --json '{...}'
  retest --wafer 1 --x 0 --y 0 --passed true [--defect CODE]
  map --wafer 1 [--save true]
  compare-chambers --batch 1
  scrap-wafer --wafer 1
  split-batch --batch 1 --name B-NEW --wafers 2,3
  review --analysis 1
  export-report --batch 1 --out reports/report.json
Set WAFER_DB to choose SQLite file.`);
  process.exit(code);
}
