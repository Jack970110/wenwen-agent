# 问问 Agent（wenwen-agent）

网文数据分析 Agent：自然语言提问 → Agent 自主调用工具（查数据 / 趋势分析 / 生成报告）→ 流式回复。

技术栈：Node.js + TypeScript + Vercel AI SDK + 智谱 GLM-4-Flash（免费）

## 运行

```bash
npm install
cp .env.example .env   # 填入 ZHIPU_API_KEY（open.bigmodel.cn 注册获取，免费）

# 方式一：Web 界面（推荐）
npm run server         # 打开 http://localhost:3001

# 方式二：CLI
npm run dev

# 方式三：MCP Server（供 CodeBuddy/Cursor/WorkBuddy 等宿主接入）
# stdio：宿主读取 .mcp.json 自动拉起，无需手动启动
npm run mcp:http       # HTTP 传输，监听 http://localhost:3002/mcp
npm run test:mcp       # 验证 stdio 全流程
npm run test:mcp:http  # 验证 HTTP 全流程
```

## 试试这些问题

- 看看第 1 到 8 章的数据，读者流失发生在哪里？
- 哪一章完读率最低？分析下原因并给我改进建议
- 帮我整体分析这本书的数据表现，出一份报告

## 结构（学习重点）

- `src/tools.ts` — 工具定义（Function Calling 的核心：zod 约束参数 + execute 执行）
- `src/dataService.ts` — 数据服务层：业务逻辑与协议解耦，Function Calling 和 MCP 共用
- `src/mcp-register.ts` — MCP 工具注册（stdio/HTTP 两种传输共享）
- `src/mcp-server.ts` — MCP Server（stdio 传输）：宿主拉起的本地子进程
- `src/mcp-http-server.ts` — MCP Server（HTTP 传输）：常驻服务，远程宿主可接入
- `src/test-mcp.ts` / `src/test-mcp-http.ts` — 两种传输的测试客户端（握手/列工具/调工具全流程）
- `.mcp.json` — 宿主接入配置（CodeBuddy / Cursor 通用）
- `src/agent.ts` — Agent loop（streamText + stopWhen 多步循环护栏 + abortSignal 取消）
- `src/server.ts` — Hono 服务：SSE 流式接口、事件协议（tool-call / text-delta / done / error）、断连时 abort 上游模型请求
- `src/db.ts` — 会话持久化（Node 22 内置 node:sqlite，零依赖）
- `web/index.html` — 聊天界面：流式渲染、工具调用时间线、停止生成（fetch 手动解析 SSE，支持 POST 推流）
- `src/index.ts` — CLI 版交互入口
- `src/mockData.ts` — mock 数据层，可换成真实数据库，工具层不变

## Roadmap

### v1 —— CLI 版 Agent ✅（已完成）

- [x] Agent loop（streamText + stopWhen 多步护栏）
- [x] 3 个工具：数据查询 / 趋势分析 / 报告生成（zod 约束 + execute）
- [x] CLI 流式输出 + 工具调用过程打印（可观测性）
- [x] 模型层错误分类处理（余额不足/限流）、工具级容错、失败上下文回滚

### v2 —— 服务化 + MCP

**v2a：服务端拆分 + Web UI** ✅
- [x] agent loop 挪进 Node 服务（Hono），暴露 SSE 流式接口 `POST /api/chat`
- [x] Web 前端：对话 UI、流式渲染（打字机）、工具调用过程可视化
- [x] 会话历史持久化（SQLite，node:sqlite 内置零依赖），支持多会话与历史回看
- [x] 前端"停止生成"→ 断开连接 → 服务端感知 abort 取消上游请求

**v2b：MCP Server** ✅
- [x] 工具逻辑抽为 dataService 层（业务与协议解耦，FC/MCP 共用）
- [x] MCP Server（stdio 传输）：queryChapters / analyzeTrend / generateReport 三个工具
- [x] 测试客户端验证完整协议流程（握手 → listTools → callTool）
- [x] `.mcp.json` 宿主接入配置（CodeBuddy / Cursor 可直接启用）
- [x] HTTP 传输（`npm run mcp:http`，端口 3002，无状态模式，每请求新建实例）

### v3 —— RAG + 上线要素

**v3a：迷你 RAG** ✅
- [x] 切块管道：章节识别 + 段落聚合（`src/rag/chunker.ts`）
- [x] 向量化：硅基流动 bge-m3（免费），批量入库 CLI（`npm run ingest`）
- [x] 向量存储：SQLite + 暴力余弦检索（块数上万再迁 pgvector）
- [x] `searchNovel` 工具接入 Agent，回答标注章节出处
- [x] RAG 质量调优：动态注入书单修触发、反幻觉规则、提炼式回答
- [x] 检索评测集 + 命中率跑分（`npm run eval`）：纯向量 @3=100% / @1=58%
- [x] rerank 精排（bge-reranker-v2-m3，粗召回 top10 → 精排，失败自动降级向量序）：@1 58%→**75%**，@3 100%→92%（单条歧义标注，详见评测分析）
- [x] 小说库 Web 管理：上传 txt（切块→向量化→入库，失败自动回滚）、列表、删除
- [x] 异步入库：任务队列 + 进度轮询；实测基准 7MB/240万字 ≈ 4 分钟（6000 块，~0.64s/批）
- [ ] 评测集扩充至 30+ 条（当前 12 条，单条歧义即 ±8pt 噪声；新增歧义标注仲裁）

**v3b：上线要素（生产化改造）**
- [ ] 鉴权：登录 + JWT
- [ ] 限流与成本控制：按用户限流、token 上限、护栏保留
- [ ] 超时与降级：链路超时、双模型供应商互备
- [ ] 可观测性：对话日志（问题/工具链/token 消耗/耗时）
- [ ] 内容安全：输入过滤 + prompt 注入防护
- [ ] 部署：Docker + 云服务器 + nginx（HTTPS），域名备案

### 迭代原则

每完成一个里程碑打一次 git tag。v2b（MCP）优先级最高——与简历中的 MCP 消费经验形成闭环；v3b 的知识优先于实操（面试考察的是"知道要做什么"）。
