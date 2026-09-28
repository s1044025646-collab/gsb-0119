# 半导体晶圆缺陷图谱与良率归因后端（虚构数据 / 本地运行）

TypeScript + Node.js + SQLite（`node:sqlite`，零原生依赖）。仅提供 **API、CLI、虚构数据生成器与自动化测试**，不包含网页，不连接真实产线。所有数据均为虚构。

## 环境要求

- Node.js >= 22（使用内置 `node:sqlite`；本机在 Node 25 验证）
- Windows / Linux / macOS 均可

## 安装与测试

```bash
npm install
npm test          # 10 个用例：空间分类/分母口径/样本阈值/版本链/重启恢复/失败路径/API 校验与分页
```

## 启动与停止

```bash
npm start                 # 启动 API，自动绑定本机空闲端口（127.0.0.1），控制台打印实际端口
# 停止：Ctrl+C
```

可用环境变量：`WAFER_DB`（数据库文件，默认 `wafer.db`）、`PORT`（默认 0 = 自动分配）。

## 可重复端到端演示

```bash
npm run demo      # 固定时钟+随机种子，重建 demo.db，演示全流程
```

演示内容：虚构数据生成 → 缺陷图谱（阈值与误判依据）→ 良率口径 → 腔室比较（小样本警示）→ 复测翻转生成新版本 → 换版/报废/拆分版本链 → 审核 → 导出良率报告。

## CLI

```bash
npm run cli -- seed --scenario mixed --wafers 6 --seed 42   # 生成虚构数据（edge_ring/scratch/random/mixed）
npm run cli -- import --wafer 1 --program 1 --file dies.json # 导入原始测试（显示前后状态）
npm run cli -- map --wafer 1                                # 缺陷图谱 + 检测阈值 + 误判依据
npm run cli -- yield --wafer 1                              # 良率（分母口径说明）
npm run cli -- compare-chambers --step 1                    # 腔室良率比较（小样本/混合产品不断言因果）
npm run cli -- retest --wafer 1 --program 1 --file dies.json # 记录复测（翻转自动生成新版本）
npm run cli -- scrap --wafer 1                              # 报废
npm run cli -- split-lot --from 1 --to LOT-X --wafers 2,3   # 批次拆分
npm run cli -- new-program --name FT --version 2.0          # 测试程序换版
npm run cli -- analyses                                     # 版本链
npm run cli -- approve --analysis 1 --approver qa           # 审核归因
npm run cli -- export-report --lot 1                        # 导出良率报告(JSON)
```

`dies.json` 格式：`[{"x":1,"y":2,"passed":true}, ...]`

## API 摘要

所有错误返回 `{"error":{"code","message"}}`，列表端点支持 `?limit=&offset=` 分页。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/lots` `/wafers` `/test-programs` `/defect-classes` `/steps` `/tools` `/chambers` `/routes` | 基础数据 |
| POST | `/results` | 导入原始测试（prime） |
| POST | `/retests` | 复测（翻转自动生成新分析版本） |
| GET | `/wafers/:id/results` `/wafers` `/lots` `/analyses` | 分页查询 |
| GET | `/wafers/:id/map` | 缺陷图谱（阈值+误判依据） |
| GET | `/wafers/:id/yield` | 良率（无效边缘芯片不计入分母，重复测试去重） |
| GET | `/steps/:id/chamber-compare` | 腔室/设备良率差异（含因果警示） |
| POST | `/wafers/:id/scrap` `/lot-splits` `/manual-fa` | 报废 / 拆分 / 人工失效分析 |
| POST | `/analyses/:id/approve` | 审核归因版本 |
| GET | `/lots/:id/yield-report` | 导出良率报告 |

## 设计要点

- **分母口径**：按晶圆直径与边缘 exclusion 计算圆形有效区域，无效边缘芯片不计入分母；同一芯片重复测试按芯片去重（取最新一条），原始（prime）与复测（retest）记录分别保留。
- **图谱分类**：边缘环（环带失效占比）、划痕（窄带+最小跨度，避免把点团误判为线）、局部聚集（半径邻域密度）、随机；阈值与触发规则写入 `evidence` 供人工审核。
- **归因谨慎性**：腔室比较在小样本（<5 片）或混合产品时 `causalClaimAllowed=false`，只给差异不断言因果。
- **版本链**：复测翻转、程序换版、报废、批次拆分、人工 FA 均生成新 `analysis_versions`，旧版本只读可复现；审核仅改状态。
- **事务与并发**：所有多写操作经 `withTx`（`BEGIN IMMEDIATE`，支持嵌套）；WAL 模式。
- **可测试性**：时钟与随机数经 `src/util/clock.ts` 注入，测试不依赖真实等待；迁移基于 `PRAGMA user_version`，可重复执行。

## 目录结构

```
src/db.ts            连接/迁移/事务
src/api.ts           HTTP API（校验/错误码/分页）
src/server.ts        服务入口（自动端口）
src/cli.ts           命令行
src/service.ts       良率/归因/版本链领域逻辑
src/domain/          几何与空间分类
src/seed.ts          虚构数据生成器（夹具场景）
scripts/demo.ts      端到端演示
test/core.test.ts    自动化测试
```
