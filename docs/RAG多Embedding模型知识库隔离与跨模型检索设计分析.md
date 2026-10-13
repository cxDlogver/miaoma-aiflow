# RAG 多 Embedding 模型知识库隔离与跨模型检索设计分析

## 【讨论目标与事实边界】

本文讨论两个相连的问题：**不同知识库采用不同 Embedding 模型、输出维度或向量空间时，离线 Chunk 如何存储；一次查询同时命中这些知识库时，应如何编码查询、路由检索并合并结果。** 从具体输入和源码出发，分别解释当前实现、设计原因、建议改造与验证方法。本文是项目分析和设计方案，不代表以下建议已经开发上线或经过检索效果评测。

与项目其他知识点的联系：
- [RAG 知识库构建与向量检索源码学习记录](./RAG知识库构建与向量检索源码学习记录.md)：文档上传、Chunking、Embedding、Qdrant Point 与向量检索的基础链路。
- [RAG 检索能力评测与证据标注源码学习记录](./RAG检索能力评测与证据标注源码学习记录.md)：候选召回、RRF/Rerank、证据评测以及混合检索的工程边界。
- [Qdrant 向量与 Named Vectors 官方文档](https://qdrant.tech/documentation/manage-data/vectors/)、[Collection](https://qdrant.tech/documentation/manage-data/collections/)、[多阶段与混合查询](https://qdrant.tech/documentation/search/hybrid-queries/)：以下设计涉及的数据库能力及限制。

## 【一、为什么不同知识库不能简单共用一份查询向量】

假设系统中有三个知识库，用户的问题都是“员工年假如何申请？”：

| 知识库 | 文档主题 | Embedding 配置（教学示例） | 向量维度 |
| --- | --- | --- | --- |
| A | 人事制度 | Model-A | 1024 |
| B | 员工手册 | Model-A | 1024 |
| C | 行政管理 | Model-B | 768 |

离线阶段，文档 Chunk 被模型编码成向量，随后存入 Qdrant；在线阶段，查询文本也必须通过**与目标文档向量兼容的编码模型及处理协议**生成查询向量。

~~~text
离线：A 的 Chunk ── Model-A ── 1024 维 ── Collection-A
      B 的 Chunk ── Model-A ── 1024 维 ── Collection-A
      C 的 Chunk ── Model-B ──  768 维 ── Collection-B

在线：用户 Query ──┬── Model-A ── 1024 维 ── 检索 A、B
                    └── Model-B ──  768 维 ── 检索 C
                                              ↓
                               汇集候选、去重、融合／重排
                                              ↓
                                      最终相关 Chunk
~~~

这里是**两个向量空间、两次 Query Embedding**，而不是三个知识库就必须调用三次。Model-A 编码一次，查询向量可复用到 A/B。只查询 A 时只需生成 Model-A 的向量；仅用全文检索时，原则上也无需生成 Dense Query Embedding。

### 【维度兼容不等于语义兼容】

向量不仅是一串浮点数，更是在特定模型训练得到的坐标体系中的表示。两种不同模型即便都输出 1024 维，坐标轴含义与距离分布也不一定相同。向量长度相等只意味着底层存储字段可能接受它们，**不能证明跨模型相似度有意义**。

要保证一条 Query Vector 可以检索某批 Document Vector，至少要确认：
1. 查询与文档的编码方案兼容；对非对称模型，Query/Document 可以采用不同前缀、不同任务模式，但必须符合该模型规定的配对协议，并非机械地要求两侧文本处理完全一致。
2. 模型身份、权重版本或不可变修订一致／相容；不能只看模型的显示名称或维度。
3. 输出维度、向量类型（Dense／Sparse）和检索距离算法符合索引约定；如果模型支持截断维度，也必须将实际输出维度视为向量空间配置的一部分。
4. 影响向量语义的清洗、文本拼装、指令前缀、归一化等处理策略受版本管理。Chunk 切分长度不同并不必然产生不同的**向量空间**，但会改变召回对象及证据粒度。

所以分组键不应该只有 `dimensions`，也不应仅仅依赖 `model` 字符串。可将“向量空间”抽象为独立配置标识（建议设计）：

~~~typescript
interface EmbeddingSpace {
  id: string                  // 稳定的向量空间 ID，服务端分配或计算
  provider: string
  model: string
  modelRevision: string       // 模型权重版本、digest 等不可变标识
  dimensions: number
  vectorType: 'dense' | 'sparse'
  distance: 'Cosine' | 'Dot' | 'Euclid'
  documentEncodingVersion: string
  queryEncodingVersion: string
  collectionName: string
}
~~~

此结构为**建议的数据模型**，不是 AI Flow 已有 TypeScript 类型。模型身份还应结合实际供应商能力，例如 Ollama 模型 tag 可能随重新拉取而变化，`:latest` 不能单独充当可靠的不可变版本凭证。查询缓存键也应包含向量空间 ID 和处理协议版本。

## 【二、当前妙码 AI Flow 如何处理知识库配置】

### 【2.1 配置从哪里来】

Prisma 数据模型见 [apps/workflow/prisma/schema.prisma](../apps/workflow/prisma/schema.prisma) 的 `KnowledgeBase`：

~~~prisma
embeddingModel    String @default("mxbai-embed-large:latest")
embeddingProvider String @default("ollama")
dimensions        Int    @default(1024)
chunkSize         Int    @default(500)
chunkOverlap      Int    @default(50)
retrievalMode     RetrievalMode @default(VECTOR)
~~~

每个知识库记录**分别拥有**这些字段，但拥有配置字段不等于整个写入与查询链路已经支持多向量空间。

当前 [知识库创建接口](../apps/workflow/app/api/knowledge/route.ts) 只从请求体接受名称、描述和图标，Embedding 配置由数据库默认值填充。当前 [知识库更新接口](../apps/workflow/app/api/knowledge/%5Bid%5D/route.ts) 的校验 Schema 允许更新切分与检索选项，却**没有**提供修改 `embeddingModel`、`embeddingProvider` 或 `dimensions` 的请求字段。因此，多模型知识库在当前对外 API 中并非已经开放的完整能力；本篇讨论的是模型配置变化、未来扩展及历史数据并存时应具备的机制。

### 【2.2 离线写入只使用一个固定集合】

文件入口：用户上传 Markdown/TXT 等文档，接口将正文与知识库配置交给 [document-processor.ts](../apps/workflow/lib/services/document-processor.ts) 的 `processDocument()`：

~~~typescript
const embeddingService = createOllamaEmbeddingService({
    model: embeddingModel,
    dimensions,
})

const embeddings = await embeddingService.embedTexts(
    chunks.map(chunk => chunk.content)
)

const vectorStore = createQdrantVectorStore({
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    collectionName: 'knowledge_chunks',
})

await vectorStore.ensureCollection(dimensions)
await vectorStore.upsertVectors(vectorChunks)
~~~

关键数据来源：`embeddingModel` 与 `dimensions` 由上传接口从 `knowledgeBase` 读取并传给 `processDocument()`；`chunks` 是切分器输出的文档片段；`embeddings` 与 Chunk 依下标配对，最终组装成 `ChunkWithVector`。

近期修改已在 `processDocument()` 中增加向量数量、维度和有限数值校验，也修复了 `metadata` 传递，但这**只保证单次请求的数据形状有效**，不能解决不同模型混用问题。

向量存储实例始终使用固定 `knowledge_chunks`。在 [qdrant-store.ts](../packages/ai-engine/src/knowledge/store/qdrant-store.ts) 中，`ensureCollection(dimensions)` 目前已经会验证现有单一匿名 Dense Vector 的 `size`、`distance === 'Cosine'` 并补建 `knowledgeBaseId` 与 `documentId` 的 keyword Payload 索引；配置不兼容则报错，且不会自动删除历史集合。

由此产生两种不同的结果：
- **不同维度**：第一个知识库建成 1024 维后，另一个 768 维知识库写入会因 Collection 维度检查失败而被阻止，这是显式冲突。
- **不同模型但相同维度**：检查可能通过，同一个 Collection 便会混存不兼容语义空间的向量；这是更加隐蔽的**语义污染风险**。即使 Payload 根据知识库 ID 能正确过滤，也不能让错误的查询编码变得可比。

### 【2.3 单知识库查询已按照知识库配置选择模型】

[apps/workflow/app/api/knowledge/[id]/search/route.ts](../apps/workflow/app/api/knowledge/%5Bid%5D/search/route.ts) 首先校验当前用户对目标知识库的访问权，再使用对应知识库的配置创建 Embedding 服务：

~~~typescript
const embeddingService = createOllamaEmbeddingService({
    model: knowledgeBase.embeddingModel,
    dimensions: knowledgeBase.dimensions,
})

const retriever = createHybridRetriever(
    embeddingService,
    vectorStore,
    fulltextProvider
)

const results = await retriever.retrieve({
    query,
    knowledgeBaseIds: [knowledgeBaseId],
    mode,
    topK,
    threshold,
    vectorWeight: knowledgeBase.vectorWeight,
})
~~~

这条 HTTP API 的检索范围明确只有**一个**知识库。`HybridRetriever` 随后在向量检索分支调用 `embeddingService.embedText(query)`，再交给 `vectorStore.search()`；因此单库情况下已按库配置生成查询向量，不需要为了其他知识库额外编码。

但它仍固定使用 `knowledge_chunks`，没有映射到独立的向量空间／Collection。若只有同一种模型，该设计在现有单 Collection 下可以工作；若多个模型与配置真正投入使用，写入和读取两端都必须同步调整。

### 【2.4 工作流多知识库检索与单库 API 不同】

[packages/ai-engine/src/nodes/executors/knowledge-executor.ts](../packages/ai-engine/src/nodes/executors/knowledge-executor.ts) 的 `KnowledgeExecutor` 接受 `knowledgeBaseIds: string[]`，但只在构造函数中配置**一个** Embedding 模型及维度，默认 `mxbai-embed-large:latest` / 1024；并只构造一个 `HybridRetriever`。它没有读取每个所选知识库的 Embedding 配置后进行分组的逻辑。

~~~typescript
const embeddingService = createOllamaEmbeddingService({
    model: this.embeddingModel,
    dimensions: this.embeddingDimensions,
})

const vectorStore = createQdrantVectorStore({
    url: this.qdrantUrl,
    collectionName: 'knowledge_chunks',
})

const retriever = createHybridRetriever(
    embeddingService,
    vectorStore,
    fulltextProvider
)

await retriever.retrieve({
    query: query.trim(),
    knowledgeBaseIds,
    mode: retrievalMode,
    topK,
    threshold,
})
~~~

[hybrid-retriever.ts](../packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts) 中虽然已有 RRF，但那是把**单一路径向量召回**与**单一路径全文召回**按排名融合，并不是对多个模型／Collection 的检索结果做路由与跨空间融合。

当前所谓“全文检索”来自 [qdrant-store.ts](../packages/ai-engine/src/knowledge/store/qdrant-store.ts) 的 `textSearch()`：`scroll(limit: 1000)` 后在 Node.js 内匹配文本，不是独立的 BM25 词项索引，也不能作为完整的跨模型词法召回能力来假定。

**已核实的项目结论**：数据库可保存每库模型配置；单库搜索 API 选择该库模型；离线存储和在线查询仍共用固定 Collection；工作流多库检索只使用一份查询向量。项目目前**未实现**完整多向量空间存储和跨模型查询。

## 【三、不同 Embedding 模型的离线入库如何设计】

目标是让每条向量在写入时就确定属于哪个空间，而不是等查询时根据向量长度猜测模型。

~~~text
上传文档（documentId、knowledgeBaseId、文本）
        ↓
读取知识库当前 Embedding 配置及版本
        ↓
解析或创建 embeddingSpaceId → collectionName
        ↓
按原有 Chunking 策略生成 TextChunk
        ↓
按该空间的 Document Encoding 规则批量 Embedding
        ↓
校验返回数量、维度、数值与目标 Collection Schema
        ↓
写入与该空间对应的 Qdrant Collection
        ↓
记录 Document 的索引空间／索引版本／处理状态
~~~

以一份文档为例：`knowledgeBaseId = kb-C`，配置为 Model-B / 768 维。文档被切成 5 个 Chunk 时，所有 Chunk 都使用 Model-B Document Encoder 生成 768 维向量，写入由 Model-B 向量空间标识映射出的 Collection，并保留 `documentId`、`knowledgeBaseId`、`chunkIndex`、`metadata`。**同一批 Document 向量不应该因模型响应异常而自动改用 Model-A，或随意填充／截断向量以凑维度。**

### 【按向量空间分 Collection：建议作为现有项目的渐进式方案】

~~~text
Qdrant
  ├── knowledge_space_A
  │     ├── kb-A 的 Point
  │     └── kb-B 的 Point
  └── knowledge_space_B
        └── kb-C 的 Point
~~~

一个 Collection 对应一种受版本约束的向量空间，多个知识库可共用空间并通过 Payload Filter 区分。**不是每个知识库单独创建 Collection**；Qdrant 官方明确提示，大量小 Collection 会带来资源开销，通常不建议按用户、文档等细粒度无差别创建。

建议设计一个明确的映射层，由同一个 `resolveEmbeddingSpace()` 同时供离线写入、在线检索、重新索引、按库删除使用。仅修改离线 `collectionName` 而不同步检索和删除接口，会导致写入成功但读取不到数据或留下孤儿向量。

~~~typescript
// 建议示意：仅说明配置解析与路由职责，不是现有项目可直接调用的 API。
type ResolvedKnowledgeBase = {
  id: string
  embeddingSpaceId: string
  collectionName: string
  model: string
  dimensions: number
}

function groupByEmbeddingSpace(
  bases: ResolvedKnowledgeBase[]
): Map<string, ResolvedKnowledgeBase[]> {
  const groups = new Map<string, ResolvedKnowledgeBase[]>()
  for (const kb of bases) {
    const group = groups.get(kb.embeddingSpaceId) ?? []
    group.push(kb)
    groups.set(kb.embeddingSpaceId, group)
  }
  return groups
}
~~~

Collection 命名建议使用稳定、受约束的空间标识，而不是直接拼接用户可输入的模型名称；服务端应保存 `embeddingSpaceId → collectionName` 的映射。模型更换时需创建新空间或显式启动迁移，不应让旧模型的 Point 默默变成新模型的向量。

### 【Named Vectors 是另一种可选方案】

Qdrant 支持同一 Collection 的 Point 包含多个不同维度的**命名向量**。例如配置：

~~~json
{
  "vectors": {
    "dense_model_a": { "size": 1024, "distance": "Cosine" },
    "dense_model_b": { "size": 768, "distance": "Cosine" }
  }
}
~~~

注意这段是**Qdrant Collection 配置示例**。实际写入 Point 和查询都要指定正确的向量名称（`using` 等），当前 AI Flow 的匿名 `vector: number[]` 写法不能不改就支持它。

Named Vectors 适合同一个逻辑 Point 的 Payload 需要多种向量表示、需要在同一集合内发起多路检索或多模态检索的场景。对于知识库各自只使用一个模型、模型分组可能独立扩缩容的当前场景，按空间分 Collection 更便于保持写入、查询和生命周期的一致性。两种方案都不是永远正确：若日后要为**同一 Chunk** 同时建立多个模型的向量，可再评估 Named Vectors。

## 【四、一次查询怎样检索多个不同模型的知识库】

### 【先确定查询范围，不能先向全部模型广播】

假设一次工作流请求指定 `knowledgeBaseIds = ['kb-A', 'kb-B', 'kb-C']`。首先验证调用者是否对每个知识库有权访问，读取这些知识库的有效配置和可用索引版本，再按 `embeddingSpaceId` 分组。不能用“Qdrant 可以跨 Collection 查询”代替授权；Qdrant 的 `knowledgeBaseId` Payload Filter 也不应取代应用层身份权限校验。

经过分组：

~~~text
输入：Query = “员工年假如何申请？”
授权知识库 = [kb-A, kb-B, kb-C]

EmbeddingSpace-A：kb-A、kb-B
EmbeddingSpace-B：kb-C
~~~

然后只对每组调用一次对应的 Query Encoder（同组查询结果也可以按 Query + 空间 ID 做受控缓存）：

~~~text
同一条原始 Query
        ↓
按 EmbeddingSpace 去重
        ├── QueryEncoder-A(query) → vector-A → Collection-A，过滤 kb-A、kb-B
        └── QueryEncoder-B(query) → vector-B → Collection-B，过滤 kb-C
                                     ↓
                            各组候选 TopK
                                     ↓
                           统一证据候选列表
~~~

**特殊情况**：
- 只检索 kb-A：只编码 Model-A 一份 Query。
- 同时检索 kb-A / kb-B 且它们共用空间：只编码一份 Query，向量检索用 `knowledgeBaseId IN [...]` 过滤。
- 同时检索 kb-A / kb-C 且模型不同：编码两份 Query，分别检索，结果在应用层合并。
- 仅做独立词法检索：不需要 Dense Query Embedding，但仍需使用真正覆盖目标索引范围的词法检索服务。

### 【路由的接口与伪代码】

建议把跨库聚合置于 **Retrieval Orchestrator**，而不是让原本封装单个模型及单个向量库的 `HybridRetriever` 在内部偷偷判断所有知识库的配置。

~~~typescript
// 建议伪代码：具体仓库依赖注入、鉴权、错误类型和结果 Schema 需另行落地。
async function retrieveAcrossKnowledgeBases(
  query: string,
  requestedKbIds: string[],
  principal: Principal
): Promise<RetrievalResult[]> {
  // 先鉴权并加载每个知识库的有效 Embedding Space。
  const bases = await authorizeAndResolveBases(principal, requestedKbIds)
  const groups = groupByEmbeddingSpace(bases)

  const resultLists = await Promise.all(
    [...groups.values()].map(async group => {
      const space = await loadEmbeddingSpace(group[0].embeddingSpaceId)
      const queryVector = await encodeQuery(space, query)
      assertQueryVectorCompatible(space, queryVector)

      return searchCollection({
        collectionName: space.collectionName,
        vector: queryVector,
        knowledgeBaseIds: group.map(kb => kb.id),
        topK: 20,
      })
    })
  )

  const candidates = mergeAndDeduplicate(resultLists)
  return rerankAndSelect(query, candidates, 5)
}
~~~

上述名称 `Principal`、`authorizeAndResolveBases()`、`encodeQuery()`、`mergeAndDeduplicate()` 等都为**建议抽象，不是仓库已有函数**。

跨库与同库差异主要发生在**召回编排层**：下游 Chunk 仍保留统一的 `knowledgeBaseId`、`documentId`、`chunkId`、`content`、`metadata`，最后再做 Context Construction 和引用，不要求下游 LLM 理解多个向量空间的数学细节。引入多模型后也需要保留证据来源和空间版本，以便复核检索结果。

## 【五、多个模型的检索结果为什么不能按原始分数直接排序】

设两个模型各返回候选：

| 检索来源 | Chunk | 相似度（教学示例） |
| --- | --- | ---: |
| Model-A | 年假申请流程 | 0.82 |
| Model-B | 休假审批规定 | 0.91 |

这两个分数的生成空间、训练分布和标定方式不同。**不能仅凭 0.91 大于 0.82 就认定第二段证据更相关。**即使同为 Cosine 分数，也不意味着跨模型已经校准。

常用处理思路：

**第一步：每个空间独立召回候选。** 各组设置合理候选数，避免最终 TopK=5 时某个空间的潜在证据因过早截断而丢失。空间内可以保留本模型的相似度和阈值校验；跨模型不能直接套用一个通用阈值。

**第二步：合并、去重，保留来源。** 返回类型至少携带 `chunkId`、`documentId`、`knowledgeBaseId`、`embeddingSpaceId`、`sourceRank`、`sourceScore`。合并不能丢失用于引用、授权复核和故障归因的信息。

**第三步：使用适合跨模型的统一排序机制。**

- **RRF（Reciprocal Rank Fusion）**按照各列表中的名次而非原始相似度累积分数。经典形式：对于候选 d，将所有包含 d 的列表贡献 `1 / (k + rank(d))` 相加（使用的名次起点和常数由实现定义）。它避免直接比较异构模型的距离尺度。
- **统一 Reranker**把 Query 与不同来源的文本 Chunk 交给同一个相关性模型评分，然后选择最终 TopK。它能在跨模型候选来源不一致时，提供更统一的证据相关性判断；仍须对延迟、费用和质量进行验证。
- **工程推荐**：先按空间完成召回，形成足够大的候选池；跨空间优先考虑统一 Reranker，需要时辅以 RRF；通过标注集比较不同融合方案，而不是预设某个一定更优。

RRF 的一个重要边界：如果每个知识库只有自己独有的 Chunk、不同空间结果列表几乎没有重合，则同名次的结果容易获得相同或接近的 RRF 分数。此时 RRF 更接近**按排名交错合并**，未必能判断两个列表中究竟哪个第一名更适合回答。因此不能把“支持 RRF”直接等同于“已经实现可靠的跨模型相关性排序”。

项目当前 `HybridRetriever` 的 RRF 用于向量检索和简易文本匹配结果融合；跨模型多 Collection 的排序、统一 Reranker 与两者的效果评测均**尚未实现**。Qdrant Query API 的多路 `prefetch + RRF` 可用于同一 Collection 内的多向量查询；对于此处采用的**不同 Collection**，仍需要由应用层协调结果，不应误认为一次 Qdrant Collection 查询即可自动搜索全部集合。

## 【六、当前结构之外必须同时考虑的工程边界】

### 【6.1 一份知识库改用新模型，不等于只改 model 字符串】

知识库已有文档向量是由旧模型生成的。若把知识库配置直接指向新模型而不重建索引，在线 Query Encoder 与旧 Document Encoder 将不匹配。对于维度相同的新模型尤其隐蔽，因为数据库可能不报错。

安全迁移应按版本处理：

~~~text
旧索引 space-A（持续服务查询）
        ↓
创建 space-B（保留旧索引）
        ↓
从可信原始文档重新切分／重新 Embedding
        ↓
校验 space-B 的覆盖、查询结果和权限
        ↓
原子切换知识库的 activeEmbeddingSpace / indexVersion
        ↓
监控、可回滚；清理不再被引用的旧版本
~~~

这只是**建议迁移流程**，不是 AI Flow 已有的索引版本机制。离线任务开始时应持久化采用的模型、配置和索引版本快照；上传期间临时修改知识库模型不应让同一批 Chunk 有的用旧模型、有的用新模型。原模型 `:latest` tag 变化也应按相同原则审查。

### 【6.2 读取、删除和更新也必须按空间定位】

当前 `deleteDocumentVectors(documentId)` 通过固定 `knowledge_chunks` 删除；知识库删除接口中还有 `TODO: 同时删除 Qdrant 中的向量数据`。引入多 Collection 后，删除不可以靠遍历所有可能集合猜测，而应由文档索引记录解析其所在空间，删除目标版本的 Point，并核对是否存在迁移中的新旧双版本。

PostgreSQL 文档记录和 Qdrant Point 不是同一个事务。模型迁移、并发删除和重试需要额外的状态、幂等键及清理策略；本篇不将其误写成已经具备的跨库事务保证。

### 【6.3 模型服务失败与部分空间召回失败】

多模型查询会增加一次请求涉及的模型调用数量和失败点。假设 Model-A 正常、Model-B 超时，系统要显式决定：
- **严格模式**：整个查询失败，避免以不完整证据回答；
- **允许降级模式**：仅返回 Model-A 已授权且有效的结果，但必须向调用方标明未覆盖的知识库与失败空间，不能伪装成完整召回。

这些行为应按业务安全与答案完整性要求定义；特别是合规、权限或高风险场景，不能在未声明的情况下静默降级。针对同一空间的 Query Embedding 可以去重、缓存或适度并发，但不能以牺牲鉴权范围为代价。日志中优先记录空间、耗时、模型版本、结果数量及错误分类，不默认输出原始敏感 Query／Document 内容。

### 【6.4 模型空间数量和查询成本】

每新增一个不同向量空间，查询可能多一次模型调用和一个检索请求，因此查询时延、显存占用和内存成本会增长。空间数很多时，可以考虑需求限定的知识库选择、语义或规则路由、批量编码、缓存和受控并发，不应默认向全部模型广播。反过来，也不应在未取得覆盖率基线前通过过度路由过滤掉本该被召回的知识库。

## 【七、适用于当前项目的渐进式改造方案】

建议分阶段推进，不一次性重写所有检索能力。

### 【第一阶段：建立向量空间身份并统一写入／读取配置】

1. 在数据库中增加向量空间记录或可核查的 `embeddingSpaceId` 映射，绑定模型、权重版本、维度、编码策略和 Collection。知识库持有当前活跃的索引空间；文档或索引任务持有写入快照。
2. 将 `document-processor.ts` 的固定 `collectionName: 'knowledge_chunks'` 改为统一的空间解析结果；仍保留现有 Chunk 与 Embedding 完整性校验。
3. 将单知识库搜索 API 的 Collection 也由同一解析器获取；保证上传与查询读取同一空间。
4. 删除和重建索引等生命周期操作同步依据空间记录执行，不因名称变化遗留孤儿数据。
5. 对当前共享集合中的历史 Point 先做模型来源清点和迁移方案，不能直接变更原 Collection Schema 或假设旧数据都属于新空间。若当前实际只有一种默认模型，可评估保留旧集合为默认空间并做兼容映射。

### 【第二阶段：工作流多知识库分组检索】

1. 在工作流侧通过受控服务加载并授权 `knowledgeBaseIds`，将配置注入 AI Engine；避免让底层通用引擎直接依赖 Prisma。
2. 将 `KnowledgeExecutor` 的单实例 Embedding 检索改为按 `embeddingSpaceId` 分组、每组独立 Query Embedding、按组 Collection + Payload Filter 召回。
3. 将跨空间合并、去重和统一重排放在检索编排层，原有单空间 `HybridRetriever` 作为可复用的组内检索组件。
4. 定义各组失败的整体错误或明确降级返回方式，并让 `results` 输出保留来源、路径与缺失覆盖范围。

### 【第三阶段：通过数据评估是否有必要提升复杂度】

比较单模型基线、跨空间 RRF、跨空间统一 Reranker 等组合；记录查询向量生成次数、检索延迟、候选数量、最终 Evidence Recall／nDCG、引用正确性、错误率及单位查询成本。没有充分收益证据前，不急于把同一 Chunk 建立多套 Named Vectors，也不把多模型路由和模型迁移做成一个难以验证的大改动。

**本次文档只提出改造路线；以上第一至第三阶段均未因创建本文而自动落实到代码。**

## 【八、验证思路与典型追问】

| 场景 | 预期行为与验收重点 |
| --- | --- |
| A/B 使用完全兼容的同一空间 | 一次 Query Embedding；统一过滤 A/B；返回结果有完整来源 |
| A/C 使用不同维度 | 两份向量分别命中各自 Collection；不会尝试把 768 维写入 1024 维匿名字段 |
| A/C 同为 1024 维但不同模型 | 系统按空间 ID 隔离，不能仅凭维度相等合并搜索 |
| A/C 中 C 未授权 | C 既不参与空间路由，也不出现在 Qdrant Filter、候选或最终回答中 |
| C 的模型服务超时 | 严格失败或显式部分结果；不能将 C 的向量偷偷替换成 A 的向量 |
| A 从旧模型迁移到新模型 | 旧查询持续可用，目标空间数据完成并验证后切换，失败可回滚 |
| 同一问题通过不同模型返回高分 | 不直接比较原始 Cosine 分数，以标注证据集检查融合与重排质量 |
| 用户只查一个知识库／仅全文检索 | 不额外调用不需要的 Embedding 模型 |

面试时可以沿一条逻辑回答：**先判断向量空间是否兼容 → 决定离线存储隔离粒度 → 在线按授权知识库及空间分组 → 每个空间各自生成查询向量与召回 → 对异构候选进行统一融合和证据验证 → 说明模型迁移、失败和成本边界。** 重点不是强调“一定要生成很多向量”，而是说明为什么**查询向量必须与其目标索引所使用的编码协议配对**。

## 【资料与源码索引】

项目源码：
1. [知识库 Prisma 模型与默认配置](../apps/workflow/prisma/schema.prisma)——`KnowledgeBase`。
2. [知识库创建 API](../apps/workflow/app/api/knowledge/route.ts)、[详情与更新 API](../apps/workflow/app/api/knowledge/%5Bid%5D/route.ts)——当前模型配置的对外读写边界。
3. [文档上传接口](../apps/workflow/app/api/knowledge/%5Bid%5D/documents/route.ts)、[Document Processor](../apps/workflow/lib/services/document-processor.ts)——离线配置传递、Embedding 与写入。
4. [QdrantVectorStore](../packages/ai-engine/src/knowledge/store/qdrant-store.ts)、[向量检索相关类型](../packages/ai-engine/src/knowledge/types.ts)——Collection、Payload Filter 与 Point。
5. [单知识库检索 API](../apps/workflow/app/api/knowledge/%5Bid%5D/search/route.ts)、[HybridRetriever](../packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)、[KnowledgeExecutor](../packages/ai-engine/src/nodes/executors/knowledge-executor.ts)——单库与多库检索差异及当前 RRF 使用范围。

官方参考：
1. [Qdrant：Collections](https://qdrant.tech/documentation/manage-data/collections/)——单向量字段维度／距离约束及 Named Vectors。
2. [Qdrant：Vectors](https://qdrant.tech/documentation/manage-data/vectors/)——Named Vectors 的存储模型。
3. [Qdrant：Hybrid and Multi-Stage Queries](https://qdrant.tech/documentation/search/hybrid-queries/)——Prefetch、RRF、DBSF 及融合机制。
4. [Qdrant：FAQ](https://qdrant.tech/documentation/faq/)——Named Vectors 与独立 Collections 的选型，避免过多小集合。
5. [Qdrant：Multitenancy](https://qdrant.tech/documentation/examples/multitenancy/)——共享 Collection 下的 Payload 过滤隔离。
6. [Qdrant：Embedding Model Migration](https://qdrant.tech/documentation/tutorials-operations/embedding-model-migration/)——向量模型迁移的不同策略；实际能力应核对部署的 Qdrant 版本。

