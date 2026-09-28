import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { analyzeBatch, analyzeWafer } from "./analysis.js";
import { createAnalysisVersion, importTest, recordFailureAnalysis, recordRetest, reviewAnalysis, scrapWafer, splitBatch } from "./services.js";
import { generateDemoData } from "./generator.js";
import { ApiError, type PageResult } from "./types.js";
import { integer, pageParams, positiveId, requireString } from "./validation.js";

type Handler = (req: IncomingMessage, url: URL, body: unknown, match: RegExpMatchArray) => unknown;

export function createRouter(db: DatabaseSync) {
  const routes: Array<[string, RegExp, Handler]> = [
    ["GET", /^\/health$/, () => ({ ok: true })],
    ["POST", /^\/demo\/generate$/, () => { generateDemoData({ db }); return { generated: true }; }],
    ["GET", /^\/batches$/, (_req, url) => paginate(db, "SELECT * FROM batches ORDER BY id", "SELECT COUNT(*) AS n FROM batches", url)],
    ["GET", /^\/wafers$/, (_req, url) => {
      const batchId = url.searchParams.get("batchId");
      return batchId
        ? paginate(db, "SELECT * FROM wafers WHERE batch_id=? ORDER BY id", "SELECT COUNT(*) AS n FROM wafers WHERE batch_id=?", url, positiveId(batchId, "batchId"))
        : paginate(db, "SELECT * FROM wafers ORDER BY id", "SELECT COUNT(*) AS n FROM wafers", url);
    }],
    ["GET", /^\/dies$/, (_req, url) => {
      const waferId = positiveId(url.searchParams.get("waferId"), "waferId");
      return paginate(db, "SELECT * FROM dies WHERE wafer_id=? ORDER BY y,x", "SELECT COUNT(*) AS n FROM dies WHERE wafer_id=?", url, waferId);
    }],
    ["POST", /^\/tests$/, (_req, _url, body) => {
      const b = object(body);
      const input: Parameters<typeof importTest>[1] = {
        waferId: positiveId(b.waferId, "waferId"),
        x: integer(b.x, "x"),
        y: integer(b.y, "y"),
        programId: positiveId(b.programId, "programId"),
        passed: Boolean(b.passed),
      };
      if (b.kind !== undefined) input.kind = b.kind as "initial" | "retest";
      if (b.attempt !== undefined) input.attempt = integer(b.attempt, "attempt", 1);
      if (b.defectCode !== undefined && b.defectCode !== null) input.defectCode = requireString(b.defectCode, "defectCode");
      if (b.testedAt !== undefined) input.testedAt = requireString(b.testedAt, "testedAt");
      if (b.raw !== undefined) input.raw = b.raw;
      if (b.sourceRef !== undefined) input.sourceRef = requireString(b.sourceRef, "sourceRef");
      return { id: importTest(db, input) };
    }],
    ["POST", /^\/retests$/, (_req, _url, body) => {
      const b = object(body);
      const retest = recordRetest(db, positiveId(b.waferId, "waferId"), integer(b.x, "x"), integer(b.y, "y"), Boolean(b.passed), b.defectCode == null ? null : requireString(b.defectCode, "defectCode"), b.programId === undefined ? undefined : positiveId(b.programId, "programId"));
      return retest;
    }],
    ["POST", /^\/wafers\/(\d+)\/scrap$/, (_req, _url, _body, match) => { scrapWafer(db, Number(match[1])); return { scrapped: true }; }],
    ["POST", /^\/batches\/(\d+)\/split$/, (_req, _url, body, match) => {
      const b = object(body);
      const wafers = Array.isArray(b.waferIds) ? b.waferIds.map((id) => positiveId(id, "waferIds[]")) : [];
      return { id: splitBatch(db, Number(match[1]), requireString(b.name, "name"), wafers) };
    }],
    ["POST", /^\/failure-analyses$/, (_req, _url, body) => {
      const b = object(body);
      return { id: recordFailureAnalysis(db, positiveId(b.waferId, "waferId"), integer(b.x, "x"), integer(b.y, "y"), requireString(b.analyst, "analyst"), requireString(b.finding, "finding"), b.rootCauseCode === undefined ? undefined : requireString(b.rootCauseCode, "rootCauseCode")) };
    }],
    ["POST", /^\/analyses$/, (_req, _url, body) => {
      const b = object(body);
      if (b.scope !== "wafer" && b.scope !== "batch") throw new ApiError(400, "VALIDATION_ERROR", "scope must be wafer or batch");
      const result = b.scope === "wafer" ? analyzeWafer(db, positiveId(b.id, "id")) : analyzeBatch(db, positiveId(b.id, "id"));
      const trigger = b.trigger === undefined ? "manual" : b.trigger as "initial" | "retest" | "program_change" | "wafer_scrap" | "batch_split" | "manual";
      return { id: createAnalysisVersion(db, b.scope, positiveId(b.id, "id"), trigger, requireString(b.triggeredBy ?? "api", "triggeredBy"), result), result };
    }],
    ["GET", /^\/analyses\/(\d+)$/, (_req, _url, _body, match) => {
      const row = db.prepare("SELECT * FROM analyses WHERE id=?").get(Number(match[1]));
      if (!row) throw new ApiError(404, "ANALYSIS_NOT_FOUND", "analysis version was not found");
      return hydrateAnalysis(row);
    }],
    ["POST", /^\/analyses\/(\d+)\/review$/, (_req, _url, _body, match) => { reviewAnalysis(db, Number(match[1])); return { reviewed: true }; }],
  ];
  return async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      const body = await readJson(req);
      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const match = url.pathname.match(pattern);
        if (match) return sendJson(res, 200, await handler(req, url, body, match));
      }
      throw new ApiError(404, "NOT_FOUND", "route was not found");
    } catch (error) {
      const apiError = error instanceof ApiError ? error : new ApiError(500, "INTERNAL_ERROR", error instanceof Error ? error.message : "unknown error");
      sendJson(res, apiError.status, { error: { code: apiError.code, message: apiError.message, details: apiError.details } });
    }
  };
}

function object(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "VALIDATION_ERROR", "JSON object is required");
  return body as Record<string, unknown>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET") return {};
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new ApiError(400, "INVALID_JSON", "request body must be valid JSON"); }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(value, null, 2));
}

function paginate(db: DatabaseSync, sql: string, countSql: string, url: URL, ...params: Array<string | number>): PageResult<unknown> {
  const page = pageParams(url);
  const items = db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, page.limit, page.offset);
  const totalRow = db.prepare(countSql).get(...params) as { n: number };
  return { items, total: totalRow.n, limit: page.limit, offset: page.offset };
}

function hydrateAnalysis(row: unknown): unknown {
  const value = row as { result_json: string } & Record<string, unknown>;
  return { ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "result_json")), result: JSON.parse(value.result_json) };
}
