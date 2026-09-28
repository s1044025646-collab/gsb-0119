#!/usr/bin/env node
import { openDb } from "./db";
import { config } from "./config";
import * as svc from "./service";
import { seed } from "./seed";
import { setClock, setRng, seededRng } from "./util/clock";

const db = openDb(config.dbPath);
const [cmd, ...args] = process.argv.slice(2);

function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function need(name: string): string {
  const v = arg(name);
  if (v === undefined) { console.error(`缺少参数 --${name}`); process.exit(2); }
  return v!;
}
const out = (o: unknown) => console.log(JSON.stringify(o, null, 2));

function waferState(id: number) {
  return { yield: svc.waferYield(db, id), pattern: svc.defectMap(db, id).pattern };
}

try {
  switch (cmd) {
    case "seed": {
      // 固定时钟与随机种子，保证可重复演示
      setClock(() => 1_700_000_000_000);
      setRng(seededRng(Number(arg("seed") ?? 42)));
      const r = seed(db, {
        scenario: (arg("scenario") as any) ?? "mixed",
        waferCount: Number(arg("wafers") ?? 6),
        includeRetestImprovement: arg("retest") !== "false",
        includeDuplicates: arg("duplicates") === "true",
        includeMissingCoords: arg("missing") === "true",
      });
      console.log("已生成虚构数据:"); out(r);
      break;
    }
    case "import": {
      // 从 JSON 文件导入原始测试结果: cli import --wafer 1 --program 1 --file dies.json
      const fs = require("node:fs");
      const waferId = Number(need("wafer")), programId = Number(need("program"));
      const dies = JSON.parse(fs.readFileSync(need("file"), "utf8"));
      console.log("导入前:"); out(waferState(waferId));
      out(svc.importResults(db, waferId, programId, dies));
      console.log("导入后:"); out(waferState(waferId));
      break;
    }
    case "map":
      out(svc.defectMap(db, Number(need("wafer"))));
      break;
    case "yield":
      out(svc.waferYield(db, Number(need("wafer"))));
      break;
    case "compare-chambers":
      out(svc.compareChambers(db, Number(need("step"))));
      break;
    case "retest": {
      const fs = require("node:fs");
      const waferId = Number(need("wafer"));
      const dies = JSON.parse(fs.readFileSync(need("file"), "utf8"));
      console.log("复测前:"); out(waferState(waferId));
      out(svc.recordRetest(db, waferId, dies, Number(need("program"))));
      console.log("复测后:"); out(waferState(waferId));
      break;
    }
    case "scrap":
      out(svc.scrapWafer(db, Number(need("wafer"))));
      break;
    case "split-lot":
      out(svc.splitLot(db, Number(need("from")), need("to"), need("wafers").split(",").map(Number)));
      break;
    case "new-program":
      out({ id: svc.changeProgram(db, need("name"), need("version")) });
      break;
    case "approve":
      out(svc.approveAnalysis(db, Number(need("analysis")), need("approver")));
      break;
    case "analyses": {
      out(db.prepare("SELECT id,scope,scope_id,version_no,reason,status,created_at FROM analysis_versions ORDER BY id").all());
      break;
    }
    case "export-report": {
      const lotId = Number(need("lot"));
      const wafers = db.prepare("SELECT id FROM wafers WHERE lot_id=? AND status='active'").all(lotId) as any[];
      const report = wafers.map((w) => svc.waferYield(db, w.id));
      const tested = report.reduce((s, r) => s + r.testedDie, 0);
      const passed = report.reduce((s, r) => s + r.passedDie, 0);
      out({ lotId, wafers: report, testedDie: tested, yield: tested ? passed / tested : null });
      break;
    }
    default:
      console.log(`用法: npm run cli -- <命令> [参数]
命令:
  seed [--scenario edge_ring|scratch|random|mixed] [--wafers N] [--seed N] [--duplicates true] [--missing true]
  import --wafer ID --program ID --file dies.json     导入原始测试(显示前后状态)
  map --wafer ID                                      生成缺陷图谱(含阈值与误判依据)
  yield --wafer ID                                    晶圆良率(分母口径)
  compare-chambers --step ID                          腔室良率比较(含小样本/混合产品警示)
  retest --wafer ID --program ID --file dies.json     记录复测(翻转自动生成新版本)
  scrap --wafer ID                                    报废晶圆(生成新版本)
  split-lot --from ID --to NAME --wafers 1,2,3        批次拆分
  new-program --name FT --version 2.0                 测试程序换版
  analyses                                            列出版本链
  approve --analysis ID --approver NAME               审核归因版本
  export-report --lot ID                              导出良率报告(JSON)`);
  }
} catch (e: any) {
  console.error(`错误 [${e.code ?? "INTERNAL"}] ${e.message}`);
  process.exit(1);
} finally {
  db.close();
}
