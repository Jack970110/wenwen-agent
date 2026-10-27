# 问问 Agent（wenwen-agent）

多能力 AI Agent 服务：**小说语义问答（RAG）+ 网文阅读数据分析 + 报告生成**，支持游客免登录体验与管理员模式，一条命令容器化部署。

```
┌────────────────────────── 浏览器 (Vue3 SPA) ──────────────────────────┐
│  对话 UI · 流式渲染 · 工具时间线 · 思维链折叠 · 小说库管理 · 深度思考开关 │
└───────────────────────────────┬───────────────────────────────────────┘
                          SSE 自定义事件协议 (text/tool/status/reasoning)
┌───────────────────────────────▼───────────────────────────────────────┐
│                        Node 服务端 (Hono + TS)                        │
│  ┌─ Agent Loop (AI SDK) ── stopWhen 护栏 + 滑窗上下文 + 断连取消       │
│  ├─ 工具层: queryChapters / analyzeTrend / generateReport / searchNovel│
│  ├─ 两阶段深度模式: 快模型检索 → Z1 纯推理合成（思维链）               │
│  ├─ RAG: 章节感知切块 → bge-m3 向量 → 余弦召回 → rerank 精排           │
│  ├─ MCP Server: stdio（宿主接入）+ HTTP（远程接入）双传输              │
│  └─ 会话隔离(游客/管理员) + 日限额/IP限频 + 错误分类降级               │
└───────────────────────────────┬───────────────────────────────────────┘
                                ▼
          SQLite(data卷) · 智谱 GLM · 硅基流动 bge-m3/reranker
```

技术栈：Node.js + TypeScript + Vercel AI SDK + Vue3/Pinia/Vite + Hono + SQLite(node:sqlite) + MCP 官方 SDK

## 功能特性

- **Agent 编排**：Agent loop + Function Calling 多工具自主路由；stopWhen 步数护栏；断连自动取消上游请求
- **RAG 小说问答**：章节感知切块、bge-m3 向量化、rerank 精排（命中率@1 58%→75%，评测集驱动）、回答标注书名+章节出处
- **深度思考**：三态路由（自动启发式/强制深度/强制快速）；两阶段架构——快模型检索、Z1 纯推理合成，思维链实时流式展示
- **多模型路由**：免费模型池（glm-4-flash / glm-z1-flash），模型名配置化，限流自动重试与降级
- **MCP 双传输**：同一工具能力以 Function Calling（进程内）与 MCP（stdio/HTTP）双通道暴露，接入 CodeBuddy/WorkBuddy 实测通过
- **分级权限**：游客免登录体验（会话按访客隔离、只读演示小说库）+ 管理员账号（多管理员，环境变量配置）
- **防薅护栏**：全站日限额 + 单 IP 限频 + 上传大小/格式校验 + 异步入库失败自动回滚
- **容器化**：多阶段 Docker 构建，数据卷持久化，`docker compose up -d` 一条命令上线

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 ZHIPU_API_KEY（open.bigmodel.cn 免费注册）
                       # 可选：SILICONFLOW_API_KEY（RAG 向量化用）、ADMIN_USERS（启用管理员）
```

| 模式 | 命令 | 说明 |
|---|---|---|
| **完整服务** | `npm run server` | http://localhost:3001 ，前后端同源（部署形态） |
| 前端开发 | `npm run frontend` | http://localhost:5173 热更新（注意：dev 代理会缓冲 SSE，测流式体验请用 3001） |
| CLI 对话 | `npm run dev` | 终端直接对话 |
| 小说入库 | `npm run ingest -- <txt> <书名>` | CLI 入库；Web 端可在页面直接上传 |
| 检索评测 | `npm run eval -- [K]` | 跑标注集算命中率@K |
| MCP 服务 | `npm run mcp:http` | HTTP 传输（stdio 由宿主按 .mcp.json 自动拉起） |
| Docker | `docker compose up -d` | 构建镜像 + 数据卷 + 自动重启 |

## 上线部署

```bash
# 服务器（2核2G 足够）
git clone https://github.com/Jack970110/wenwen-agent.git && cd wenwen-agent
cp .env.example .env   # 填 API key、设置强 ADMIN_USERS
docker compose up -d   # 数据卷 ./data 持久化会话与向量
# 备案通过后：nginx 反代 3001 + HTTPS 证书
```

安全设计：管理员账号环境变量配置（密码不出现在 cookie，HMAC 签名）；游客免登录但会话按访客隔离、只读演示库；全站日限额 + IP 限频防额度滥用；模型 key 只在服务端。

## RAG 检索质量（评测集驱动）

```
                    纯向量    + rerank 精排
命中率@3            100%      92%*
命中率@1             58%      75%   ← 排序显著改善
* 单条歧义标注，详见 eval 分析；评测集 12 条，扩充中
```

标注集：`data/eval-set.json`（问题 → 应命中的章节）；跑分：`npm run eval`。改切块/检索策略前后各跑一次，用数字而不是感觉做决策。

## 结构（学习重点）

```
src/
├── tools.ts            Function Calling 工具定义（zod 约束 + execute）
├── dataService.ts      业务逻辑层：协议无关，FC 与 MCP 共用
├── agent.ts            Agent loop（模型路由 + stopWhen + 滑窗上下文）
├── server.ts           Hono 服务：SSE 事件协议、分级权限、限流、静态托管
├── auth.ts             多管理员 HMAC cookie 鉴权
├── db.ts               会话持久化（node:sqlite）+ 限额计数
├── rag/
│   ├── chunker.ts      章节感知切块（元数据引用溯源的基础）
│   ├── embed.ts        bge-m3 向量化（429 指数退避重试）
│   ├── rerank.ts       cross-encoder 精排（免费 API，失败自动降级）
│   ├── retrieve.ts     统一检索入口：粗召回 → 精排
│   ├── store.ts        向量存储（SQLite + 暴力余弦，块数上万再迁 pgvector）
│   ├── ingestJob.ts    异步入库任务队列 + 进度
│   └── context.ts      AsyncLocalStorage 请求级检索边界
├── mcp-server.ts       MCP Server（stdio，宿主自动拉起）
├── mcp-http-server.ts  MCP Server（HTTP，无状态模式）
└── mcp-register.ts     MCP 工具注册（双传输共享）
frontend/               Vue3 + Pinia + Vite（useChatStream 统一 AI 交互层）
scripts/                诊断脚本（切块/深度模式/MCP 协议验证）
data/                   数据卷：会话库 + 向量库 + 评测集 + 示例小说
```

## Roadmap

- [x] v1 CLI Agent；v2 服务化 + Web UI + MCP 双传输；v3 RAG + 深度思考 + 分级权限 + 容器化（全部完成，详见 git log）
- [ ] 评测集扩充至 30+ 条（含歧义标注仲裁）
- [ ] 会话绑定小说（检索范围随会话持久化）
- [ ] 大文件上传体验优化（分片）

## 免费模型清单（零成本运行）

智谱：glm-4-flash（主力）、glm-z1-flash（深度思考）、4.6V-Flash（视觉备用）｜硅基流动：bge-m3（向量化）、bge-reranker-v2-m3（精排）。注意模型 ID 别带 `Pro/` 前缀（那是付费加速版）。
