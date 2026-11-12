# 经营数据采集编排台

面向连锁餐饮品牌的多平台经营数据采集与编排系统：把 **接口拉取、网页导出、下载中心取件、人工上传兜底** 统一为「来源任务」，每个 **门店 × 平台 × 账号 × 日期窗口** 都有独立执行记录、完整证据链与可溯源的统一日经营事实。

## 技术栈

| 层 | 技术 |
|---|---|
| API | TypeScript + NestJS 10 |
| 采集 | Playwright (Chromium) + BullMQ Worker |
| 队列 | Redis 7 + BullMQ（`collect` / `parse` 两个队列） |
| 存储 | PostgreSQL（任务/执行/步骤/文件/批次/原始行/事实/异常/接管） |
| 前端 | Vue 3 + Vite + Element Plus |
| 验证环境 | 可复现的模拟商家后台（3 个平台）+ 确定性 CSV/XLSX/JSON 数据 |

## 架构

```
┌──────────┐   ┌────────────┐   ┌─────────────────┐
│ Vue 运营台│──▶│ NestJS API │──▶│ PostgreSQL      │
└──────────┘   └─────┬──────┘   └─────────────────┘
                     │ enqueue           ▲
                ┌────▼─────┐   ┌─────────┴──────────┐
                │  Redis   │──▶│ Worker (BullMQ)    │
                │  BullMQ  │   │  ├ Playwright 浏览器流程 │
                └──────────┘   │  ├ API 拉取          │
                     ▲         │  └ 解析/规范化/入库   │
                     │         └─────────┬──────────┘
                ┌────┴───────────────────▼────┐
                │ 模拟商家后台 (mock-platform) │
                │  ALPHA 网页导出 / BETA 下载中心 │
                │  GAMMA 开放API / 场景控制端点   │
                └─────────────────────────────┘
```

## 快速开始（Docker 一键启动）

```bash
docker compose up -d --build
# 等待 web 容器构建完成后访问：
#   运营台     http://localhost:5173   （admin / admin123）
#   API       http://localhost:8080/api/health
#   模拟平台   http://localhost:4500    （场景控制见下文）
```

首次启动 postgres 容器会自动执行 `db/01_schema.sql` 与 `db/02_seed.sql`（4 门店、3 平台、13 账号）。

**跑通一次采集**：登录运营台 →「今日采集看板」→ 选择日期 →「生成当日任务」→ 观察矩阵状态变化 → 点门店进入「门店日视图」查看每个指标来自哪份原始文件。

**一键场景验证**（容器全部就绪后，在宿主机执行）：

```bash
MODE=docker node scripts/verify.mjs
```

## 本地开发模式（无 Docker）

依赖：Node 20+、PostgreSQL（本脚本使用用户级实例，端口 55432）、Redis、Playwright 浏览器（`cd worker && npx playwright install chromium`）。

```bash
# 1. 安装依赖
cd mock-platform && npm install && cd ../api && npm install && cd ../worker && npm install && cd ../web && npm install && cd ..
# 2. 启动全部（PostgreSQL 初始化+建表+种子、Redis、mock、api、worker、web）
bash scripts/dev-up.sh          # NO_WEB=1 可不启动前端
# 3. 访问 http://localhost:5173 （admin / admin123）
# 4. 停止
bash scripts/dev-down.sh
```

> 无 root 权限的环境若缺 Chromium 系统库：下载对应 .deb 解包到 `.syslibs/` 并设置 `LD_LIBRARY_PATH`（`scripts/dev-up.sh` 已自动探测该目录）。Docker 方式无此问题（worker 基于官方 Playwright 镜像）。

## 测试账号

**运营台（本系统）**：`admin / admin123`

**模拟商家后台**（仅用于团队已授权的测试环境）：

| 平台 | 来源类型 | 账号（密码均 `pass123`） | 说明 |
|---|---|---|---|
| ALPHA 星团外卖 | 网页导出 CSV | s001 / s002 / s003a / s003b / s004 | 日结切点 02:00（跨零点）；S003 双账号 |
| BETA 蓝雀到家 | 下载中心 XLSX | s001b / s002b / s003b / s004b | 异步生成 |
| GAMMA 星火开放平台 | API JSON | token：`g-token-s001` … `g-token-s004` | 当日数据返回 409 未出数 |

## 验证方式

### 自动化场景验证（推荐）

```bash
# Docker: MODE=docker node scripts/verify.mjs
# 本地:   bash scripts/dev-up.sh && node scripts/verify.mjs
```

`scripts/verify.mjs` 会重置场景与业务数据，然后依次验证（每个断言输出 ✅/❌，失败退出码非 0）：

| 场景 | 验证点 |
|---|---|
| 1 正常采集 | 13 个任务全部成功；事实指标与模拟平台期望值逐一相等（含 ALPHA 跨零点订单归属）；13 份有效文件；截图/原始行/空行与汇总行处理留痕 |
| 2 延迟下载 | 下载中心 25s 延迟生成后轮询等待并成功，等待步骤留痕 |
| 3 登录失效 | 账号锁定 → 任务安全暂停（waiting_human）→ 产生接管单 → 人工恢复 → 重跑成功 |
| 4 人机验证 | 出现验证码 → 安全暂停并附截图（不尝试规避）→ 人工接管 → 重跑成功 |
| 5 崩溃重启 | 采集中途 SIGKILL worker → 重启后任务自动恢复成功，中断 run 标记 interrupted |
| 6 重复导入 | 同一任务重复执行：文件数与事实值不变，识别 duplicate_hash |
| 7 修订替换 | 平台修订文件 → 新版 r2 active、旧版 r1 superseded、事实更新为修订值、新类型触发映射异常 |
| 8 人工补传 | 人工上传覆盖自动事实（origin=manual）；后续自动重跑不覆盖人工数据，自动文件标记 ignored_manual |
| 9 错误文件 | 平台给错文件 → 识别 WRONG_FILE，文件保留为 rejected 证据 |
| 10 页面改版 | 平台 DOM 改版 → 识别 ELEMENT_NOT_FOUND 并附失败现场截图 |

### 手工验证路径

1. **看板**：看板页选日期 → 生成任务 → 矩阵实时刷新（10s 轮询），缺报清单随任务成功而清空。
2. **溯源**：门店日视图 → 每个指标可看到 平台/账号/人工或自动/原始文件名/哈希/修订/解析版本，点击文件名可下载原始文件。
3. **人工接管**：用 `POST http://localhost:4500/__control` 打开场景（如 `{"path":"captcha:ALPHA","value":true}`），重跑任务后在「人工接管」页看到带截图的接管单，点「已处理，继续采集」。
4. **映射异常**：修订场景（`revision:GAMMA:S001:<日期>=2`）后重跑 GAMMA 任务，在「映射异常」页看到 `VIP_DISCOUNT` 未知类型记录。

### 模拟平台场景控制

`POST http://localhost:4500/__control` 体 `{"path": "...", "value": ...}`（`value: null` 取消）；`GET /__control` 查看；`POST /__reset` 全部重置。

| path | 效果 |
|---|---|
| `captcha:ALPHA` | 登录需人机验证（自动流程无法通过） |
| `sms:ALPHA` | 登录后进入短信验证页 |
| `confirm:ALPHA` | 导出前出现人工确认页 |
| `lock:ALPHA:s002` | 账号锁定 → 登录失效 |
| `expire:ALPHA` | 该平台全部会话一次性失效 |
| `delay:ALPHA` / `delay:GAMMA` | 导出/接口延迟毫秒 |
| `readyDelaySec:BETA` | 下载中心生成秒数 |
| `wrongfile:ALPHA` | 导出错误文件（日期+1） |
| `domvariant:ALPHA=b` | 页面元素改版（id 全变） |
| `revision:GAMMA:S001:2026-11-10=2` | 指定日期数据修订版（金额变化+新增未知类型行） |

数据生成是确定性的：同一 `(平台, 门店, 日期, 修订)` 永远得到相同内容；`GET /__expected?platform=&store=&date=` 返回该平台该日的期望聚合指标，验证脚本据此断言。

## 关键设计

**统一来源任务**：`source_tasks(门店×平台×账号×日期)` 唯一约束；`task_runs` 记录每次执行（含重跑/崩溃重试），`run_steps` 记录每一步骤与截图。

**幂等与去重**：文件 SHA256 与当前有效文件一致 → 不重复入库（`duplicate_hash`）；崩溃在解析前 → 补解析；事实表按 `(门店,平台,账号,日期,指标)` 唯一约束 upsert，重复汇总不可能发生。

**修订链**：内容变化的新文件 `revision+1` 并取代旧文件（`superseded`），旧文件与旧批次全部保留可下载。

**人工覆盖**：人工上传文件取代同键全部自动文件；之后到达的自动文件保留为 `ignored_manual` 证据但不解析；事实 upsert 的 WHERE 条件保证自动数据永远覆盖不了人工数据。

**跨零点日结**：平台表配置 `day_cutoff`（ALPHA=02:00），解析时按切点把记录归入营业日；文件内次日凌晨订单计入前一营业日。

**安全暂停**：识别验证码/短信/人工确认页/登录失效时，流程只暂停、截图、开接管单，**不尝试任何规避**；人工在线下处理完后一键恢复并重跑。

**崩溃恢复**：BullMQ stalled 检测 + worker 启动时把 `running` 的 run 标记 `interrupted` 并重新入队 `queued` 任务，双保险。

**证据链**：原始文件 + SHA256 + 下载时间 + 页面截图 + 执行步骤 + 解析版本（`parser.v1` / `map.<平台>.v1`）+ 入库批次，全部落库/落盘（`DATA_DIR`，compose 中为 `collector_data` 卷）。

## API 摘要（前缀 `/api`，Bearer 认证）

```
POST /auth/login                登录
GET  /dashboard?date=           今日采集矩阵+缺报+汇总
POST /tasks/generate {date}     生成当日全部来源任务
GET  /tasks?date=&status=       任务列表
GET  /tasks/:id                 任务详情（runs/files/interventions）
POST /tasks/:id/rerun           重跑
POST /tasks/rerun-window        重跑窗口（日期区间×门店×平台）
GET  /runs/:id/steps            执行步骤（含截图路径）
GET  /interventions?status=     人工接管单
POST /interventions/:id/resolve 人工已处理→恢复场景并重跑
GET  /files /files/:id/download 文件证据
POST /files/upload              人工补传（multipart）
GET  /stores/:id/daily?date=    门店日视图（指标+溯源）
GET  /issues                    映射异常
GET  /api/static/**             证据文件静态服务（原始文件/截图）
```

## 目录结构

```
├── db/                    # schema + 种子
├── mock-platform/         # 模拟商家后台（ALPHA/BETA/GAMMA + 场景控制）
├── api/                   # NestJS API
├── worker/                # BullMQ worker：Playwright 流程 + 解析规范化
├── web/                   # Vue 运营台
├── scripts/dev-up.sh      # 本地开发一键启动（无 Docker）
├── scripts/verify.mjs     # 端到端场景验证
└── docker-compose.yml     # 一键启动
```

## 验证结论（实际执行）

已在无 Docker 的 Linux 沙箱（Node 22 + 用户级 PostgreSQL 15 + Redis 7 + Chromium）中以 `node scripts/verify.mjs` 完整执行场景验证：**35 项断言全部通过**（输出见下文「验证记录」）。Docker Compose 配置与本地模式使用完全相同的构建与启动命令（`npm ci` → `npm run build` → `node dist/main.js`），worker 镜像为 Playwright 官方镜像。

### 验证记录（最近一次完整执行）

```
场景1 正常采集      8/8 通过（13 任务成功、指标与平台期望一致、证据链完整）
场景2 延迟下载      2/2 通过（25s 延迟后轮询成功）
场景3 登录失效      5/5 通过（安全暂停→人工恢复→重跑成功）
场景4 人机验证      3/3 通过（不规避验证，人工接管后成功）
场景5 崩溃重启      2/2 通过（SIGKILL 后自动恢复，run 标记 interrupted）
场景6 重复导入      2/2 通过（duplicate_hash，无重复汇总）
场景7 修订替换      3/3 通过（r2 取代 r1，事实更新，映射异常产生）
场景8 人工补传      4/4 通过（人工覆盖自动，自动不再覆盖人工）
场景9 错误文件      3/3 通过（WRONG_FILE 识别并保留 rejected 证据）
场景10 页面改版     3/3 通过（ELEMENT_NOT_FOUND 识别并截图）
```
