import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "src", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "wafer-demo-"));
const db = join(dir, "demo.sqlite");
const report = join(dir, "report.json");

function run(args) {
  console.log(`\n> wafer-cli ${args.join(" ")}`);
  process.stdout.write(execFileSync(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, WAFER_DB: db }, encoding: "utf8" }));
}

try {
  run(["generate", "--seed", "repeatable-demo"]);
  run(["map", "--wafer", "1"]);
  run(["compare-chambers", "--batch", "1"]);
  run(["retest", "--wafer", "2", "--x", "-1", "--y", "0", "--passed", "true", "--program", "2"]);
  run(["map", "--wafer", "2", "--save", "true"]);
  run(["review", "--analysis", "1"]);
  run(["export-report", "--batch", "1", "--out", report]);
  console.log(`\nDemo database: ${db}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
