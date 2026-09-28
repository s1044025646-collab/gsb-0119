import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { openDb, DB } from "../src/db";
import * as svc from "../src/service";
import { seed } from "../src/seed";
import { classifyFails, DEFAULT_THRESHOLDS } from "../src/domain/spatial";
import { dieGeometry } from "../src/domain/geometry";
import { setClock, setRng, seededRng } from "../src/util/clock";
import { createServer } from "../src/api";
import { AddressInfo } from "node:net";

let dbCounter = 0;
let DB_PATH = "";

function freshDb(): DB {
  DB_PATH = `test-tmp-${process.pid}-${dbCounter++}.db`;
  for (const s of ["", "-wal", "-shm"]) fs.rmSync(DB_PATH + s, { force: true });
  return openDb(DB_PATH);
}

before(() => {
  setClock(() => 1_700_000_000_000);
  setRng(seededRng(42));
});
after(() => {
  setClock(null); setRng(null);
  for (const f of fs.readdirSync(".")) {
    if (f.startsWith(`test-tmp-${process.pid}-`)) fs.rmSync(f, { force: true });
  }
});

// ---------- 空间分类 ----------
test("空间分类: 边缘环/划痕/聚集/随机", () => {
  const R = 147;
  const ring: any[] = [];
  for (let a = 0; a < 360; a += 10) {
    const r = R - 5;
    ring.push({ x: 0, y: 0, cx: r * Math.cos(a), cy: r * Math.sin(a), r });
  }
  assert.equal(classifyFails(ring, R).pattern, "edge_ring");

  const line: any[] = [];
  for (let i = -10; i <= 10; i++) line.push({ x: 0, y: 0, cx: i * 10, cy: i * 3, r: Math.hypot(i * 10, i * 3) });
  assert.equal(classifyFails(line, R).pattern, "scratch");

  const cluster: any[] = [];
  for (let i = 0; i < 8; i++) cluster.push({ x: 0, y: 0, cx: 50 + (i % 3), cy: 50 + (i % 2), r: 71 });
  assert.equal(classifyFails(cluster, R).pattern, "cluster");

  const rnd: any[] = [[-100, -80], [30, 120], [90, -40], [-20, 10]].map(([cx, cy]) => ({ x: 0, y: 0, cx, cy, r: Math.hypot(cx, cy) }));
  assert.equal(classifyFails(rnd, R).pattern, "random");

  // 误判依据: evidence 必须包含触发规则与观测值
  const c = classifyFails(ring, R);
  assert.ok(c.evidence.rule && typeof c.evidence.ringRatio === "number");
  assert.ok(DEFAULT_THRESHOLDS.edgeRingRatio > 0);
});

// ---------- 分母口径 ----------
test("几何: 无效边缘芯片不计入有效集合", () => {
  const geoms = dieGeometry(300, 10, 10, 3);
  const valid = geoms.filter((g) => g.valid);
  assert.ok(valid.every((g) => g.r <= 147));
  assert.ok(geoms.some((g) => !g.valid)); // 确有边缘无效芯片
});

test("分母口径: 无效芯片与重复测试不计数", () => {
  const d = freshDb();
  setRng(seededRng(7));
  seed(d, { scenario: "random", waferCount: 1, includeDuplicates: true, includeRetestImprovement: false });
  const y = svc.waferYield(d, 1);
  const raw = (d.prepare("SELECT COUNT(*) c FROM die_results WHERE wafer_id=1").get() as any).c;
  assert.ok(raw > y.testedDie, "原始行数应大于去重后计数");
  assert.ok(y.testedDie <= y.validDie);
  d.close();
});

// ---------- 复测与版本链 ----------
test("复测翻转生成新版本, 旧版本可复现", () => {
  const d = freshDb();
  setRng(seededRng(9));
  seed(d, { scenario: "random", waferCount: 1, includeRetestImprovement: false });
  const before = svc.waferYield(d, 1);
  const fails = svc.effectiveResults(d, 1).filter((r) => r.passed === 0).slice(0, 3);
  const r = svc.recordRetest(d, 1, fails.map((f) => ({ x: f.x, y: f.y, passed: true })), 1);
  assert.equal(r.flips, 3);
  assert.ok(r.newVersion);
  const afterY = svc.waferYield(d, 1);
  assert.equal(afterY.passedDie, before.passedDie + 3);
  // 原始与复测分别保留
  const kinds = d.prepare("SELECT DISTINCT kind FROM die_results WHERE wafer_id=1").all() as any[];
  assert.deepEqual(kinds.map((k) => k.kind).sort(), ["prime", "retest"]);
  // 版本链
  const versions = d.prepare("SELECT version_no, reason FROM analysis_versions WHERE scope='wafer' AND scope_id=1 ORDER BY version_no").all() as any[];
  assert.deepEqual(versions.map((v) => v.reason), ["retest_flip"]);
  d.close();
});

test("复测无原始记录 -> 422", () => {
  const d = freshDb();
  setRng(seededRng(3));
  seed(d, { scenario: "random", waferCount: 1, includeRetestImprovement: false });
  assert.throws(() => svc.recordRetest(d, 1, [{ x: 999, y: 999, passed: true }], 1),
    (e: any) => e.code === "UNPROCESSABLE");
  d.close();
});

// ---------- 样本阈值 / 混合产品 ----------
test("腔室比较: 小样本与混合产品不断言因果", () => {
  const d = freshDb();
  setRng(seededRng(11));
  seed(d, { scenario: "random", waferCount: 4, includeRetestImprovement: false });
  const cmp = svc.compareChambers(d, 1);
  assert.equal(cmp.groups.length, 2);
  for (const g of cmp.groups) {
    assert.equal(g.causalClaimAllowed, false); // 每组只有 2 片 < MIN_SAMPLE
    assert.match(g.caveat!, /样本不足/);
  }
  d.close();
});

// ---------- 报废 / 拆分 / 换版 ----------
test("报废拒绝导入并生成版本; 拆分与换版生成版本链", () => {
  const d = freshDb();
  setRng(seededRng(13));
  seed(d, { scenario: "random", waferCount: 4, includeRetestImprovement: false });
  svc.scrapWafer(d, 1);
  assert.throws(() => svc.importResults(d, 1, 1, [{ x: 1, y: 1, passed: true }]),
    (e: any) => e.code === "CONFLICT");
  svc.splitLot(d, 1, "LOT-SPLIT-A", [2]);
  const w = d.prepare("SELECT lot_id FROM wafers WHERE id=2").get() as any;
  assert.ok(w.lot_id !== 1);
  svc.changeProgram(d, "FT", "2.0");
  const reasons = (d.prepare("SELECT DISTINCT reason FROM analysis_versions").all() as any[]).map((r) => r.reason);
  for (const r of ["scrap", "lot_split", "program_change"]) assert.ok(reasons.includes(r), `缺少 ${r}`);
  d.close();
});

// ---------- 重启恢复 ----------
test("进程重启后持久化状态可恢复", () => {
  const d1 = freshDb();
  setRng(seededRng(17));
  seed(d1, { scenario: "edge_ring", waferCount: 1, includeRetestImprovement: true });
  const y1 = svc.waferYield(d1, 1);
  const v1 = (d1.prepare("SELECT COUNT(*) c FROM analysis_versions").get() as any).c;
  d1.close();
  const d2 = openDb(DB_PATH); // 模拟重启
  const y2 = svc.waferYield(d2, 1);
  const v2 = (d2.prepare("SELECT COUNT(*) c FROM analysis_versions").get() as any).c;
  assert.deepEqual(y2, y1);
  assert.equal(v2, v1);
  assert.ok(v2 > 0);
  d2.close();
});

// ---------- 迁移可重复 ----------
test("迁移可重复执行", () => {
  const d = freshDb();
  d.close();
  const d2 = openDb(DB_PATH); // 再次打开即再次执行 migrate
  assert.ok((d2.prepare("SELECT COUNT(*) c FROM lots").get() as any).c >= 0);
  d2.close();
});

// ---------- API ----------
test("API: 校验、错误码、分页", async () => {
  const d = freshDb();
  setRng(seededRng(23));
  seed(d, { scenario: "random", waferCount: 2, includeRetestImprovement: false });
  const server = createServer(d);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  // 参数校验
  let res = await fetch(`${base}/lots`, { method: "POST", body: JSON.stringify({ name: "" }) });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "BAD_REQUEST");

  // 404
  res = await fetch(`${base}/wafers/9999/yield`);
  assert.equal(res.status, 404);

  // 分页
  res = await fetch(`${base}/wafers?limit=1&offset=0`);
  const page = await res.json();
  assert.equal(page.data.length, 1);
  assert.equal(page.total, 2);
  assert.equal(page.limit, 1);

  // 重复 lot -> 409
  res = await fetch(`${base}/lots`, { method: "POST", body: JSON.stringify({ name: "LOT-FIC-001", product: "P-A" }) });
  assert.equal(res.status, 409);

  // 图谱与报告端点
  res = await fetch(`${base}/wafers/1/map`);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).thresholds);
  res = await fetch(`${base}/lots/1/yield-report`);
  assert.equal(res.status, 200);

  // 审核
  await fetch(`${base}/manual-fa`, { method: "POST", body: JSON.stringify({ waferId: 1, x: 1, y: 1, defectClassId: 1, analyst: "qa" }) });
  res = await fetch(`${base}/analyses`);
  const analyses = (await res.json()).data;
  const id = analyses[analyses.length - 1].id;
  res = await fetch(`${base}/analyses/${id}/approve`, { method: "POST", body: JSON.stringify({ approver: "lead" }) });
  assert.equal(res.status, 200);
  res = await fetch(`${base}/analyses/${id}/approve`, { method: "POST", body: JSON.stringify({ approver: "lead" }) });
  assert.equal(res.status, 409); // 重复审核

  server.close();
  d.close();
});
