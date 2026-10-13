# RAG 多 Embedding 知识库跨空间检索改造实施计划

> 状态：待实施（已将 BM25 正式纳入本次改造范围）。本文为任务分解、源码改造顺序和验收标准，不代表代码已经支持多模型联合检索、BM25 索引或真实 Dense + BM25 混合检索，也不记录尚未执行的测试结果。
>
> 对应设计讨论：[RAG 多 Embedding 模型知识库隔离与跨模型检索设计分析](./RAG多Embedding模型知识库隔离与跨模型检索设计分析.md)。基础链路见 [RAG 知识库构建与向量检索源码学习记录](./RAG知识库构建与向量检索源码学习记录.md)，检索质量见 [RAG 检索能力评测与证据标注源码学习记录](./RAG检索能力评测与证据标注源码学习记录.md)。

## 【一、改造目标与交付边界】

当前工作流知识节点可以多选知识库，但向量检索实际依赖单个 `EmbeddingService`、单个 `knowledge_chunks` Collection 和一个 `HybridRetriever`；所谓全文检索则由 `QdrantVectorStore.textSearch()` 扫描最多 1000 个 Point 并在 Node.js 中做字符串匹配。目标是在一次重构中同时实现**不同 Embedding 模型/维度/空间的联合检索**和**用真正的 BM25 词项检索替换旧文本扫描**，先保证每个空间内 Dense + BM25 两路召回，再跨空间融合为统一、可追溯的结果。

用户继续使用现有节点配置中的 `knowledgeBaseIds`、`query`、`retrievalMode`、`topK`、`threshold` 和 `outputFormat`，不要求在节点上手填向量维度。模型、版本、维度与目标 Collection 应从知识库已建立的索引配置读取；**不能根据查询文本长短决定向量维度**，也不能靠维度相等推断不同模型的语义空间兼容。

### 【完成后的业务表现】

~~~text
KnowledgeNode：query + [KB-A, KB-B, KB-C]
                     ↓
调用者身份和知识库授权校验
                     ↓
加载知识库的有效索引配置：Dense Space + BM25 配置
                     ↓
按 Embedding Space 分组
            ┌────────┴─────────┐
            ▼                  ▼
        Space-A              Space-B
       KB-A、KB-B             KB-C
   Model-A / 1024维      Model-B / 768维
            │                  │
       Dense Query-A       Dense Query-B
       BM25 Query          BM25 Query
            │                  │
    Collection-A + Filter   Collection-B + Filter
    Dense / BM25 双路       Dense / BM25 双路
            │                  │
       空间内 RRF          空间内 RRF
            └────────┬─────────┘
                     ▼
              跨空间合并、去重、融合
                     ▼
              可选统一 Rerank
                     ▼
        最终 TopK + 证据来源及状态
                     ▼
              KnowledgeNode 输出
~~~

### 【范围分层】

- **必须交付**：向量空间身份与存储定位；离线按空间写入；为 Chunk 增加 BM25 词项编码与 Qdrant Sparse 索引；把 `textSearch()` 的扫描匹配替换为真正的 BM25；单库查询兼容；工作流多库授权、分组和检索；组内 Dense + BM25 融合；跨空间融合、统一 TopK 和来源追踪；历史默认数据迁移；可复核的验收。
- **本次保留/复用**：原有 `KnowledgeSettingsForm` 多选交互、`HybridRetriever` 单空间检索职责、Qdrant 的 `knowledgeBaseId/documentId` Payload 过滤索引、Document Chunking 和已有 Dense Embedding 输出校验。
- **暂不包含**：同一 Chunk 的多套 Dense 模型表示、跨模型向量对齐训练、复杂模型路由 Agent、无依据的性能承诺；独立统一 Reranker 待基线评估后再引入。BM25 已由后续迭代调整为**本次必做**，但不把 BM25 误称为神经网络生成的 Dense Embedding。

## 【二、源码现状与必须解决的问题】

| 环节 | 已核实源码 | 当前状态 | 改造焦点 |
| --- | --- | --- | --- |
| 知识库配置 | `apps/workflow/prisma/schema.prisma` | `KnowledgeBase` 存 `embeddingModel`、`embeddingProvider`、`dimensions`，默认 Ollama / mxbai-embed-large / 1024 | 需要稳定的 Embedding Space、索引版本与 Collection 映射 |
| 知识库配置 API | `apps/workflow/app/api/knowledge/route.ts`、`[id]/route.ts` | 创建接口不接受自定义模型；更新接口不允许改模型、提供商、维度 | 明确新建时允许的模型配置与修改后的重建索引流程 |
| 离线入库 | `apps/workflow/app/api/knowledge/[id]/documents/route.ts`、`apps/workflow/lib/services/document-processor.ts` | 从知识库读取模型及维度，但始终写入 `knowledge_chunks` | 使用已冻结的空间配置写入对应 Collection |
| Qdrant Store | `packages/ai-engine/src/knowledge/store/qdrant-store.ts` | `ensureCollection` 已校验单个匿名 Dense Vector 的维度、Cosine、过滤索引；构造函数可传 Collection | 保留 Schema 校验；路由不同 Collection；必要时补充查询向量校验及空间元数据 |
| 单知识库搜索 | `apps/workflow/app/api/knowledge/[id]/search/route.ts` | 按目标库模型生成向量，但 Collection 固定 | 复用统一空间解析与检索入口 |
| 工作流节点 UI/类型 | `apps/workflow/components/flow/settings/forms/knowledge-settings-form.tsx`、`packages/ai-engine/src/types/node.ts` | `knowledgeBaseIds: string[]`；已支持多选，没有 Embedding 维度字段 | 优先保留节点输入与已有工作流 JSON |
| 工作流执行器 | `packages/ai-engine/src/nodes/executors/knowledge-executor.ts` | 实例使用一套默认模型/维度和一个固定 Collection | 交由多空间检索编排器执行 |
| 文本检索 | `packages/ai-engine/src/knowledge/store/qdrant-store.ts` 的 `textSearch()` | `scroll(limit:1000)` 只读首批候选，再在 Node.js 计算 includes、词频和归一化分数；无真正 BM25 | 删除扫描式正文匹配路径，换成 Sparse BM25 Index + Query 编码 + TopK |
| 检索与融合 | `packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts` | 一份 Query 向量做向量检索；现有 RRF 是组内向量 + 文本候选融合 | 组内真正 Dense + BM25 融合，再增加**跨空间**汇总与排名，禁止异构分数直接比较 |
| 引擎注册/身份 | `packages/ai-engine/src/nodes/index.ts`、`packages/ai-engine/src/core/engine.ts` | `createDefaultRegistry()` 无参数地创建 `KnowledgeExecutor()`，`ExecutionContext` 未直接承载可用于知识库授权的主体信息 | 需要从业务入口注入已验证身份与知识库配置读取能力 |
| 文档与库删除 | `apps/workflow/app/api/knowledge/[id]/documents/[docId]/route.ts`、`apps/workflow/app/api/knowledge/[id]/route.ts` | 按固定集合删向量；删除知识库仍有 Qdrant 清理 TODO | 按历史/当前索引空间精准删除，不留下可检索的孤儿数据 |
| 多入口运行 | `apps/workflow/app/api/apps/[id]/workflow/run/route.ts`、`apps/api-server/src/modules/workflow/workflow.service.ts` | 编辑器测试和应用/API 运行是不同入口 | 两条路径均需注入被验证的执行主体与检索依赖 |

**前置风险**：如果只重构 `KnowledgeExecutor` 而不改变离线存储及 Collection 路由，那么不同维度仍无法共存；如果先开放自定义模型而尚未实现空间隔离，相同维度但不同模型的向量可能混存，造成没有报错的检索质量问题。实施顺序必须从数据与权限约束开始。

### 【现有全文检索：代码上不是 BM25】

[QdrantVectorStore.textSearch()](../packages/ai-engine/src/knowledge/store/qdrant-store.ts) 的当前流程：

~~~text
用户 Query
   ↓
Qdrant scroll：knowledgeBaseId 过滤，limit=1000，仅取一页
   ↓
Node.js：对 Query 转小写、按空格和标点 split（不是真正的中文分词）
   ↓
遍历最多 1000 个 Chunk，content.includes(query/term)
   ↓
匹配完整查询 +2，词项出现次数 ×0.5，词项覆盖加分
   ↓
本地排序，除以本次最大匹配分数，返回 TopK
~~~

它缺少针对正文的词项索引，不维护用于 BM25 的 TF/IDF 与文档长度统计；只扫描首批返回的 Point，匹配范围不完整。`split` 对连续中文文本通常不会正确切词，且 `new RegExp(term, 'gi')` 未转义查询词中的正则特殊符号。手工归一化的 0～1 分数不是 BM25 原始得分，跨查询、跨模型也不能直接比较。`KnowledgeExecutor` 和单库搜索 API 的 `fulltextProvider` 都在调用这条路径；`hybrid` 当前把 Dense 候选和**这个简易文本匹配**候选做 RRF，不代表已接入真实 BM25。

### 【BM25 在 Qdrant 中的实现边界】

BM25 本身是一种**基于词项统计的排序方法**，并不需要训练或调用语义 Embedding 模型。传统检索引擎可用倒排索引直接实现；Qdrant 的方案是把分词后的非零词项 ID 与对应权重表示为**Sparse Vector（稀疏向量）**，由稀疏索引执行词项匹配并计分。`indices/values` 不是固定长度的 Dense 向量，也不等于“另一个 Ollama Embedding 模型”。

~~~text
离线 Chunk 文本
  ├── Dense Encoder（各知识库模型） → Dense Vector（1024 / 768 等）
  └── BM25 Encoder（统一版本） → 词项 ID + 权重 Sparse Vector
                                              ↓
                     Qdrant Point：Dense + bm25 Sparse + Payload

在线 Query
  ├── 对应空间的 Dense Query Encoder → Dense 候选
  └── 同一 BM25 词项协议的 Query Encoder → BM25 候选
                                              ↓
                                组内融合（RRF）
~~~

在 Qdrant 中，Sparse 字段必须命名；**可保留匿名 Dense 字段并增加命名的 `bm25` Sparse 字段**，不必仅为了支持 BM25 就把所有已有 Dense 向量改成命名结构。但现有 Collection 能否原位补齐字段，应以目标 Qdrant 版本的能力和历史数据迁移成本为准；优先通过**新 Collection 构建双路索引、完成回填后切换活动索引**，避免破坏当前 `knowledge_chunks`。

新 Collection Schema 的目标示意（具体 TypeScript SDK 类型以选定版本验证）：

~~~json
{
  "vectors": { "size": 1024, "distance": "Cosine" },
  "sparse_vectors": {
    "bm25": { "modifier": "idf" }
  }
}
~~~

其中 `vectors` 的 `size` 由每个 Dense Embedding Space 决定；`bm25` 的稀疏词项 ID 空间与具体 Chunk 非零项个数不要求固定维度，`modifier: idf` 允许 Qdrant 根据索引内统计在检索时处理词项稀有程度。**完整 BM25 不只是 IDF**：离线/查询词项映射、词频饱和、文档长度归一化及相应权重计算必须由兼容的 BM25 编码实现保证，不能手工把“词出现几次”直接当成完整 BM25。

对中文及混合技术资料，必须确定统一的 Tokenizer/Analyzer、大小写及标点规则、特殊标识符（例如 `E-1042`）是否保留为整体词项、词项 ID 映射和 BM25 编码版本；写入与查询严格使用一致的规则。**仅给 Payload 的 `content` 建立全文过滤索引，或仅配置 Sparse 字段，都不能自动让原有 Point 获得 BM25 向量。**

当前 `docker/docker-compose.yml` 使用 `qdrant/qdrant:latest`，Qdrant 实际服务端版本和 `@qdrant/js-client-rest` SDK 能力需先核实并固定。官方区分 Qdrant Cluster/Cloud 的服务端 BM25 Inference 与自建部署建议的客户端编码；**不应假设自建镜像能直接处理 `{ text, model: "qdrant/bm25" }`**。实施前要做兼容验证：优先选择已经验证的本地/独立 BM25 编码器（例如 FastEmbed 服务），若实际部署经测试支持服务端推理则可采用服务器编码，并固定版本。只使用一种真实可运行的方案；避免把“定义 Sparse Vector Schema”误当成已经实现 Query/Document 编码。

Qdrant BM25 的 IDF 默认统计范围通常以 Collection/Shard 为边界，多个知识库共享一个 Collection 时，词项得分会受到共用语料分布影响；需要记录这一语义并评估按知识库过滤的统计需求。`knowledgeBaseId` 和 `documentId` 关键词 Payload 索引仍保留，分别用于授权范围过滤及删除，不会被 BM25 替代。

## 【三、建议的分层架构与数据契约】

### 【向量空间不是知识库，也不是向量维度】

一个 Embedding Space 表示一套稳定的向量表示协议。多个知识库如果确实使用同一个空间，可以共享一次 Query Embedding 和同一个 Collection；不同空间必须单独生成 Query Vector，分别检索。

建议在持久化层新增独立的向量空间或索引配置记录，并让知识库指向**当前活跃索引**。最小关键字段：

~~~text
EmbeddingSpace（建议新增，名字可按 Prisma 命名习惯调整）
  id                 空间身份
  provider           例如 ollama
  model              模型名称
  modelRevision      权重 digest / 受控版本标识
  dimensions         实际输出维度
  distance           本次约定 Cosine
  vectorType         dense（按 Embedding Space 划分）
  queryEncodingVer   Dense Query 编码协议版本
  documentEncodingVer Dense Document 编码协议版本
  bm25ConfigId       共用 BM25 词项编码协议（模型名/版本、Tokenizer、权重参数）
  collectionName     Qdrant Collection 名称（稳定、唯一）
  createdAt

KnowledgeBase（现有）
  ...原字段...
  activeIndexId       当前对外可检索索引版本

KnowledgeBaseIndex（建议新增）
  id
  knowledgeBaseId
  embeddingSpaceId
  indexVersion
  status              BUILDING / READY / FAILED / RETIRED
  createdAt / activatedAt

DocumentIndex（或等效持久记录）
  documentId
  knowledgeBaseIndexId
  status / chunkCount
  其他用于写入幂等及删除清理的字段
~~~

这是**目标逻辑模型**，不是已实现 Prisma Schema。实际落库时可压缩字段，避免重复存储，但必须同时满足：**可识别索引的模型空间、可定位 Qdrant、可找到一份文档的实际已写入版本、可迁移和回滚**。不建议让已有 `KnowledgeBase.embeddingModel` 等字段在有历史数据时成为唯一真相；可以保留它们作为默认展示配置或通过迁移逐步统一到索引记录。

索引有效性不仅由维度保证。`modelRevision` 应尽量基于不可变 digest 或可验证版本；`:latest` 不足以证明已入库向量和新调用的模型相同。未来若支持专用 Query/Document 编码指令，要明确分别记录两者版本并绑定为一个兼容协议。

### 【核心检索接口的职责分离】

~~~typescript
// 目标接口示意，并非仓库已有类型
interface KnowledgeBaseIndexDescriptor {
  knowledgeBaseId: string
  indexId: string
  embeddingSpaceId: string
  collectionName: string
  provider: string
  model: string
  modelRevision: string
  dimensions: number
  distance: 'Cosine'
  queryEncodingVersion: string
  bm25ConfigId: string
  bm25VectorName: 'bm25'
  status: 'READY'
}

interface RetrievalPrincipal {
  userId?: string
  appId?: string
  authorizedKnowledgeBaseIds?: string[]
}

interface MultiKnowledgeRetrievalRequest {
  query: string
  knowledgeBaseIds: string[]
  mode: 'vector' | 'fulltext' | 'hybrid'
  topK: number
  threshold?: number
  principal: RetrievalPrincipal
}

interface CandidateWithOrigin {
  chunkId: string
  knowledgeBaseId: string
  documentId: string
  content: string
  metadata?: Record<string, unknown>
  embeddingSpaceId: string
  indexId: string
  sourceRank: number
  sourceScore: number
  source: 'dense' | 'bm25' | 'hybrid'
}
~~~

`RetrievalPrincipal` 是**可信服务端上下文**，不能由用户在节点 JSON 或普通工作流输入中任意声明。除了保存 ID，还应在每次查询时对当前授权状态进行检查；发布工作流的 API Key 是否继承应用拥有者权限、能访问哪些知识库，需要形成明确政策，不能默认允许访问全部知识库。

建议边界：
- `apps/workflow`、`apps/api-server`：负责 Prisma、应用权限、活动索引解析、模型服务凭据与 Collection 关联。
- `packages/ai-engine`：以注入的授权配置描述符或应用层提供的 `KnowledgeRetrievalService` 执行检索，避免直接依赖 Next.js Cookie、Prisma 或客户端传来的任意 Collection 名。
- `KnowledgeExecutor`：处理变量、节点参数、调用服务、序列化结果；不再推断模型/维度。
- `MultiKnowledgeRetriever`：负责按 Dense Space 分组、调度、失败策略和跨空间候选融合；纯 BM25 模式无需创建 Dense Query Embedding。
- `HybridRetriever`：在每个空间执行 Dense、BM25 或 Dense+BM25 三模式的组内召回与融合，替换以前的简易文本匹配 Provider。
- `BM25 编码组件`：统一输出 Query/Document Sparse Vector，维持 Tokenizer、词项 ID 和权重算法兼容；不是另一个语义 Dense Embedding 模型。
- `QdrantVectorStore`：一个实例对应一个 Collection，负责 Dense 与 bm25 Sparse Index、写入、过滤检索、删除；`knowledgeBaseId/documentId` Payload 索引继续独立维护。

## 【四、按依赖顺序实施的任务清单】

### 【阶段 0：冻结兼容基线与迁移输入】

**T00-1 [ ] 清点历史知识库及 Qdrant 数据。** 统计当前知识库模型、维度、Document 状态和共享 `knowledge_chunks` 中的 Point/过滤字段；判断旧向量是否都使用同一种受控模型版本。对于来源不明的历史向量，标记“需重建”，不要仅凭维度将其归入默认空间。

**T00-2 [ ] 建立基线测试与回滚数据。** 固定同模型双知识库、异维度知识库、同维不同模型知识库的教学测试数据；保留单库搜索、工作流节点 JSON 及已发布工作流的输出样本。记录当前可重复的检索行为，而非虚构实际效果。

**T00-3 [ ] 验证 Qdrant BM25 接入方式与版本。** 读取实际运行 Qdrant Server 和 `@qdrant/js-client-rest` 版本，核验创建 Sparse `bm25` 字段、`modifier: idf`、批量写入 `indices/values`、按 `using: 'bm25'` 查询与 `prefetch/RRF` 能力。为自建部署选定并验证一套 BM25 文本编码路径（客户端/独立服务优先；服务端推理必须在实际环境证明可用）；核实中文分词和文档/查询一致性后固定版本与部署镜像。记录一次能从中文文本生成稀疏表示并检索到同一文档的最小联调结果。

**交付**：历史数据清点、默认空间兼容策略、旧文本扫描基线与 BM25 接入可行性结论、测试样本及备份/快照方案。没有可靠的旧向量来源确认之前，不执行原地覆盖式迁移。

### 【阶段 1：空间身份、索引版本与配置解析】

**T01-1 [ ] 数据库迁移。** 修改 `apps/workflow/prisma/schema.prisma` 并生成迁移，增加稳定空间、知识库活动索引、文档写入版本的关系。为外键、状态及唯一性设置必要约束；默认已有知识库不因新字段而失去可用性。

**T01-2 [ ] 建立统一解析服务。** 在业务层新增 `resolveKnowledgeBaseIndex(knowledgeBaseId)`、`resolveAuthorizedIndexes(principal, ids)` 与 `resolveDocumentIndex(documentId)`（名称为建议）。返回可信的空间/Collection 描述符，对缺少有效索引、模型版本不明、维度错误等情况显式拒绝。

**T01-3 [ ] 定义创建/变更配置的业务规则。** 现有创建接口只使用默认模型，更新接口也未开放模型字段。先增加受控创建配置，校验供应商、模型可用性、实际输出维度与空间记录；已有知识库切换模型必须转为**新建索引版本＋重新 Embedding**，不能直接就地修改配置而不重新索引。

**T01-4 [ ] 建立默认 Collection 兼容映射。** 对已确认使用默认空间的老数据，将其索引记录映射至现有 `knowledge_chunks`；不重命名或删除旧集合。其他无法证明模型来源的记录先停止自动纳入跨模型检索。旧集合先视为 Dense-only 历史版本；新建双路索引完成后再切换到新 Collection。

**T01-5 [ ] 固定 BM25 词项索引契约。** 定义 `bm25ConfigId`、编码器版本、中文/中英混合 Tokenizer、大小写与标点清洗规则、特殊编号处理、词项 ID 映射、BM25 权重配置以及 Qdrant `bm25` Sparse 字段。明确 IDF 的 Collection/Shard 统计范围、索引版本和修改编码规则时必须回填的要求。BM25 编码版本与 Dense Space 是**两个不同的配置维度**，不能仅因 BM25 共用同一编码器就把不同 Dense 模型的向量混存。

**预期变更文件**：
- `apps/workflow/prisma/schema.prisma` 和新迁移；
- 新增 `apps/workflow/lib/services/embedding-space-service.ts` / `knowledge-index-service.ts`（建议命名）；
- `apps/workflow/app/api/knowledge/route.ts`、`apps/workflow/app/api/knowledge/[id]/route.ts`；
- 相应类型与状态转换校验。

**阶段验收**：能从 KB-A、KB-B 得到同一 Space；从 KB-C 得到不同 Space；给定非法/未授权 KB ID 不返回任何 Collection 信息；旧默认知识库仍能解析到原有索引；BM25 的编码与索引协议已固定，环境可复核地生成中文 Query/Document Sparse Vector。

### 【阶段 2：离线入库、删除与版本安全切换】

**T02-1 [ ] 在文档上传时固定索引目标。** 修改 `apps/workflow/app/api/knowledge/[id]/documents/route.ts`：先读活动写入配置的快照，再交给 `processDocument()`。并发更改模型不应导致同一文档部分 Chunk 用模型 A、部分用模型 B。

**T02-2 [ ] 按空间写入 Dense + BM25。** 修改 `apps/workflow/lib/services/document-processor.ts`：用描述符中的 `collectionName`，根据指定模型生成 Dense Embedding，同时对同一 Chunk 文本调用 BM25 编码组件，形成 `indices/values` 稀疏向量；将两种表示与 `knowledgeBaseId`、`documentId`、`metadata`、`indexVersion` 写入同一逻辑 Point。保留 Dense 向量数量、实际维度、NaN/Infinity、全零检查，额外检查 BM25 词项 ID 与权重数量一致、数值合法及 Query/Document Tokenizer 兼容。现有 `ensureCollection()` 需要扩展为核对目标 Collection 的 Dense Schema、`bm25` Sparse Schema/IDF 配置及 Payload 关键词索引。BM25 不额外调用 Ollama 生成 Dense Embedding；稀疏词项编码成本单独计算。

**T02-3 [ ] 补齐删除与重试幂等。** 文档删除通过其已写入的 `DocumentIndex` 定位全部仍在使用的空间；知识库删除触发所有索引版本的向量清理。注意当前删除文档接口是先删 PostgreSQL 记录再调用固定 Collection 删除，修改后不能先丢失定位信息再试图清理向量。建议使用可重试删除任务并保存清理状态，失败要可重新执行。

**T02-4 [ ] 提供模型迁移的安全切换。** 创建新索引、按原始文档重新生成向量、校验覆盖及检索结果；只有 `READY` 的新索引才允许激活；活动索引切换后，新查询读新版本，失败可回滚到旧版本。迁移期间读旧/写新/删除的并发边界需明确，避免混合使用新旧结果。

**T02-5 [ ] 回填历史 BM25 索引。** 已有 Qdrant Point 的 `content` Payload 不会因为创建了 `bm25` 字段就自动产生 Sparse Vector。对历史知识库从保存的 Chunk 或原始文档重建，明确选择沿用旧 Chunk 边界还是重新切分并重建 Dense；在新 Collection 内补齐 Dense + BM25 的同一批 Point，核对 Chunk 数量、版本与 Payload 范围。全量回填完成之前不把该索引标记为同时支持 `fulltext/hybrid` 的 `READY`，历史旧 Collection 不做破坏性修改。

**预计涉及**：
- `apps/workflow/app/api/knowledge/[id]/documents/route.ts`、`apps/workflow/lib/services/document-processor.ts`；
- `apps/workflow/app/api/knowledge/[id]/documents/[docId]/route.ts`、`apps/workflow/app/api/knowledge/[id]/route.ts`；
- `packages/ai-engine/src/knowledge/store/qdrant-store.ts`；
- 新增索引迁移/删除服务和可重试任务实现（是否引入队列由现有运行环境评估）。

**阶段验收**：同一 Qdrant 实例可保存 A/B 两种 Dense 维度至不同 Collection；每个新索引的同一 Chunk 同时有 Dense 与 bm25 Sparse 表示；768 维向量不会进入 1024 维空间；历史 Chunk BM25 回填数量可复核；已删除文档不再出现在两条检索路径中；失败重试不产生可见重复 Chunk；新索引未就绪不会影响旧索引查询。

### 【阶段 3：统一单库检索入口，确保新旧一致】

**T03-1 [ ] 调整单知识库搜索 API。** `apps/workflow/app/api/knowledge/[id]/search/route.ts` 不再硬编码 `knowledge_chunks`。在用户归属校验后解析活动索引，按该索引的模型、维度和 Collection 执行检索；明确区分缺索引、索引准备中、模型服务失败。

**T03-2 [ ] 校验在线 Query Vector。** `HybridRetriever` 的 `embedText(query)` 返回后，验证实际维度、有限数值、非全零和空间协议；当前 `OllamaEmbeddingService.getDimensions()` 只返回配置值，并没有对 `embedQuery()` 的实际输出进行维度保证。必要时将这类校验纳入独立公共函数供入库和查询复用。

**T03-3 [ ] 正式替换全文检索路径。** 将 `QdrantVectorStore.textSearch()` 的 `scroll(limit:1000)` + `includes()` + 正则词频加权移出在线主路径，改为使用统一 BM25 编码器生成 Query Sparse Vector、指定 `bm25` 字段提交 Qdrant 稀疏索引检索；返回真实 BM25 候选排名与原始分数，并继续应用已授权的 `knowledgeBaseId` Filter。保留原方法名可作为兼容包装，但不得继续伪装成“BM25 检索”。不把 `content` Payload Full-text Filter 当作 BM25 排序索引。

**T03-4 [ ] 让组内三模式语义真正一致。** `vector` 只走 Dense；`fulltext` 只走 BM25，**不调用** Dense Query Embedding；`hybrid` 并行获取 Dense 与 BM25 候选，再做组内 RRF。建议复用 `HybridRetriever` 的框架、重构当前 FulltextSearchProvider 为 BM25 Provider；单库搜索 API/工作流节点均统一调用新的 Provider，不再使用 `as any` 强制读取 `textSearch()`。明确向量相似度阈值只适用于 Dense 分支，BM25 分数及 RRF 分数不能直接复用一个 0～1 阈值。

**阶段验收**：单 KB API 在默认空间和新空间都能返回正确文档；查询向量与目标索引维度不一致时在 Qdrant 查询前得到明确错误；`fulltext` 确实访问 BM25 Sparse Index 而非扫描首批 1000 个 Point；`hybrid` 确实融合 Dense 与 BM25；单库 API 返回格式保持兼容。

### 【阶段 4：工作流鉴权、依赖注入与多空间检索编排】

**T04-1 [ ] 贯通可信执行主体。** 当前 `createWorkflowEngine()`、`createDefaultRegistry()` 和 `new KnowledgeExecutor()` 之间没有直接承载应用用户/授权知识库列表的契约。需要改造依赖注入：由业务入口确定 principal，注入知识库配置/授权服务和检索服务，不让 `ai-engine` 直接读取浏览器 Cookie 或信任流程节点里携带的 owner ID。覆盖编辑器测试运行、API Key 发布调用及其他实际调用引擎的入口。

**T04-2 [ ] 实现 MultiKnowledgeRetriever。** 推荐在 `packages/ai-engine/src/knowledge/retriever/` 下新增 `multi-knowledge-retriever.ts`（如授权配置获取只能驻留服务端，可将编排器放业务层，再给节点注入标准接口）。执行顺序必须是：授权验证 → 读取 READY 索引 → 空间分组 → 每组创建对应 EmbeddingService/VectorStore → 查询向量校验 → 各组检索。

**T04-3 [ ] 空间内复用 Dense + BM25 HybridRetriever。** 每个组的 `knowledgeBaseIds` 只包含该空间下且已授权的知识库；组内 `vector` 走 Dense、`fulltext` 走 BM25、`hybrid` 对两路候选 RRF。BM25 采用与对应索引相同的词项编码版本，即使多个 Dense Space 使用同一 BM25 编码器，也必须对各 Collection 分别检索。以 `Promise.all` 执行多组请求前，添加受控并发、超时和错误分类。**默认严格模式**：任一必需空间失败则整个检索失败；若后续允许降级，必须显式告知未覆盖的空间和知识库。

**T04-4 [ ] 更改 KnowledgeExecutor 调用与注册。** 取消 `KnowledgeExecutor` 直接固定模型、维度与集合的依赖，保留解析变量及节点输出责任。相应调整 `packages/ai-engine/src/nodes/index.ts`、`core/engine.ts` 的依赖注册与服务注入，但保持旧工作流 `KnowledgeNodeConfig` 的 JSON 格式可继续加载执行。

**主要文件**：
- `packages/ai-engine/src/nodes/executors/knowledge-executor.ts`、`packages/ai-engine/src/nodes/index.ts`、`packages/ai-engine/src/core/engine.ts`；
- `packages/ai-engine/src/types/node.ts` / `core/context.ts` 等服务注入契约；
- `apps/workflow/app/api/apps/[id]/workflow/run/route.ts`；
- `apps/api-server/src/modules/workflow/workflow.service.ts`、其他可确认的工作流运行入口；
- 新增 `MultiKnowledgeRetriever` 与业务侧索引解析适配器。

**阶段验收**：多选两个相同空间知识库，Dense Query Embedding 只计算一次；多选两个不同空间知识库，各自使用正确 Dense 模型及 Collection，并各自执行可用的 BM25 检索；纯 `fulltext` 模式无 Ollama Dense 调用；无权库即使被手动写入节点 JSON 也不可检索；编辑器测试执行和已发布 API 入口行为一致。

### 【阶段 5：跨空间候选融合与结果输出】

**T05-1 [ ] 扩展 RetrievalResult 但保持原输出兼容。** 在 `packages/ai-engine/src/knowledge/types.ts` 中设计 `sourceScore`、`sourceRank`、`embeddingSpaceId`、`indexId`、`retrievalSource`（dense/bm25/hybrid）等可选字段；区分 Dense 相似度、BM25 原始分数、组内 RRF 与跨空间融合分数。最终 `score` 不应再被无条件描述为 0～1 的 Cosine 相似度。现有 JSON 消费者继续看到 `content`、`chunkId`、`documentId` 等既有字段。

**T05-2 [ ] 实现合并去重。** 收集各空间候选，基于跨空间稳定的 `documentId + chunkId + indexId` 或明确的统一文档身份去重；不盲目用 `chunkId` 认定两个索引版本语义相同。对重复证据保留来源列表，以便引用与调试。

**T05-3 [ ] 两层融合与统一候选数量。** **组内**由 Qdrant `prefetch + RRF`（在当前 Qdrant/SDK 验证可用后采用）或现有应用层 RRF 融合 Dense 与 BM25；**组间**在多个 Collection 的组内结果之上由应用层进行候选合并和排名融合。各空间先取足量 `candidateTopK` 再统一截断最终 `topK`；禁止 Dense Cosine、BM25、RRF 的原始分数直接排序或不经校准相加。跨空间列表互不重合时 RRF 的同名次可能打平，需定义稳定 tie-breaker、公平性与统一 Reranker 的验证路径。明确两个 RRF 不会自动产生跨模型分数标定；保留组内原始候选和来源便于评测。

**T05-4 [ ] 保留后续统一 Reranker 扩展点。** 以相同 Query + 不同来源 Chunk 文本统一重排是更强的跨空间相关性对齐方式；首批可不开启，先保留 `RerankProvider`/配置开关接口，待评测有收益再接入模型。

**T05-5 [ ] 统一最终 Top K 与返回语义。** 先得到组内候选，再跨空间融合，**最后**截取最终 `topK`；不要每组各返回 `topK` 之后直接拼接作为节点最终结果。`KnowledgeExecutor` 原有 `text/json` 输出应保留，并向结构化结果添加来源字段；禁止越权来源、已删除文档和无效版本进入输出。

**阶段验收**：组内 `hybrid` 的 Dense/BM25 候选确实参与融合、词项匹配结果能与语义召回互补；跨空间结果不直接以异构 Cosine/BM25 分数比较；多空间最终数量不超过用户设定 TopK；来源、分数含义和失败状态可追溯；同一个 Chunk 在多个召回路径出现时能合并，不丢失内容及 metadata。

### 【阶段 6：联调、迁移发布与观测】

**T06-1 [ ] 构建测试矩阵。** 至少包含：单知识库；同模型多库；不同维度；相同维度不同模型；Dense-only、BM25-only、Dense+BM25；多个空间 + hybrid；中文长词、中文分词、中英混合、特殊编号和正则特殊字符；超过 1000 个 Chunk 的词项召回；无权限；部分模型超时；BM25 编码器不可用；Qdrant Sparse/ Dense Schema 不兼容；旧版工作流 JSON；历史 BM25 回填、文档重建、删除和迁移回滚。

**T06-2 [ ] 分层验证。** 单元验证空间分组、Dense 向量校验、BM25 词项编码的查询/文档一致性、RRF/去重和失败策略；集成联调用实际 Qdrant 对两种 Dense 维度、bm25 Sparse 字段执行写入、词项查询、混合查询、删除、回填；端到端分别通过单库 API、编辑器工作流、已发布接口验收。不能以构造 Sparse JSON 或 Mock 返回代替对实际 BM25 检索的验证。

**T06-3 [ ] 对比检索质量与开销。** 固定问题与证据标注，分别对比旧扫描匹配、BM25-only、Dense-only、组内 Dense+BM25 及多空间 Hybrid 的 Evidence Recall@K、MRR/nDCG、词项精确召回与引用来源；并记录 Dense Query Embedding 次数、BM25 编码耗时、各路 Qdrant 查询耗时、候选池大小、端到端 P95 和失败率。数值目标应依据基线制定，不凭空承诺 BM25 优于所有场景。

**T06-4 [ ] 渐进上线与可回滚。** 保留旧 `knowledge_chunks` 作为可核查的 Dense-only 历史索引；为各空间建立完整 Dense+BM25 新集合，回填并确认两路候选可查询后，再切换活动索引。灰度顺序为单库 BM25/fulltext → 单库 hybrid → 多空间检索 → 可选 Reranker；必要时回退旧路径，但不把未建 BM25 的旧索引对外标称为 fulltext/hybrid。禁止直接删除 Collection“修复”不兼容向量；索引/编码/权限变化后应刷新缓存。

**阶段验收**：异构 Dense 空间联合检索与真实 BM25 索引均经实际服务端核验；现有 `fulltext` 不再依靠扫描最多 1000 个 Point；旧默认知识库通过兼容映射可用，历史回填有覆盖证明；不存在任意库 ID 越权读取；切换和回滚有明确步骤与状态指标。

## 【五、跨模块验收标准与必须保持的不变量】

### 【数据与模型】

1. 一个查询**按不同 Embedding Space 数量**生成向量，不按知识库数量机械重复。
2. Query Encoder 与 Document Encoder 使用配对的模型版本及编码协议；相同维度不代表相同空间。
3. 每个 Qdrant Collection 只接受自身 Schema 所定义的向量；不截断、补零或静默切换模型以绕过校验。
4. 每个新索引 Point 对同一份 Chunk 同时保存 Dense Vector 与由固定 BM25 编码协议生成的 Sparse Vector；BM25 不是神经网络语义 Embedding，不能用原来的 `content.includes()` 模拟。
5. 每个 Point 可追溯到知识库、文档、Chunk 和索引版本；文档删除、重新索引和迁移均有可定位的实际存储目标。

### 【检索与排序】

1. 向量检索必须包含**服务端授权确认后的**知识库范围过滤。
2. 各空间独立检索并返回候选；最终 TopK 在跨空间合并后统一截断。
3. `vector` 使用 Dense，`fulltext` 使用 BM25 Sparse Index（不额外调用 Dense Embedding），`hybrid` 必须融合两路实际检索结果；`knowledgeBaseId` 过滤索引不得被替换掉。
4. Dense 相似度、BM25 原始分数和融合排名不是同一尺度；跨空间排序使用显式融合或同一 Reranker。
5. 失败既不能被静默忽略，也不能把一个空间的结果伪装成所有空间均成功；默认全量成功或明确失败。
6. 结果保持来源可追溯，`metadata`、`documentId`、`knowledgeBaseId` 等信息不能被中间层静默丢弃。

### 【兼容性与运维】

1. 老版 `KnowledgeNodeConfig` 可以继续解析；多库配置无需用户手动填维度。
2. 现有 `knowledge_chunks` 的历史数据不能被未经核实的模型版本重新解释，也不能因新建空间被清空；创建 `bm25` 字段不会自动给旧 Point 回填 Sparse Vector，必须由文档内容重建。
3. 单库搜索、编辑器测试和应用发布执行都使用同一套空间解析/授权语义。
4. 文档删除与知识库删除必须覆盖所有仍需清理的索引版本。
5. 新功能出错时可回退到旧的单模型路径，不依赖手工破坏 Qdrant Schema。

## 【六、工作量边界、阶段依赖和完成定义】

~~~text
阶段0：清点旧数据 + BM25 能力/中文编码验证
  ↓
阶段1：空间身份 + 活动索引 + BM25 协议/权限解析
  ↓
阶段2：Dense+BM25 双路离线写入 + 历史回填/迁移
  ↓
阶段3：单库全文检索正式替换为 BM25 + 组内 Hybrid
  ↓
阶段4：工作流授权与多 Embedding Space 并发检索
  ↓
阶段5：组内 Dense/BM25 + 跨空间融合/统一 TopK
  ↓
阶段6：BM25 与多空间真实联调 + 评测 + 灰度/回滚
~~~

实施时可以把**阶段1的最小数据契约、阶段2的写入路由、阶段3的单库查询路由**合并为第一批可验证改动；随后实施**阶段4与阶段5**，最后做完整迁移上线。阶段之间以验收结果为依赖，不建议一次提交覆盖全部文件而难以定位回归原因。

**推荐提交/PR 切分**：
- PR-1：Qdrant/SDK/BM25 编码能力核实、中文 Tokenizer 与索引协议、空间/索引版本数据结构。
- PR-2：按空间创建 Dense + bm25 Sparse Collection、Document Processor 写入、删除链路和历史回填。
- PR-3：单库 API 的 BM25 `fulltext`、Dense+BM25 `hybrid` 与组内融合。
- PR-4：工作流可信主体/服务注入、MultiKnowledgeRetriever 和跨空间融合。
- PR-5：真实 Qdrant 验收、结果来源追踪、旧索引切换与回滚文档。

**完成定义（DoD）**：一个工作流知识节点选择 KB-A（1024 维）和 KB-C（768 维）使用同一 Query，能在服务端授权后分别用对应模型生成 Dense Query、在各空间独立执行 Dense 与 BM25 Sparse 检索、先完成组内 Hybrid，再跨空间合并去重并输出来源明确的统一 TopK；`fulltext` 模式只走 BM25；超过 1000 Chunk 的关键词也可被检索索引命中；旧默认知识库、单库 API、文档删除与旧工作流 JSON 维持兼容。历史数据未回填完成前不得假称已支持完整 BM25。上述能力必须经真实服务端联调才能标记完成。

## 【七、延后处理与关联问题】

- 生产级任务持久化：当前上传接口 `processDocument(...).catch(...)` 是不等待完成的普通 Promise，进程中断可能导致 PENDING/PROCESSING 文档停滞。多模型重建索引会放大这一风险，阶段2需确保迁移和清理任务可重试；是否采用 BullMQ/其他任务执行器可以另行决策。
- BM25 不再延后：现有 `textSearch()` 的 `scroll(limit:1000)` + 字符串匹配将在本轮用真正的 BM25 Sparse Index 替换。若中文 Tokenizer、服务端推理能力或历史回填受阻，应显式阻塞对应阶段或保留旧索引作回滚，不能把旧扫描检索作为已完成的新 `fulltext`。
- 相似度阈值：目前用户可统一配置一个 `threshold`，但不同模型分数分布不同。基础改造应明确它适用的检索路径；跨空间可选择先只执行各空间受控阈值再全局排名，并通过评测决定是否升级为按空间校准阈值。
- Dense Named Vectors：保留为未来同一 Chunk 多 Dense 模型表示的选型；本次仍按 Dense Space 划分 Collection，且允许继续使用匿名 Dense。**BM25 Sparse 字段必须命名（`bm25`），这不等于引入同一 Point 的多套 Dense 模型。**

## 【八、源码和资料导航】

当前仓库源码：
- [知识库、文档与默认模型字段](../apps/workflow/prisma/schema.prisma)
- [文档上传与参数传递](../apps/workflow/app/api/knowledge/%5Bid%5D/documents/route.ts)
- [离线向量生成及写入](../apps/workflow/lib/services/document-processor.ts)
- [Qdrant Schema 校验、向量检索、文本检索与删除](../packages/ai-engine/src/knowledge/store/qdrant-store.ts)
- [单知识库检索 API](../apps/workflow/app/api/knowledge/%5Bid%5D/search/route.ts)
- [工作流知识节点设置](../apps/workflow/components/flow/settings/forms/knowledge-settings-form.tsx)
- [知识节点执行器](../packages/ai-engine/src/nodes/executors/knowledge-executor.ts)
- [单空间 HybridRetriever](../packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)
- [执行器注册](../packages/ai-engine/src/nodes/index.ts)、[执行引擎](../packages/ai-engine/src/core/engine.ts)
- [编辑器工作流执行 API](../apps/workflow/app/api/apps/%5Bid%5D/workflow/run/route.ts)
- [发布应用工作流执行服务](../apps/api-server/src/modules/workflow/workflow.service.ts)
- [检索类型](../packages/ai-engine/src/knowledge/types.ts)、[节点类型](../packages/ai-engine/src/types/node.ts)

官方资料：
- [Qdrant Collections](https://qdrant.tech/documentation/manage-data/collections/)
- [Qdrant Vectors](https://qdrant.tech/documentation/manage-data/vectors/)
- [Qdrant Hybrid and Multi-stage Queries](https://qdrant.tech/documentation/search/hybrid-queries/)
- [Qdrant Embedding Model Migration](https://qdrant.tech/documentation/tutorials-operations/embedding-model-migration/)
- [Qdrant Full-Text Search (BM25)](https://qdrant.tech/documentation/search/text-search/full-text-search/)
- [Qdrant Inference: BM25](https://qdrant.tech/documentation/inference/inference-bm25/)
- [Qdrant Inference Deployment Choices](https://qdrant.tech/documentation/inference/)
- [Qdrant Sparse Vectors and IDF](https://qdrant.tech/documentation/manage-data/indexing/)
- [Qdrant Collection: Sparse Vectors](https://qdrant.tech/documentation/manage-data/collections/)
- [Qdrant Hybrid Queries](https://qdrant.tech/documentation/search/hybrid-queries/)

