import http from "node:http";
import { DB } from "./db";
import { ApiError, badRequest } from "./errors";
import * as svc from "./service";
import { isoNow } from "./util/clock";

interface Page { limit: number; offset: number; }
function pageOf(url: URL): Page {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
  if (!Number.isFinite(limit) || limit <= 0) throw badRequest("limit 必须为正整数");
  return { limit, offset };
}
function paged<T>(rows: T[], total: number, p: Page) {
  return { data: rows, total, limit: p.limit, offset: p.offset };
}
function int(v: unknown, name: string): number {
  const n = Number(v);
  if (!Number.isInteger(n)) throw badRequest(`${name} 必须为整数`);
  return n;
}
function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw badRequest(`${name} 必须为非空字符串`);
  return v.trim();
}

async function body(req: http.IncomingMessage): Promise<any> {
  let s = "";
  for await (const c of req) s += c;
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw badRequest("请求体不是合法 JSON"); }
}

export function createServer(db: DB): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const m = req.method ?? "GET";
      const parts = url.pathname.split("/").filter(Boolean);
      const b = m === "POST" || m === "PUT" ? await body(req) : {};

      // --- 基础数据 ---
      if (m === "POST" && url.pathname === "/lots") {
        const name = str(b.name, "name"), product = str(b.product, "product");
        db.prepare("INSERT INTO lots(name,product,status,created_at) VALUES (?,?,'active',?)")
          .run(name, product, isoNow());
        return send(201, db.prepare("SELECT * FROM lots WHERE name=?").get(name));
      }
      if (m === "GET" && url.pathname === "/lots") {
        const p = pageOf(url);
        const total = (db.prepare("SELECT COUNT(*) c FROM lots").get() as any).c;
        return send(200, paged(db.prepare("SELECT * FROM lots ORDER BY id LIMIT ? OFFSET ?").all(p.limit, p.offset), total, p));
      }
      if (m === "POST" && url.pathname === "/wafers") {
        const lotId = int(b.lotId, "lotId"), slot = int(b.slot, "slot");
        db.prepare(
          `INSERT INTO wafers(lot_id,slot,diameter_mm,die_x_mm,die_y_mm,edge_excl_mm,status,created_at)
           VALUES (?,?,?,?,?,?,'active',?)`,
        ).run(lotId, slot, b.diameterMm ?? 300, b.dieXMm ?? 10, b.dieYMm ?? 10, b.edgeExclMm ?? 3, isoNow());
        return send(201, db.prepare("SELECT * FROM wafers WHERE lot_id=? AND slot=?").get(lotId, slot));
      }
      if (m === "GET" && url.pathname === "/wafers") {
        const p = pageOf(url);
        const total = (db.prepare("SELECT COUNT(*) c FROM wafers").get() as any).c;
        return send(200, paged(db.prepare("SELECT * FROM wafers ORDER BY id LIMIT ? OFFSET ?").all(p.limit, p.offset), total, p));
      }
      if (m === "POST" && url.pathname === "/test-programs") {
        return send(201, { id: svc.changeProgram(db, str(b.name, "name"), str(b.version, "version")) });
      }
      if (m === "POST" && url.pathname === "/defect-classes") {
        db.prepare("INSERT INTO defect_classes(code,name) VALUES (?,?)").run(str(b.code, "code"), str(b.name, "name"));
        return send(201, db.prepare("SELECT * FROM defect_classes WHERE code=?").get(b.code));
      }
      if (m === "POST" && url.pathname === "/routes") {
        // 记录晶圆在某工序的设备/腔室
        const waferId = int(b.waferId, "waferId"), stepId = int(b.stepId, "stepId");
        const toolId = int(b.toolId, "toolId"), chamberId = int(b.chamberId, "chamberId");
        db.prepare(
          `INSERT INTO wafer_step_runs(wafer_id,step_id,tool_id,chamber_id,ran_at) VALUES (?,?,?,?,?)
           ON CONFLICT(wafer_id,step_id) DO UPDATE SET tool_id=excluded.tool_id, chamber_id=excluded.chamber_id, ran_at=excluded.ran_at`,
        ).run(waferId, stepId, toolId, chamberId, isoNow());
        return send(201, { ok: true });
      }
      if (m === "POST" && url.pathname === "/steps") {
        db.prepare("INSERT INTO process_steps(name) VALUES (?)").run(str(b.name, "name"));
        return send(201, db.prepare("SELECT * FROM process_steps WHERE name=?").get(b.name));
      }
      if (m === "POST" && url.pathname === "/tools") {
        db.prepare("INSERT INTO tools(step_id,code) VALUES (?,?)").run(int(b.stepId, "stepId"), str(b.code, "code"));
        return send(201, db.prepare("SELECT * FROM tools WHERE code=?").get(b.code));
      }
      if (m === "POST" && url.pathname === "/chambers") {
        db.prepare("INSERT INTO chambers(tool_id,code) VALUES (?,?)").run(int(b.toolId, "toolId"), str(b.code, "code"));
        return send(201, db.prepare("SELECT * FROM chambers WHERE tool_id=? AND code=?").get(b.toolId, b.code));
      }

      // --- 测试数据 ---
      if (m === "POST" && url.pathname === "/results") {
        const dies = (b.dies as any[]).map((d) => ({
          x: int(d.x, "die.x"), y: int(d.y, "die.y"), passed: Boolean(d.passed),
          defectClassId: d.defectClassId == null ? undefined : int(d.defectClassId, "defectClassId"),
        }));
        if (!dies.length) throw badRequest("dies 不能为空");
        return send(201, svc.importResults(db, int(b.waferId, "waferId"), int(b.programId, "programId"), dies));
      }
      if (m === "POST" && url.pathname === "/retests") {
        const dies = (b.dies as any[]).map((d) => ({ x: int(d.x, "die.x"), y: int(d.y, "die.y"), passed: Boolean(d.passed) }));
        if (!dies.length) throw badRequest("dies 不能为空");
        return send(201, svc.recordRetest(db, int(b.waferId, "waferId"), dies, int(b.programId, "programId")));
      }
      if (m === "GET" && parts[0] === "wafers" && parts[2] === "results") {
        const p = pageOf(url);
        const wid = int(parts[1], "waferId");
        const total = (db.prepare("SELECT COUNT(*) c FROM die_results WHERE wafer_id=?").get(wid) as any).c;
        const rows = db.prepare("SELECT * FROM die_results WHERE wafer_id=? ORDER BY id LIMIT ? OFFSET ?")
          .all(wid, p.limit, p.offset);
        return send(200, paged(rows, total, p));
      }

      // --- 分析 ---
      if (m === "GET" && parts[0] === "wafers" && parts[2] === "map") {
        return send(200, svc.defectMap(db, int(parts[1], "waferId")));
      }
      if (m === "GET" && parts[0] === "wafers" && parts[2] === "yield") {
        return send(200, svc.waferYield(db, int(parts[1], "waferId")));
      }
      if (m === "GET" && parts[0] === "steps" && parts[2] === "chamber-compare") {
        return send(200, svc.compareChambers(db, int(parts[1], "stepId")));
      }
      if (m === "POST" && parts[0] === "wafers" && parts[2] === "scrap") {
        return send(200, svc.scrapWafer(db, int(parts[1], "waferId")));
      }
      if (m === "POST" && url.pathname === "/lot-splits") {
        const ids = (b.waferIds as unknown[]).map((v) => int(v, "waferId"));
        return send(201, svc.splitLot(db, int(b.fromLotId, "fromLotId"), str(b.toLotName, "toLotName"), ids));
      }
      if (m === "POST" && url.pathname === "/manual-fa") {
        db.prepare(
          `INSERT INTO manual_fa(wafer_id,x,y,defect_class_id,analyst,note,created_at) VALUES (?,?,?,?,?,?,?)`,
        ).run(int(b.waferId, "waferId"), int(b.x, "x"), int(b.y, "y"),
          int(b.defectClassId, "defectClassId"), str(b.analyst, "analyst"), b.note ?? null, isoNow());
        const v = svc.newAnalysisVersion(db, "wafer", int(b.waferId, "waferId"), "fa_update",
          svc.buildWaferAnalysis(db, int(b.waferId, "waferId")));
        return send(201, { ok: true, newVersion: v });
      }
      if (m === "GET" && url.pathname === "/analyses") {
        const p = pageOf(url);
        const total = (db.prepare("SELECT COUNT(*) c FROM analysis_versions").get() as any).c;
        const rows = db.prepare("SELECT * FROM analysis_versions ORDER BY id LIMIT ? OFFSET ?").all(p.limit, p.offset);
        return send(200, paged(rows, total, p));
      }
      if (m === "POST" && parts[0] === "analyses" && parts[2] === "approve") {
        return send(200, svc.approveAnalysis(db, int(parts[1], "analysisId"), str(b.approver, "approver")));
      }
      if (m === "GET" && parts[0] === "lots" && parts[2] === "yield-report") {
        const lotId = int(parts[1], "lotId");
        const wafers = db.prepare("SELECT id FROM wafers WHERE lot_id=? AND status='active'").all(lotId) as any[];
        const report = wafers.map((w) => svc.waferYield(db, w.id));
        const tested = report.reduce((s, r) => s + r.testedDie, 0);
        const passed = report.reduce((s, r) => s + r.passedDie, 0);
        return send(200, { lotId, wafers: report, testedDie: tested, yield: tested ? passed / tested : null });
      }

      throw new ApiError("NOT_FOUND", `route ${m} ${url.pathname} not found`, 404);
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: { code: e.code, message: e.message } });
      const msg = (e as Error).message ?? "internal error";
      if (/UNIQUE constraint/.test(msg)) return send(409, { error: { code: "CONFLICT", message: msg } });
      return send(500, { error: { code: "INTERNAL", message: msg } });
    }
  });
}
