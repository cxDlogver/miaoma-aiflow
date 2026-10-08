# 妙码 AI Flow：企业知识库 RAG 全链路使用与答辩手册

> 文档定位：这不是一份只列页面按钮的产品说明，而是一条可以在面试或项目答辩中完整讲清的业务主线——如何把企业制度文档变成可检索的知识，再通过可视化工作流生成有依据的答案，最后发布为可运行应用。
>
> 验收日期：2026-08-21。本文结论来自完整源码阅读、浏览器实际操作、工作流逐节点追踪和本地测试，不是只根据界面截图推测。

## 1. 一句话讲清项目

妙码 AI Flow 是一个以可视化 DAG 工作流为核心的 AI 应用开发平台。用户可以创建知识库、上传文档、编排 Start / Knowledge / LLM / End 等节点，在编辑态测试并查看 Trace，再把工作流发布成稳定快照，通过公开 Web 页面或 API 调用。

本手册选择的答辩主线是：

```text
企业制度文档
  → Markdown 结构化切分
  → Ollama Embedding
  → Qdrant 向量存储
  → 向量 + 全文混合检索
  → RRF 排序融合
  → 检索证据注入 LLM
  → 生成答案
  → 发布快照
  → Web / API 交付
```

这条链路能同时体现 AI 能力和工程能力：RAG、Embedding、向量库、检索融合、Prompt、DAG 编排、变量传递、SSE、可观测性、版本发布和 API 鉴权都在同一个业务闭环中。

## 2. 本次到底做了什么

为避免答辩时把“阅读过项目”说成“亲手开发了全部模块”，先明确工作边界。

### 2.1 项目原有能力

- Turborepo + pnpm Monorepo 工程；
- Next.js 管理端和公开运行端；
- NestJS 发布应用 API；
- 自研 DAG 工作流引擎和节点执行器注册机制；
- PostgreSQL 业务数据、Qdrant 向量数据、Ollama 模型调用；
- 知识库上传、切分、向量化、三种检索模式；
- 编辑态测试、逐节点 Trace、发布快照、API Key 和执行日志。

### 2.2 本次分析与验收实际完成的工作

- 阅读并梳理了管理端、公开运行端、API Server、AI Engine、Prisma Schema 和 Docker 基础设施；
- 选择“企业制度知识问答”作为一条完整答辩链路，配置四节点 RAG 工作流；
- 新增可复现的验收文档 `docs/acceptance/企业员工手册.md`；
- 新增仅用于本地协议联调的确定性 Ollama 兼容桩 `docs/acceptance/mock-ollama.mjs`；
- 通过浏览器实际完成知识库召回、工作流运行、节点追踪、更新发布和公开应用运行；
- 运行 AI Engine 测试和三个应用的 TypeScript 类型检查；
- 从源码审计出当前架构边界、已知风险和后续演进方案。

如果把本手册用于个人答辩，请将“我负责设计/实现”的范围改成自己的真实工作范围；可以直接陈述本节的事实，不要把团队或原项目已有代码全部归到自己名下。

## 3. 为什么选择 RAG 工作流，而不是泛泛讲 Agent

项目数据库中虽然预留了 `AGENT` 应用类型，依赖中也声明了 LangGraph，但当前主执行路径是自研 DAG 引擎：先拓扑排序，再由注册表找到节点执行器，按确定顺序运行。现有链路没有自主规划循环、动态工具选择、长期记忆写回、反思或 Human-in-the-loop，因此准确说法是“AI 工作流 + RAG”，不是自治 Agent。

这个边界在答辩中反而是加分项：

- 固定业务流程更适合 DAG，可预测、易审计、易回放；
- 企业知识问答最核心的问题是“证据是否被正确找回”，不是让模型自己规划；
- 只有当需求出现多步自主决策、动态选工具、失败后改计划时，才应升级为 Agent；
- 不为了追热点而滥用 Agent，体现的是架构判断力。

## 4. 已完成的真实效果验收

### 4.1 知识库混合检索

查询“年假”时，系统采用混合检索、Top K=5、阈值=0，9ms 返回 2 个切片，第一名是“年假制度”。

![知识库混合检索结果](./images/01-knowledge-retrieval.png)

图中 1.6% 和 1.1% 是 RRF 融合分数，不是“回答正确率”。RRF 的原始分数天然较小，产品界面更适合显示“融合分”或排序名次，不应直接格式化成相似度百分比。

### 4.2 四节点 RAG 画布

实际工作流为：用户问题 → 制度知识检索 → 基于证据生成答案 → 返回答案。

![RAG 工作流画布](./images/02-rag-workflow-canvas.png)

### 4.3 编辑器测试结果

输入“年假”后，四个节点全部成功，最终返回年假天数、申请时点和审批条件。

![编辑器运行结果](./images/03-rag-run-result.png)

### 4.4 节点级 Trace

Trace 能看到 Knowledge 节点的输入、输出、检索模式、结果条数、耗时以及变量解析日志。实测节点耗时为：Start 1ms、Knowledge 12ms、LLM 4ms、End 0ms。

![知识检索节点 Trace](./images/04-node-trace.png)

### 4.5 更新发布

编辑态配置更新后，通过“更新发布”生成新的不可变快照，并把应用的 `activePublishedId` 切换到最新版本。

![应用更新发布](./images/05-published-app.png)

### 4.6 公开应用验收

公开运行页读取激活的发布快照，而不是编辑草稿。更新发布后再次输入“年假”，4/4 节点完成，总耗时 34ms。

![公开应用运行结果](./images/06-public-app-run.png)

### 4.7 关于这次模型结果的真实性

本机验收时没有预装 `qwen3:8b` 和 `mxbai-embed-large:latest`，因此使用了仓库内新增的确定性 Ollama 协议桩：

- 它真实验证了文档上传、切分、Embedding HTTP 协议、Qdrant 入库、混合检索、变量传递、LLM 节点调用、SSE、发布快照和公开页面；
- 它返回固定、可复现的 1024 维向量和基于验收样本文本的答案；
- 它不代表真实大模型的语义质量、吞吐、首 Token 延迟或幻觉率；
- 做正式演示时，应切换到真实 Ollama 模型并重新进行质量评测。

这一区分必须在答辩中主动说明，工程联调成功不等于模型效果已经通过生产验收。

## 5. 项目结构与技术栈

```text
miaoma-aiflow/
├── apps/
│   ├── workflow/       # Next.js 16 管理端：知识库、编辑器、测试、发布、日志
│   ├── webapp/         # Next.js 16 公开运行端，默认 3001
│   └── api-server/     # NestJS 11 发布应用 API，默认 3100
├── packages/
│   └── ai-engine/      # 工作流内核、节点执行器、RAG、Qdrant、Ollama
├── docker/
│   ├── docker-compose.yml
│   ├── postgresql_data/
│   └── qdrant_storage/
├── docs/
│   ├── acceptance/     # 本次可复现验收样本和 Ollama 兼容桩
│   └── images/         # 浏览器实操截图
├── package.json
└── turbo.json
```

| 层次 | 技术 | 作用 |
|---|---|---|
| 工程 | pnpm 9.12.3、Turborepo | Monorepo 依赖和任务编排 |
| 管理端 | Next.js 16.1.1、React 19、Tailwind、Radix UI | 知识库、流程画布、测试和发布 |
| 流程画布 | `@xyflow/react` | 节点、连线、缩放和可视化编排 |
| 公开运行端 | Next.js 16.1.1、SSE | 根据发布快照动态生成表单并展示执行过程 |
| 开放 API | NestJS 11 | API Key 鉴权、同步/SSE 执行、生产日志 |
| AI 抽象 | LangChain Core、`@langchain/ollama` | 消息模型和 Ollama 调用 |
| 工作流内核 | 项目自研 DAG Engine | 校验、拓扑排序、变量上下文、节点执行 |
| 业务数据库 | PostgreSQL 18、Prisma 7 | 用户、应用、工作流、版本、执行和知识库元数据 |
| 向量数据库 | Qdrant | 1024 维向量、Chunk Payload、知识库过滤 |
| 本地模型 | Ollama | `qwen3:8b` 生成，`mxbai-embed-large:latest` 嵌入 |

注意：`@langchain/langgraph` 当前只存在于依赖声明中，核心执行代码没有使用 `StateGraph`。答辩时不要说“工作流由 LangGraph 执行”。

## 6. 从零启动项目

### 6.1 环境要求

- Node.js 20 LTS；本次通过版本为 Node 20.20.2；
- pnpm 9.12.3；
- Docker Desktop；
- 正式模型验收需要 Ollama；
- 推荐内存 16GB 以上；运行 8B 模型时按量化版本和硬件调整。

不要使用 Node 26 运行当前 Qdrant JS 客户端。本次实测在 Node 26.5.0 下出现 Undici `UND_ERR_INVALID_ARG`，导致 `Failed to ensure collection: fetch failed`；切换到 Node 20 后 Qdrant 集成测试和文档入库均成功。

### 6.2 安装依赖

```bash
corepack enable
corepack prepare pnpm@9.12.3 --activate
pnpm install
```

### 6.3 配置环境变量

管理端 `apps/workflow/.env.local` 至少需要：

```dotenv
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5433/postgres"
JWT_SECRET="replace-with-a-long-random-secret"
NEXT_PUBLIC_APP_URL="http://localhost:3000"
NEXT_PUBLIC_WEBAPP_URL="http://localhost:3001"
QDRANT_URL="http://localhost:6333"
```

公开运行端 `apps/webapp/.env.local`：

```dotenv
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5433/postgres"
QDRANT_URL="http://localhost:6333"
```

API Server `apps/api-server/.env`：

```dotenv
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5433/postgres"
PORT=3100
NODE_ENV=development
QDRANT_URL="http://localhost:6333"
OLLAMA_BASE_URL="http://localhost:11434"
```

当前 AI Engine 的 Ollama Executor 实际使用默认地址 `http://localhost:11434`：API Server 虽把 `OLLAMA_BASE_URL` 传给 Engine，但默认注册表没有继续把它注入 LLM/Embedding Executor。这是后文 P0 配置注入问题的具体表现；在修复前，请让 Ollama 监听默认端口，不要误以为修改该变量就能切换地址。

不要把真实密码、JWT Secret 或 API Key 写进文档和版本库。项目现有环境文件中如有示例密钥，应在部署前轮换并改用密钥管理系统。

### 6.4 启动 PostgreSQL 和 Qdrant

```bash
pnpm docker:start
docker compose -f docker/docker-compose.yml -p miaoma-aiflow ps
```

默认端口：PostgreSQL `5433`、Qdrant REST `6333`、Qdrant gRPC `6334`。

### 6.5 初始化 Prisma

迁移文件位于 `apps/workflow/prisma/migrations`。首次初始化可执行：

```bash
pnpm --dir apps/workflow exec prisma generate
pnpm --dir apps/workflow exec prisma migrate deploy
pnpm --dir apps/webapp exec prisma generate
pnpm --dir apps/api-server exec prisma generate
```

### 6.6 启动真实 Ollama

```bash
ollama serve
ollama pull mxbai-embed-large:latest
ollama pull qwen3:8b
```

可以先确认协议服务：

```bash
curl http://localhost:11434/api/version
curl http://localhost:11434/api/tags
```

### 6.7 仅用于协议联调的兼容桩

如果当前机器没有模型，但要验收工作流工程链路：

```bash
node docs/acceptance/mock-ollama.mjs
```

兼容桩占用 `11434`，不能与真实 Ollama 同时监听同一端口。结束协议联调后停止它，再启动真实 Ollama。

### 6.8 启动三个应用

```bash
# 管理端和公开运行端
pnpm dev

# 如果根任务没有包含 NestJS，另开终端启动 API Server
pnpm --filter @miaoma-aiflow/api-server start:dev
```

入口地址：

| 地址 | 用途 |
|---|---|
| `http://localhost:3000` | 管理端 |
| `http://localhost:3001/workflow/{appId}` | 已发布应用运行页 |
| `http://localhost:3100/api/v1/apps/run` | API Key 鉴权的执行入口 |
| `http://localhost:6333/dashboard` | Qdrant Dashboard |

## 7. 用浏览器复现企业制度问答

### 7.1 创建知识库

1. 登录管理端，进入“知识库”。
2. 新建知识库，名称可填“企业制度知识库”。
3. Embedding 模型选择 `mxbai-embed-large:latest`，维度保持 1024。
4. Chunk Size 设为 500，Overlap 设为 50。
5. 检索模式选择“混合检索”，向量权重保持 0.7，Top K 设为 5。

### 7.2 上传文档

上传 [企业员工手册](./acceptance/企业员工手册.md)。接口支持 TXT、MD、JSON、CSV、HTML，单文件最大 10MB。

上传 API 会先创建 PostgreSQL `Document` 记录并返回，再异步执行切分、Embedding 和 Qdrant Upsert。页面看到 `PENDING → PROCESSING → COMPLETED` 后再做召回测试。

### 7.3 做召回测试

1. 进入“召回测试”。
2. 输入“年假”。
3. 选择“混合检索”。
4. Top K=5；演示样本可以把阈值设为 0，以便观察两路融合结果。
5. 确认“年假制度”排在第一名，并检查内容是否包含 10 天、提前 3 个工作日和超过 5 天需审批。

如果召回不正确，应先调切分、Embedding、检索模式和阈值，不要直接改 Prompt。RAG 的第一性问题是证据是否找对。

### 7.4 创建工作流应用

新建 Workflow 应用，例如“企业制度知识问答助手”，依次添加并连接四个节点：

| 节点 | 关键配置 | 输出 |
|---|---|---|
| Start / 用户问题 | 输入名 `question`，字符串，必填 | `${start-1.question}` |
| Knowledge / 制度知识检索 | Query=`${start-1.question}`；选企业制度知识库；Hybrid；Top K=5；Threshold=0；Text 输出 | `${knowledge-1.output}` |
| LLM / 基于证据生成答案 | 模型 `qwen3:8b`；系统提示要求只依据证据回答；用户提示注入问题和检索文本 | `${llm-1.output}`、`${llm-1.tokens}` |
| End / 返回答案 | 输出名 `answer`，字符串，值 `${llm-1.output}` | 最终 JSON |

推荐 Prompt：

```text
System:
你是企业制度问答助手。只能根据提供的检索证据回答；证据不足时明确说“不知道”，
不要编造制度。回答要简洁，并指出依据来自哪一份制度文档。

User:
用户问题：${start-1.question}

检索证据：
${knowledge-1.output}

请根据证据回答用户问题。
```

### 7.5 测试、Trace 和发布

1. 等待编辑器自动保存，或点击“保存”。
2. 点击“测试运行”，输入 `question=年假`。
3. 在“结果”页检查最终 JSON。
4. 在“追踪”页逐节点检查输入、输出、耗时和日志。
5. 点击“发布”；后续修改后点击“更新发布”。
6. 点击“运行”进入公开页面，再执行一次端到端验收。

编辑器测试记录写入 `WorkflowExecution`；公开 Web 或 API 调用写入 `AppExecution`。因此在编辑器做完测试后，侧边栏“日志”页面可能仍显示没有 API 执行，这不是测试结果丢失，而是两类执行记录分表管理。

## 8. 整体架构

```mermaid
flowchart LR
    U[平台用户] --> Admin[Next.js 管理端 :3000]
    Admin --> PG[(PostgreSQL :5433)]
    Admin --> Engine[AI Engine]
    Admin -->|上传文档| Processor[Document Processor]
    Processor --> Splitter[Markdown/Text Splitter]
    Splitter --> Embed[Ollama Embedding :11434]
    Embed --> Q[(Qdrant :6333)]

    Engine --> Q
    Engine --> Ollama[Ollama Chat Model]
    Admin -->|发布快照| PG

    V[最终用户] --> Web[Next.js Webapp :3001]
    Web --> PG
    Web --> Engine

    C[API 调用方] --> API[NestJS API :3100]
    API -->|API Key Guard| PG
    API --> Engine
```

核心设计不是让每个前端自己实现一套 AI 逻辑，而是让管理端测试、公开 Web 和 NestJS API 共同复用 `@miaoma-aiflow/ai-engine`。

## 9. 离线入库链路：文档如何变成知识

```mermaid
sequenceDiagram
    participant UI as 管理端
    participant API as Documents API
    participant PG as PostgreSQL
    participant DP as Document Processor
    participant OL as Ollama Embedding
    participant Q as Qdrant

    UI->>API: multipart 上传文件
    API->>API: 类型和 10MB 大小校验
    API->>PG: 创建 Document(PENDING)
    API-->>UI: 已接收，后台处理中
    API->>DP: 异步 processDocument
    DP->>PG: 状态改为 PROCESSING
    DP->>DP: Markdown/Text 切分 + Overlap
    DP->>OL: 批量生成 1024 维向量
    DP->>Q: ensureCollection + batch upsert
    DP->>PG: Document=COMPLETED，更新 Chunk 数
```

### 9.1 为什么 Markdown 单独切分

普通按字符切分会把标题与正文打散。`MarkdownSplitter` 先识别标题层级，再在 Section 内按标点和换行寻找较自然的边界，同时保留 `headerPath` 等元数据。这样做有两个价值：

- 召回片段仍然带有“年假制度”这样的语义标题；
- 后续可以把标题路径作为引用、过滤或重排特征。

### 9.2 Chunk Size 和 Overlap 如何取值

设文档长度为 `L`、切片长度为 `C`、重叠为 `O`，近似切片数为：

```text
N ≈ ceil((L - O) / (C - O))
```

- `C` 太小：语义不完整，向量数量和成本上升；
- `C` 太大：一个向量混合多个主题，召回不精确，Prompt 也更长；
- `O=0`：跨边界事实容易被截断；
- `O` 太大：重复证据增加，Qdrant 和 LLM 成本上升。

当前默认 500/50 适合短制度条款作为起点，但不应当成所有文档的固定最优值。正式项目应基于问题集做离线评测。

### 9.3 向量存储的数据分工

- PostgreSQL 保存知识库和文档的业务状态、原文、配置、计数；
- Qdrant 保存每个 Chunk 的向量及 Payload；
- Payload 包含 `chunkId`、`content`、`chunkIndex`、`documentId`、`knowledgeBaseId` 和 metadata；
- Qdrant 对 `knowledgeBaseId`、`documentId` 建 Keyword Payload Index，用于隔离和删除；
- Collection 使用 Cosine Distance，Upsert 每批最多 100 条。

这种“双存储”设计把事务型元数据和高维相似度搜索分开，各自使用擅长的数据库。

## 10. 在线问答链路：一次请求如何执行

```mermaid
sequenceDiagram
    participant User as 用户
    participant Runner as Web / Editor Runner
    participant Engine as Workflow Engine
    participant K as Knowledge Executor
    participant Q as Qdrant
    participant E as Ollama Embedding
    participant L as LLM Executor

    User->>Runner: question=年假
    Runner->>Engine: execute(workflow, inputs)
    Engine->>Engine: 校验 DAG、检测环、拓扑排序
    Engine->>Engine: Start 输出 question
    Engine->>K: 解析 ${start-1.question}
    par 向量召回
        K->>E: 查询文本向量化
        K->>Q: cosine search + KB filter
    and 全文召回
        K->>Q: scroll payload + 文本匹配
    end
    K->>K: RRF 融合排序
    K-->>Engine: output/results/count/mode
    Engine->>L: 注入问题和检索证据
    L->>L: ChatOllama.invoke
    L-->>Engine: output/tokens
    Engine->>Engine: End 收集 answer
    Engine-->>Runner: result + node events + logs
    Runner-->>User: 展示答案和 4/4 进度
```

## 11. 混合检索的原理

### 11.1 向量检索

查询先经 Embedding 转成 1024 维向量，再在 Qdrant 中做 Cosine 相似度搜索。它擅长语义近似，例如“休年休假有几天”和“年假制度”用词不同也可能相近。

### 11.2 当前全文检索

当前实现不是 PostgreSQL FTS、Elasticsearch BM25 或 Qdrant Sparse Vector。它会从指定知识库 Scroll 最多 1000 个 Payload，在 Node.js 中做完整查询和分词包含匹配，再把分数归一化。

它适合教学、小数据量和中文关键词精确命中，但大规模时会有明显问题：

- 1000 条上限可能漏召回；
- 复杂度随扫描 Chunk 数上升；
- 没有真正的倒排索引、IDF、字段权重和语言分词；
- 正则直接使用查询词，特殊字符需要更严谨的转义。

### 11.3 RRF 融合

系统把向量结果和全文结果各扩展到 `ceil(TopK × 1.5)`，再用加权 Reciprocal Rank Fusion：

```text
RRF(d) = 0.7 / (60 + rank_vector(d))
       + 0.3 / (60 + rank_fulltext(d))
```

这里 rank 从 1 开始。RRF 不要求两种检索分数处于同一量纲，只关心名次，因此比直接把 Cosine 分数和关键词分数相加更稳定。

### 11.4 为什么当前截图的分数很小

如果一个 Chunk 在两路都排第一：

```text
0.7 / 61 + 0.3 / 61 = 1 / 61 ≈ 0.01639
```

格式化成百分比就是约 1.6%。它表示“融合后的排序值”，不是只有 1.6% 相关，更不是 1.6% 正确率。

## 12. 工作流内核设计

### 12.1 DAG 和拓扑排序

`GraphBuilder` 根据 Edges 建立邻接表、反向邻接表和入度表：

1. 把所有入度为 0 的节点加入队列；
2. 依次出队并降低后继节点入度；
3. 后继入度变为 0 时入队；
4. 执行前另用 DFS 检测环；
5. 最终得到可执行顺序。

对于本案例，顺序稳定为：

```text
start-1 → knowledge-1 → llm-1 → end-1
```

### 12.2 节点执行器注册机制

`NodeRegistry` 使用 `Map<NodeKind, NodeExecutor>` 注册 Start、LLM、HTTP、Condition、End、Knowledge 执行器。Engine 只依赖统一的 `execute / validate / getOutputSchema` 协议，因此新增节点时不需要在主循环里写一长串 `if/else`。

这是典型的策略模式 + 注册表设计，扩展一个新节点的步骤是：

1. 定义配置和输出 Schema；
2. 继承 `BaseNodeExecutor`；
3. 实现 `doExecute` 和校验；
4. 注册到 `NodeRegistry`；
5. 在编辑器增加节点卡片和设置表单。

### 12.3 变量协议

节点通过 `${nodeId.variableName}` 传递数据。`ExecutionContext` 内部用 Map 保存每个节点的输出；`VariableResolver` 支持解析单个表达式和嵌入文本的多个表达式；`BaseNodeExecutor` 会递归解析配置中的字符串、数组和对象。

这个设计把 UI 连线和运行时数据契约统一起来：边决定执行依赖，变量表达式决定具体取哪一个输出。

### 12.4 节点生命周期

`BaseNodeExecutor` 统一处理：

```text
校验配置
  → nodeStart 日志
  → 深度解析变量
  → doExecute
  → 成功输出写入上下文
  → nodeEnd 日志
  → 捕获异常并转换为统一 NodeExecutionResult
```

因此 Start、Knowledge、LLM、End 只关心自己的业务逻辑。

### 12.5 可观测性

Engine 暴露 `onNodeStart`、`onNodeEnd`、`onLog` 回调。管理端和公开运行端把回调转成 SSE 或界面状态，并记录：

- 执行 ID；
- 节点名、节点类型和状态；
- 输入、输出、耗时；
- 变量解析；
- LLM 请求/响应摘要；
- 错误和命中的条件分支。

日志器会隐藏 Authorization、API Key、Cookie 等敏感 Header，并截断过长的输出。但 Prompt 本身仍可能包含敏感业务数据，生产环境还需要分级脱敏和访问审计。

## 13. 草稿、发布与运行隔离

```mermaid
flowchart LR
    W[Workflow 编辑草稿] -->|保存| W
    W -->|发布/更新发布| P[PublishedApp 不可变快照]
    P -->|activePublishedId| A[App 当前激活版本]
    A --> Web[公开 Web]
    A --> API[NestJS API]
    Web --> AE[AppExecution]
    API --> AE
    W -->|编辑器测试| WE[WorkflowExecution]
```

| 模型 | 职责 |
|---|---|
| `App` | 应用入口、发布状态、当前激活版本 |
| `Workflow` | 可持续编辑的节点和边 |
| `PublishedApp` | 发布时复制出的名称、节点、边快照 |
| `WorkflowExecution` | 编辑器测试执行 |
| `AppExecution` | 公开 Web 或 API 对发布快照的执行 |
| `ApiKey` | 绑定应用、启停、过期时间、使用次数 |

这样做解决了“开发者正在修改画布，线上用户却立即受到影响”的问题。公开运行只读激活快照，只有明确发布后才切流。

## 14. API 使用

### 14.1 创建 API Key

进入应用的“访问 API”页面，创建 Key。完整 Key 应只在创建时展示一次；调用时放在 Bearer Header 中。

ApiKey Guard 会检查：

- Header 是否是 `Bearer <API_KEY>`；
- Key 是否存在、是否启用、是否过期；
- 关联应用是否删除；
- 应用是否存在激活发布版本；
- 成功后更新 `lastUsedAt` 和 `usageCount`。

### 14.2 同步调用

```bash
curl -X POST http://localhost:3100/api/v1/apps/run \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "inputs": {"question": "年假"},
    "stream": false
  }'
```

### 14.3 SSE 调用

```bash
curl -N -X POST http://localhost:3100/api/v1/apps/run \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "inputs": {"question": "年假"},
    "stream": true
  }'
```

SSE 事件包括 `node:start`、`node:end`、`log`、`complete` 和 `error`。它提供的是节点级实时进度；当前 LLM Executor 使用 `invoke`，还不是按 Token 增量输出。

## 15. 源码导航：答辩时指到哪里

| 要讲的内容 | 关键源码 |
|---|---|
| 引擎总循环、校验、拓扑执行 | `packages/ai-engine/src/core/engine.ts` |
| DAG、拓扑排序、环检测、分支排除 | `packages/ai-engine/src/core/graph-builder.ts` |
| 变量上下文 | `packages/ai-engine/src/core/context.ts` |
| `${node.variable}` 解析 | `packages/ai-engine/src/core/variable-resolver.ts` |
| 节点公共生命周期 | `packages/ai-engine/src/nodes/base-executor.ts` |
| 内置节点注册 | `packages/ai-engine/src/nodes/index.ts`、`registry.ts` |
| 知识节点 | `packages/ai-engine/src/nodes/executors/knowledge-executor.ts` |
| LLM 节点 | `packages/ai-engine/src/nodes/executors/llm-executor.ts` |
| End 输出收集 | `packages/ai-engine/src/nodes/executors/end-executor.ts` |
| Markdown 结构化切分 | `packages/ai-engine/src/knowledge/chunking/markdown-splitter.ts` |
| Embedding | `packages/ai-engine/src/knowledge/embeddings/ollama-embeddings.ts` |
| Qdrant Collection、Upsert、搜索 | `packages/ai-engine/src/knowledge/store/qdrant-store.ts` |
| 三种检索和 RRF | `packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts` |
| 文档处理流水线 | `apps/workflow/lib/services/document-processor.ts` |
| 上传接口 | `apps/workflow/app/api/knowledge/[id]/documents/route.ts` |
| 召回测试接口 | `apps/workflow/app/api/knowledge/[id]/search/route.ts` |
| 编辑器测试运行 | `apps/workflow/app/api/apps/[id]/workflow/run/route.ts` |
| 发布快照 | `apps/workflow/app/api/apps/[id]/publish/route.ts` |
| 公开运行 SSE | `apps/webapp/app/api/workflow/[id]/run/route.ts` |
| API Key Guard | `apps/api-server/src/common/guards/api-key.guard.ts` |
| NestJS 同步/SSE 执行 | `apps/api-server/src/modules/workflow/workflow.service.ts` |
| 全部数据模型 | `apps/workflow/prisma/schema.prisma` |

## 16. 实测结果

| 验收项 | 结果 |
|---|---|
| 知识库样本文档 | 1 份成功文档，切分为 4 个 Chunk |
| 混合召回 | “年假”返回 2 个相关 Chunk，年假制度排第 1 |
| 召回接口耗时 | 浏览器实测 9ms |
| 编辑器工作流 | Start / Knowledge / LLM / End，4/4 成功 |
| 节点耗时 | 1ms / 12ms / 4ms / 0ms |
| 发布 | 更新发布成功，公开页读取最新快照 |
| 公开页 | 4/4 成功，总耗时 34ms |
| AI Engine 测试 | Node 20 下 4 个测试文件、58 个测试全部通过，包含 Qdrant 集成测试 |
| 管理端类型检查 | 通过 |
| Webapp 类型检查 | 通过 |
| API Server `tsc --noEmit` | 通过 |

验收环境里知识库页面显示 3 份文档，是因为最初使用 Node 26 联调时留下了 2 条 `ERROR` 记录；成功数据仍是 1 份文档、4 个 Chunk。这两条失败记录帮助定位了运行时兼容问题，没有把它们伪装成成功数据。

测试时还有一个版本告警：项目 `@qdrant/js-client-rest` 为 1.16.2，本地 Qdrant Server 为 1.19.0。功能已通过，但生产环境应该固定 Server 镜像版本，并让 Client/Server 版本处于官方兼容范围，而不是使用 `qdrant/qdrant:latest`。

## 17. 当前实现的关键问题与改进路线

### P0：发布前必须解决

1. 固定 Node 20 LTS、pnpm 和 Docker 镜像版本，禁止 `latest` 漂移。
2. 修复条件分支执行循环：Engine 在 `for...of executionOrder` 中重新赋值 `executionOrder`，现有迭代器不会可靠地切换到新数组，存在未选分支继续执行的风险。改为基于游标的 `while`、显式 Ready Queue，或在执行节点前检查 `excludedNodes`。
3. 统一配置注入：`WorkflowEngineConfig.ollamaBaseUrl` 已被接收，但默认注册表直接 `new LLMExecutor()`，ChatOllama 也未显式使用该值。应把 Engine Config 传入各 Executor，避免“配置看似生效、实际依赖环境默认值”。
4. 密钥治理：轮换仓库环境文件中的示例秘密，Docker 密码改为 Secret/环境注入，API Key 只保存哈希而不是明文。

### P1：从教学实现升级到生产可用

1. 用 PostgreSQL FTS / Elasticsearch / OpenSearch / Qdrant Sparse Vector 替换 Scroll 1000 条的全文检索。
2. 增加中文分词、BM25、Reranker，并把 RRF 分数标成“融合分”。
3. 回答中返回来源文档、Chunk、标题路径和引用片段，实现可点击引用。
4. 加入 Prompt Injection 防护、知识库租户隔离测试、文档权限过滤和敏感内容脱敏。
5. 为模型和 HTTP 节点增加超时、重试、指数退避、熔断和幂等策略。
6. 文档处理改为持久化队列，由 Worker 消费；支持重试、死信队列和失败文档一键重处理。
7. 统一编辑器、公开 Web、NestJS 三条运行路径，减少重复的执行记录和 SSE 适配逻辑。

### P2：效果与规模化

1. 建立带标准答案和标准引用的评测集，至少统计 Recall@K、MRR、Faithfulness、Answer Relevance、拒答准确率。
2. Token 使用量读取模型真实 usage；当前 LLM 节点只是字符估算，NestJS 同步响应甚至固定为 0。
3. 支持真正的 Token Streaming、取消执行、Checkpoint、并发分支和故障恢复。
4. 需要自治 Agent 时，再引入计划循环、工具权限、短期/长期记忆和人工审批，不与现有确定性 DAG 混为一谈。

## 18. 正式上线前的 RAG 评测设计

不能只用一个“年假”问题证明效果。建议准备至少四类问题：

| 类型 | 示例 | 观察指标 |
|---|---|---|
| 精确关键词 | 年假有几天？ | 关键词召回和最终准确性 |
| 同义表达 | 年休假额度是多少？ | 向量召回能力 |
| 跨句组合 | 连休六天要提前多久、谁审批？ | Chunk 完整性和生成忠实性 |
| 知识库外 | 公司有没有购房补贴？ | 拒答准确率和幻觉控制 |

检索阶段和生成阶段要分开评测：

- 检索不命中：优先调整切分、Embedding、全文索引、融合权重、Top K、阈值；
- 检索命中但回答错误：调整 Prompt、上下文格式、模型、Reranker、引用和生成参数；
- 两阶段混在一起只看最终答案，会定位不出问题到底在哪一层。

## 19. 面试或答辩怎么讲

### 19.1 30 秒版本

> 我选择企业制度问答作为完整业务链路。离线侧把 Markdown 按标题和自然边界切分，通过 Ollama 生成 1024 维向量并存入 Qdrant；在线侧并行做向量和全文召回，用加权 RRF 融合，再把证据通过工作流变量注入 LLM。流程由自研 DAG 引擎拓扑执行，支持逐节点 Trace、编辑态测试和发布快照。我还通过浏览器把知识入库、混合召回、四节点工作流、更新发布和公开运行全部验收了一遍，并识别出 Node 版本、条件分支迭代和全文检索扩展性等工程问题。

### 19.2 3 分钟版本

1. 先讲业务痛点：企业制度分散，普通关键词搜索不能处理同义问题，大模型直接回答又容易编造。
2. 再讲方案：RAG 把生成限制在检索证据上；DAG 保证流程可预测、可审计。
3. 讲离线链路：文档状态机、Markdown 切分、Overlap、Embedding、Qdrant Payload 和双存储分工。
4. 讲在线链路：变量解析、两路召回、RRF、Prompt 注入、End 输出。
5. 讲工程化：Node Registry、统一生命周期、SSE、Trace、草稿与发布快照隔离、API Key。
6. 展示 6 张验收图和 58 个测试结果。
7. 最后主动讲边界：当前不是自治 Agent；全文检索是小规模实现；真实模型质量还要用评测集验证。

### 19.3 10 分钟演示顺序

1. 打开知识库，展示原始员工手册和切分配置。
2. 输入“年假”，展示混合检索第一名和 RRF 分数解释。
3. 打开四节点画布，逐个说明输入输出契约。
4. 点击测试运行，展示结果。
5. 切到 Trace，展开 Knowledge 节点，展示变量、Chunk 和耗时。
6. 修改一个配置并更新发布，说明快照隔离。
7. 打开公开运行页，输入同一问题，展示 4/4 执行。
8. 打开源码，依次指 Engine、HybridRetriever、QdrantStore、DocumentProcessor 和 Prisma Schema。
9. 用 P0/P1/P2 路线收尾，体现不仅会“跑通 Demo”，也知道怎样生产化。

## 20. 高频追问与参考回答

### Q1：为什么不用大模型直接回答？

模型参数知识不可控、可能过期，也无法证明依据。RAG 把企业私有知识在请求时注入上下文，能更新、能隔离、能追踪。严格来说仍不能自动保证不幻觉，所以还要引用、拒答和评测。

### Q2：为什么同时做向量和全文检索？

向量检索擅长语义改写，全文检索擅长制度编号、金额、专有名词等精确命中。两者错误类型不同，混合后用 RRF 基于名次融合，不需要强行校准两套分数。

### Q3：为什么选择 Qdrant？

它原生支持向量搜索、Cosine、Payload Filter 和独立部署，适合把向量检索和 PostgreSQL 事务数据分开。这里不是说 Qdrant 在所有场景都最优；小规模也可以使用 pgvector，减少运维组件。

### Q4：如何减少幻觉？

先提高召回质量，再要求模型只依据证据回答；证据不足时拒答；输出来源引用；对问题集计算 Faithfulness；对高风险制度增加人工审核。仅降低 Temperature 不能从根本上解决幻觉。

### Q5：如何保证多租户安全？

业务 API 先校验知识库所有权；Qdrant 搜索必须带 `knowledgeBaseId` Filter。生产上还要把 tenantId 写入 Payload、在服务端生成过滤条件、做越权测试，不能接受客户端自由传任意知识库 ID。

### Q6：为什么不是 Agent？

这条业务链路步骤固定，DAG 更可控。目前没有动态计划、工具选择和记忆反馈循环，所以我会准确称为 RAG 工作流。当需求变成“自己选择查询多个系统并根据结果继续规划”时，再升级为 Agent。

### Q7：如果文档更新怎么办？

用文档版本和内容 Hash 做幂等；新版本切分和向量化完成后再原子切换；旧向量按 `documentId` 删除；失败任务进入可重试队列；对外回答使用已完成版本，避免半更新状态。

### Q8：系统瓶颈在哪里？

小数据量下是模型生成；数据量上升后，当前 Scroll 全文检索会先成为瓶颈。再往后要关注 Embedding 批处理、Qdrant 索引、并发执行、上下文 Token 数和模型吞吐。

### Q9：如何评估效果，而不是凭感觉？

拆成检索和生成两层：检索看 Recall@K、MRR、NDCG；生成看正确性、忠实性、引用准确率、拒答准确率和延迟。每次调整 Chunk、模型或权重都跑同一套回归集。

### Q10：发布快照有什么意义？

它让线上运行和编辑草稿隔离，能记录版本、做灰度、回滚和审计。当前实现已经保存不可变版本；下一步应在 UI 增加版本列表、差异比较和一键回滚。

## 21. 验收清单

### 基础设施

- [ ] Node 为 20 LTS；
- [ ] PostgreSQL `5433` 可连接；
- [ ] Qdrant `6333` 健康；
- [ ] Ollama `11434` 可访问；
- [ ] Embedding 维度和 Qdrant Collection 维度一致；
- [ ] Prisma Migration 和 Client Generate 完成。

### 知识库

- [ ] 文档状态为 COMPLETED；
- [ ] Chunk 数大于 0；
- [ ] 精确关键词和同义表达都能召回；
- [ ] 召回结果只来自当前知识库；
- [ ] 删除文档会同步删除 Qdrant 向量；
- [ ] 失败文档有错误信息和重试机制。

### 工作流

- [ ] 有且仅有合理的 Start / End；
- [ ] 没有环；
- [ ] `${node.variable}` 均能解析；
- [ ] Knowledge 结果真实进入 LLM Prompt；
- [ ] 证据不足时拒答；
- [ ] Trace 能定位到具体失败节点；
- [ ] 条件分支修复后有覆盖测试。

### 发布与安全

- [ ] 编辑草稿不影响线上快照；
- [ ] API Key 支持禁用和过期；
- [ ] API Key 不明文落日志；
- [ ] Prompt 和知识内容有脱敏策略；
- [ ] 公开页和 API 都记录 AppExecution；
- [ ] 版本可回滚、镜像和依赖已固定。

## 22. 最终总结

这条链路最值得在答辩中强调的，不是“调用了一个大模型”，而是把 AI 能力放进了完整的软件工程闭环：

```text
数据进入系统
→ 可控切分和向量化
→ 可解释的混合召回
→ 证据约束生成
→ 可组合的 DAG 执行
→ 可观测的节点 Trace
→ 草稿与发布版本隔离
→ Web/API 交付
→ 测试、风险和演进路线
```

真正能体现 AI 开发能力的是：知道模型在哪一层工作、数据怎样流动、结果怎样验证、系统何时会失败，以及怎样从可运行 Demo 演进到可维护、可评测、可上线的产品。

---

版权提醒：项目源码头部声明为妙码学院学习用途，可练习和用于简历展示，但不可开源。对外展示、提交仓库或传播源码前，请遵守原项目授权。
