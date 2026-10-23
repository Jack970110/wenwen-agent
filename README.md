# 问问 Agent（wenwen-agent）

网文数据分析 Agent：自然语言提问 → Agent 自主调用工具（查数据 / 趋势分析 / 生成报告）→ 流式回复。

技术栈：Node.js + TypeScript + Vercel AI SDK + 智谱 GLM-4-Flash（免费）

## 运行

```bash
npm install
cp .env.example .env   # 填入 ZHIPU_API_KEY（open.bigmodel.cn 注册获取，免费）
npm run dev
```

## 试试这些问题

- 看看第 1 到 8 章的数据，读者流失发生在哪里？
- 哪一章完读率最低？分析下原因并给我改进建议
- 帮我整体分析这本书的数据表现，出一份报告

## 结构（学习重点）

- `src/tools.ts` — 工具定义（Function Calling 的核心：zod 约束参数 + execute 执行）
- `src/agent.ts` — Agent loop（streamText + stopWhen 多步循环护栏）
- `src/index.ts` — CLI 交互 + 流式输出 + 工具调用过程打印（可观测性）
- `src/mockData.ts` — mock 数据层，v2 可换成真实数据库，工具层不变

## Roadmap

### v1 —— CLI 版 Agent ✅（已完成）

- [x] Agent loop（streamText + stopWhen 多步护栏）
- [x] 3 个工具：数据查询 / 趋势分析 / 报告生成（zod 约束 + execute）
- [x] CLI 流式输出 + 工具调用过程打印（可观测性）
- [x] 模型层错误分类处理（余额不足/限流）、工具级容错、失败上下文回滚

### v2 —— 服务化 + MCP

**v2a：服务端拆分 + Web UI**
- [ ] agent loop 挪进 Node 服务（Hono），暴露 SSE 流式接口 `POST /api/chat`
- [ ] Web 前端：对话 UI、流式渲染（打字机）、工具调用过程可视化
- [ ] 会话历史持久化（内存 → SQLite），支持多会话
- [ ] 前端"停止生成"按钮 → 服务端 abortController 取消上游请求

**v2b：MCP Server**
- [ ] 将 3 个工具封装为 MCP Server（STDIO + HTTP 两种 transport）
- [ ] 接入 CodeBuddy / Cursor 实际调用验证
- [ ] 产出对比：同一工具的 Function Calling 版 vs MCP 版的差异

### v3 —— RAG + 上线要素

**v3a：迷你 RAG**
- [ ] 接入 pgvector：书籍设定/角色知识库，问答带引用标注
- [ ] 检索召回测试（简单评测集）

**v3b：上线要素（生产化改造）**
- [ ] 鉴权：登录 + JWT
- [ ] 限流与成本控制：按用户限流、token 上限、护栏保留
- [ ] 超时与降级：链路超时、双模型供应商互备
- [ ] 可观测性：对话日志（问题/工具链/token 消耗/耗时）
- [ ] 内容安全：输入过滤 + prompt 注入防护
- [ ] 部署：Docker + 云服务器 + nginx（HTTPS），域名备案

### 迭代原则

每完成一个里程碑打一次 git tag。v2b（MCP）优先级最高——与简历中的 MCP 消费经验形成闭环；v3b 的知识优先于实操（面试考察的是"知道要做什么"）。
