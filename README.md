# 半导体晶圆缺陷图谱与良率归因后端

本项目是一个纯本地、离线、只使用虚构数据的 TypeScript/Node.js/SQLite 后端。它提供 REST API、CLI、确定性演示数据生成器和自动化测试，不包含网页，也不连接真实产线或外部 MES。

运行时使用 Node.js 内置的 `node:sqlite`、HTTP Server 和 Test Runner；除 TypeScript 编译依赖外没有第三方运行时依赖。建议使用 Node.js 25 或支持内置 SQLite 的版本。

## 功能范围

- 管理产品、批次、拆分批次、晶圆、圆形网格芯片坐标、工序、设备和腔室。
- 管理测试程序版本、测试时间、复测、原始测试行、复测行和人工失效分析。
- 同一芯片的所有原始测试与复测均保留；分析分母只取每颗芯片的最新有效结果，重复测试行计入 `excludedDuplicateTestCount`。
- 无效边缘芯片保存在数据库但不进入良率分母；几何网格缺失坐标单独计数，也不进入分母。
- 缺陷图谱支持边缘环、划痕、局部聚集和随机缺陷；每类结果返回阈值、证据和误判依据。
- 按工序、设备、腔室输出良率差异；少于 3 片晶圆或混合产品只做描述性比较，不直接断言因果。
- 复测翻转、测试程序换版、晶圆报废、批次拆分和人工操作均可生成新分析版本；旧版本 JSON 与父版本链保持不变。
- 所有写入使用 `BEGIN IMMEDIATE` 事务；迁移可重复执行，关闭进程后 SQLite 文件可恢复状态。

## 安装与测试

```powershell
npm install
npm test
```

测试使用临时 SQLite 文件和确定性伪随机种子，覆盖边缘环、划痕、随机散点、缺失坐标、重复测试、复测改善、腔室换线、样本阈值、版本链、失败路径、API 分页/错误码以及重启恢复。

## 启动与停止

```powershell
npm start
```

默认数据库是 `data/wafer.sqlite`。未设置 `PORT` 时监听 `127.0.0.1` 的本机自动端口，启动日志会输出实际端口。停止服务使用 `Ctrl+C`。

也可以显式指定：

```powershell
$env:WAFER_DB="E:\temp\wafer.sqlite"
$env:PORT="8080"
npm start
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/health
```

## 可重复演示

```powershell
npm run demo
```

演示会在系统临时目录创建一次性 SQLite 数据库，依次生成虚构数据、绘制晶圆图谱、比较腔室、记录复测、保存并审核分析版本、导出报告，结束后清理临时目录。

## CLI

CLI 入口是 `dist/src/cli.js`，所有命令支持 `WAFER_DB`。

```powershell
node dist/src/cli.js generate --seed repeatable-demo
node dist/src/cli.js map --wafer 1
node dist/src/cli.js compare-chambers --batch 1
node dist/src/cli.js retest --wafer 2 --x -1 --y 0 --passed true --program 2
node dist/src/cli.js map --wafer 2 --save true
node dist/src/cli.js review --analysis 1
node dist/src/cli.js scrap-wafer --wafer 4
node dist/src/cli.js split-batch --batch 1 --name B-1001-SPLIT --wafers 2
node dist/src/cli.js export-report --batch 1 --out reports/batch-1.json
```

导入一条测试时通过 `--json` 传完整对象；CLI 会写入原始测试表，不覆盖旧测试：

```powershell
node dist/src/cli.js import-test --json '{"waferId":1,"x":0,"y":0,"programId":1,"kind":"initial","attempt":1,"passed":true}'
```

## API

JSON API 的主要路径：

- `GET /health`
- `GET /batches?limit=50&offset=0`
- `GET /wafers?batchId=1&limit=50&offset=0`
- `GET /dies?waferId=1&limit=200&offset=0`
- `POST /tests`
- `POST /retests`
- `POST /failure-analyses`
- `POST /wafers/{id}/scrap`
- `POST /batches/{id}/split`
- `POST /analyses`
- `GET /analyses/{id}`
- `POST /analyses/{id}/review`
- `POST /demo/generate`

请求和响应使用 JSON。错误响应格式为：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "waferId must be an integer between 1 and 9007199254740991"
  }
}
```

常见错误码包括 `VALIDATION_ERROR`、`INVALID_JSON`、`NOT_FOUND`、`DIE_NOT_FOUND`、`INVALID_EDGE_DIE`、`INITIAL_TEST_REQUIRED`、`WAFER_ALREADY_SCRAPPED`、`WAFER_NOT_IN_BATCH` 和 `ANALYSIS_NOT_FOUND`。

创建分析版本示例：

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:<port>/analyses `
  -ContentType 'application/json' `
  -Body '{"scope":"wafer","id":1,"trigger":"initial","triggeredBy":"demo"}'
```

## 判定口径

- 边缘环：至少 5 颗边缘失败芯片，且至少 60% 失败位于边缘 2.05 个芯片单位宽环带。
- 划痕：至少 5 颗失败芯片落在同一水平、垂直或 45 度候选线的 0.65 单位容差内，且占失败数至少 35%。
- 局部聚集：以失败芯片为中心、半径 2.25 单位内至少 4 颗失败芯片，且占失败数至少 25%。
- 不满足结构化条件时才回退为随机缺陷；结果同时给出未命中原因，避免把少量共线或边缘触碰误判为图谱。
- 腔室比较的可比条件是同一工序内单一产品且至少 3 片晶圆；差异是关联线索，不是因果证明。
