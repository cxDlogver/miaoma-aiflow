# RAG 多 Embedding 模型知识库构建与跨空间检索完整分析

## 【知识目标与项目边界】

本篇以**通用运行机制 → 妙码 AI Flow 实际源码 → 失败边界与验证**的顺序，解释：不同 Embedding 模型及维度为什么需要独立向量空间、一个知识库如何异步构建 Dense+BM25 索引、工作流如何跨模型检索并融合结果，以及重建、删除、权限和失败恢复怎样共同保证用户只看到有效证据。

**事实基线**：依据 GitHub `cxDlogver/miaoma-aiflow` 的最新业务改造提交 `b4c0facca3fbc999d6ea3680466979bf1d01f362`（2026-10-13），本文叙述的是仓库中**已写入的代码机制**，不再把它误写成待执行改造计划。已有单元/集成测试代码不等于已在目标业务环境完成真实模型部署和质量评测；后文会区分源码已实现、测试覆盖、尚待验证与进一步优化。

与其他学习内容的联系：
- [RAG 知识库构建与向量检索源码学习记录](./RAG知识库构建与向量检索源码学习记录.md)：知识输入、Chunking、Embedding、索引及 HNSW 的基础主链。
- [RAG 检索能力评测与证据标注源码学习记录](./RAG检索能力评测与证据标注源码学习记录.md)：相关证据、Qrels、Recall/nDCG、Dense/BM25/RRF 评测与排序依据。
- 本篇深入该项目**多向量空间、BM25、索引版本、后台任务与发布权限**的实现。既不把旧的单 Collection/字符串匹配版本当作现状，也不因实现完成而省略方案取舍和边界。


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


所以分组键不能只用 `dimensions`，也不能只使用可变的模型名称；应由模型真实权重、Query/Document 编码协议及向量索引配置共同决定。下文结合当前仓库的 `EmbeddingSpace`、`KnowledgeBaseIndex`、`DocumentIndex` 等真实实现验证这一原则，示例中的 A/B/C 模型仅用于讲解，不代表本仓库已经安装对应模型。

## 【二、当前项目的完整架构：知识库、向量空间、索引版本如何分层】

### 【问题：为何不能让 KnowledgeBase 直接指向一个 Collection】

一个知识库表示用户管理文档和授权的逻辑对象；Embedding Space 表示可以共用 Dense 向量坐标体系的一组编码配置；索引版本表示某个知识库的一次切分、向量化和提交结果。这三者生命周期不同：同一空间可以服务多个知识库；同一个知识库切分参数变化后需要重建索引，但可能仍使用同一个空间和 Collection；删除旧索引也不应删除其他知识库共用的 Collection。

实际数据模型位于 [Prisma Schema](../apps/workflow/prisma/schema.prisma)：

~~~text
KnowledgeBase（知识库：拥有者、配置、deletedAt）
   │ activeIndexId → 当前应当对外检索的索引
   ├── KnowledgeBaseIndex（索引版本：空间 + chunkSize/Overlap + 状态）
   │       ├── EmbeddingSpace（不可变 Dense 编码空间 → Collection）
   │       └── DocumentIndex（每份文档在这个索引版本的完成状态）
   └── Document（原始正文、文档状态、删除标记）

KnowledgeIndexJob（独立持久任务）
   ├── PROCESS_DOCUMENT
   ├── DELETE_DOCUMENT
   ├── DELETE_INDEX
   └── DELETE_KNOWLEDGE_BASE
~~~

源码中的 `EmbeddingSpace` 保存 `provider`、`model`、`modelRevision`、`dimensions`、`distance`、`queryEncodingVersion`、`documentEncodingVersion`、`bm25ConfigId` 与 `collectionName`；`KnowledgeBaseIndex` 冻结 `embeddingSpaceId`、`chunkSize`、`chunkOverlap` 和 `status`；`DocumentIndex` 以 `(documentId, knowledgeBaseIndexId)` 唯一定位文档索引结果。`KnowledgeBase.activeIndexId` 指向当前索引。`KnowledgeIndexJob` 不通过外键级联依附被删除的文档，以便实体逻辑删除后仍能执行清理。

注意 **Embedding Space 不等于索引版本**：A/B 知识库若空间相同，可共用 Collection，但每个知识库各有独立的 `indexId`；同库新旧索引也能在同一个 Collection 共存直到清理结束。这是之后为什么查询必须同时过滤 `knowledgeBaseId` 与 `indexId` 的根本原因。

当前 [空间解析服务](../apps/workflow/lib/services/embedding-space-service.ts) `ensureEmbeddingSpace()` 计算空间身份的核心源码：

~~~typescript
const protocol = {
  provider: 'ollama',
  model: config.embeddingModel,
  modelRevision,
  dimensions: config.dimensions,
  distance: 'Cosine',
  queryEncodingVersion: 'ollama-raw-v1',
  documentEncodingVersion: 'ollama-raw-v1',
  bm25ConfigId: BM25_CONFIG_ID,
}
const id = createHash('sha256')
  .update(JSON.stringify(protocol))
  .digest('hex')
const collectionName = 'knowledge_v2_' + id
~~~

调用前通过 `getOllamaModelRevision()` 获取当前已安装模型的 digest，并做 Query Embedding 维度探测；之后 `ensureCollection(dimensions)` 验证目标 Qdrant Collection，最终 `prisma.embeddingSpace.upsert(...)` 创建或重用相同空间。这样同维度的两个不同模型不会误共享集合，同一模型的权重 digest 改变也会生成新的空间指纹。

这里并不是向量降维：`dimensions` 描述模型实际输出维度。系统没有因为用户 Query 的长短而动态截断向量；维度与模型不符时探测或后续校验失败。

### 【创建知识库：配置如何从界面走到索引】

[知识库创建接口](../apps/workflow/app/api/knowledge/route.ts) 已支持从请求读取 `embeddingProvider=ollama`、`embeddingModel` 与 `dimensions`；当前没有泛化支持其他供应商。通过用户登录校验后，先调用 `ensureEmbeddingSpace`，再在 PostgreSQL 事务中创建 `KnowledgeBase`、初始 `KnowledgeBaseIndex(status='READY')` 并写回 `activeIndexId`。

新建空知识库初始索引为 READY，是因为尚不存在要处理的文档；后续上传将单独排队处理。改变模型、维度、`chunkSize` 或 `chunkOverlap` 则不允许只修改字段：由 [知识库更新接口](../apps/workflow/app/api/knowledge/%5Bid%5D/route.ts) 转入 `rebuildKnowledgeBase()` 重新建索引。显式重建入口见 [reindex API](../apps/workflow/app/api/knowledge/%5Bid%5D/reindex/route.ts)。

## 【三、离线构建：原文如何成为 Dense + BM25 的同一个 Point】

### 【先说明两个表示是怎样产生的】

Dense Embedding 使用 Ollama 的神经网络模型：每个 Chunk 输出固定维度 `number[]`，用于语义近邻检索。BM25 则根据词项、词频、文档长度和语料统计进行词法匹配；它不是另一个神经网络 Dense 模型，也不要求使用相同的 768/1024 维长度。

Qdrant 为 BM25 提供稀疏表示与索引能力：BM25 文本编码最终表达为稀疏词项 ID/权重，并通过 Sparse Index 查询。当前项目选择**Qdrant 原生 BM25 服务端推理**，因此客户端不是自己生成 `indices/values`，而是传输符合 Qdrant Inference 协议的文本对象。

[BM25 配置](../packages/ai-engine/src/knowledge/bm25.ts) 实际为：

~~~typescript
export const BM25_CONFIG_ID =
  'qdrant-bm25-multilingual-v1-k1.2-b0.75-avg256'
export const DENSE_VECTOR_NAME = 'dense'
export const BM25_VECTOR_NAME = 'bm25'
export const BM25_OPTIONS = {
  tokenizer: 'multilingual',
  language: 'none',
  k: 1.2,
  b: 0.75,
  avg_len: 256,
}
export function bm25Document(text: string) {
  return { text, model: 'qdrant/bm25', options: { ...BM25_OPTIONS } }
}
~~~

`k` 用于词频饱和，`b` 用于文档长度归一化；`avg_len=256` 是这份固定编码协议的参数，不是“每次检索动态统计出的实际平均 Chunk 长度”。写入和查询必须使用同一个协议；改变 Tokenizer、词项规则或 BM25 参数，需要建立新的向量空间及索引版本并重新构建。中文语料必须实际测试分词效果，不能因 `tokenizer='multilingual'` 就推断所有专有名词会被整体保留。Qdrant IDF 统计基于所在索引语料（Collection/Shard 的相关范围），Payload 的知识库过滤并不自动把 IDF 改成某个单独知识库的统计。

[QdrantVectorStore.ensureCollection](../packages/ai-engine/src/knowledge/store/qdrant-store.ts) 创建/校验的当前 Schema：

~~~typescript
await this.client.createCollection(this.collectionName, {
  vectors: {
    dense: { size: dimensions, distance: 'Cosine' },
  },
  sparse_vectors: {
    bm25: { modifier: 'idf' },
  },
})
~~~

这里的 `dense` 是**命名 Dense Vector**，`bm25` 是独立命名的 Sparse Vector。命名 Dense 仅为明确两种检索路径，不表示一个 Point 同时具备多个模型的 Dense Embedding。旧的单一匿名 Dense Collection 与此 Schema 不兼容。`ensureCollection` 还检查四个 keyword Payload 索引：`knowledgeBaseId`、`documentId`、`indexId` 和 `documentIndexId`。它们服务于精确过滤与删除，并不会被 BM25 取代。

### 【上传接口为何不再直接启动异步 Promise】

过去接口直接调用 `processDocument(...).catch(...)` 并提前返回；进程退出后任务可能消失。当前 [文档上传接口](../apps/workflow/app/api/knowledge/%5Bid%5D/documents/route.ts) 在检查登录、库归属、文件类型、大小和非空正文后，把正文交给 [enqueueDocument](../apps/workflow/lib/services/knowledge-index-service.ts)：

~~~typescript
const document = await enqueueDocument(knowledgeBaseId, userId, {
  name: file.name,
  mimeType: file.type || 'text/plain',
  size: file.size,
  content,
})
~~~

`enqueueDocument` 先对知识库行加锁，读取其当前 READY 索引；若处于 `NEEDS_REBUILD`、`BUILDING` 等不可写状态则拒绝上传。随后在**同一 PostgreSQL 事务**创建原始 `Document`、对应 `DocumentIndex` 和一条 `PROCESS_DOCUMENT` 任务；任务 Payload 冻结 `documentIndexId`、`collectionName`，并更新计数和 `INDEXING` 状态。

这样“文档存在而任务完全没有记录”的风险降低；HTTP 返回的“处理中”意味着数据库中已记录待处理工作，不等于向量已写入。独立 worker 必须实际启动，否则任务只会停留在等待状态。

### 【Worker 怎样生成和写入真实 Chunk】

[常驻 worker 入口](../apps/workflow/scripts/knowledge-worker.ts) 循环调用 `runNextKnowledgeJob()`；[任务处理器](../apps/workflow/lib/services/knowledge-worker.ts) 认领任务后调用 `processDocument(documentIndexId, assertLease)`。后者见 [document-processor.ts](../apps/workflow/lib/services/document-processor.ts)：

~~~typescript
const config = {
  chunkSize: index.chunkSize,
  chunkOverlap: index.chunkOverlap,
}
const splitter = /\.(md|markdown)$/i.test(document.originalName)
  ? createMarkdownSplitter(config)
  : createTextSplitter(config)
const chunks = splitter.split(document.content)
~~~

这里首先使用**索引版本冻结的切分参数**，不是在任务重试时重新读取最新知识库设置。Markdown 分支保留标题路径等 Chunk Metadata；其机制继续参见[文档切分与入库专项](./RAG知识库构建与向量检索源码学习记录.md)。

当前 [OllamaEmbeddingService](../packages/ai-engine/src/knowledge/embeddings/ollama-embeddings.ts) 通过真实的 `POST /api/embed` 调用 `{ model, input: texts.map(trim), truncate: false }`，文档以最多 16 个 Chunk 为一批编码，并在请求前后再次读取模型 digest 校验。`validateDenseVector` 对向量长度、有限数、非全零进行校验；返回结果数量必须与输入 Chunk 数量一致，不能丢项、补零或静默截断查询/文档。若 `mxbai-embed-large:latest` 底层权重被更新，即使 tag 名字未变，digest 不匹配仍会拒绝继续处理并要求重建。

实际 Point 生成逻辑在 [qdrant-store.ts](../packages/ai-engine/src/knowledge/store/qdrant-store.ts)：

~~~typescript
vector: {
  [DENSE_VECTOR_NAME]: c.vector,
  [BM25_VECTOR_NAME]: bm25Document(c.content),
},
payload: {
  chunkId: c.id,
  content: c.content,
  chunkIndex: c.index,
  documentId: c.documentId,
  knowledgeBaseId: c.knowledgeBaseId,
  indexId: c.indexId,
  documentIndexId: c.documentIndexId,
  metadata: c.metadata ?? {},
}
~~~

写入前为 Point 计算基于 `indexId + chunkId` 的确定性 UUID，避免不同索引版本互相覆盖。最多每 100 个 Point 组成一批 `upsert(..., wait:true)`。重试时先通过 `documentIndexId` 删除该文档索引已有 Point，再重新写入；不同版本用不同身份，防止新旧结果混写。

向量 upsert 成功**不等于可以马上回答用户**。`processDocument` 写完后重新检查任务租约、知识库删除标记、文档删除标记和活动索引 ID；确认仍有效，才在事务中将 `DocumentIndex` 更新为 READY，将 `Document` 更新为 COMPLETED，并重新聚合统计。若处理期间发生删除或重建，则丢弃/清理旧版本 Point。`maybeActivateIndex` 在存活文档的 `DocumentIndex` 全部 READY 后将 BUILDING 索引切换到 READY。这解释了为何需要将存储成功与业务可检索状态分离。

## 【四、如何保证异步建索引和删除在失败时可恢复】

### 【持久任务不是“异步函数 + catch”】

[KnowledgeIndexJob](../apps/workflow/prisma/schema.prisma) 保存 `kind/status/attempts/availableAt/lockedAt/leaseToken/errorMessage/payload`。Worker 用 `PENDING + availableAt` 选择新任务，也会恢复超过租约时间的 RUNNING 任务。关键执行约束：

1. 使用 PostgreSQL session advisory lock，将同一知识库的任务尽量串行化；网络调用不长期占用数据库事务。
2. 在事务中认领任务，设置 `status=RUNNING`、`leaseToken` 并递增 `attempts`。
3. 执行期间每 10 秒更新租约时间；租约有效期设为 5 分钟。更新和完成均限制 `leaseToken`，防止旧 Worker 在任务被重新认领后改写新状态。
4. 单次失败重排 `PENDING` 并指数退避，最多 5 次后 `FAILED`；失败的处理任务会标记文档/索引状态，并可通过 [jobs API](../apps/workflow/app/api/knowledge/%5Bid%5D/jobs/route.ts) 重试。
5. 如果逻辑删除开始前仍有带有效租约的写任务，清理任务先等待，避免“删完后旧写入再次出现”。`assertLease` 在关键数据库事务和向量操作前后检查租约。

这些措施改善了崩溃后的重试和清理可恢复性，但不要把它称为 PostgreSQL 与 Qdrant 的**分布式原子事务**。向量写入和数据库状态提交依然不能在单个事务中完成；系统通过索引状态过滤、幂等点 ID、版本检查与补偿删除约束用户可见数据。`Promise.race` 类超时也不能自动终止所有已经发送的外部请求，避免把超时策略误写成底层取消保证。

### 【模型变更和重建：为什么这版选择阻断旧查询】

[rebuildKnowledgeBase](../apps/workflow/lib/services/knowledge-index-service.ts) 先探测目标空间，随后锁知识库、检查配置未在探测过程中变化且没有仍在运行的任务；取消待处理旧建索引任务，将旧索引标为 RETIRED，创建带新切分参数的 BUILDING 索引并**立即更换 `activeIndexId`**，再为存活文档批量创建新的 `DocumentIndex` 和处理任务。空库可直接 READY。旧索引另外排队 `DELETE_INDEX` 清理。

~~~text
原索引 READY
  ↓ 模型/维度/切分配置变更
旧索引 RETIRED ───→ DELETE_INDEX（持久清理）
  ↓
新索引 BUILDING（activeIndexId 指向它）
  ↓
上传/检索暂时拒绝；后台重新切分 + Dense/BM25 建索引
  ↓
所有存活 DocumentIndex READY
  ↓
新索引 READY → 恢复检索
~~~

这与另一种“先构建新索引、旧索引继续服务、验证后再切换”的无缝双版本方案不同。**当前项目明确采用重建期间停用旧查询路径**，没有自动旧索引回滚；优点是状态和来源更清晰，代价是重建期间知识库不可检索、不可继续上传。不要将双版本无缝切换写成实际已实现的行为。

**旧历史索引处理**也已经明确：新增迁移 [202610130002_require_index_rebuild](../apps/workflow/prisma/migrations/202610130002_require_index_rebuild/migration.sql) 将尚无活动索引的旧知识库标记 `NEEDS_REBUILD`，文档保留正文但标记需要重建。旧 `knowledge_chunks` 不会因迁移被自动清空，也**不会**被新查询重新解释为 `dense + bm25`。通过新 `knowledge_v2_<fingerprint>` Collection 重建后才能使用；缺少可重建正文的历史文档需重新上传。

### 【删除为什么是“立即不可见 + 延后清理”】

[文档/知识库删除服务](../apps/workflow/lib/services/knowledge-index-service.ts) 先设置 `deletedAt`，取消还没开始的上传处理任务，并将需要清理的 Collection 列表固化在 `DELETE_DOCUMENT`/`DELETE_KNOWLEDGE_BASE` 任务 Payload 中；接口立即返回 `cleanupPending`。后续 Worker 使用 Payload 定位 Qdrant Collection，按文档、索引或知识库范围删除，成功后才物理删除 PostgreSQL 实体。

如果先物理删除数据库记录再删 Qdrant，清理失败就可能丢失索引定位信息；如果仅依赖 Qdrant 删除即时完成，一旦失败就可能把旧数据继续返回给调用者。因此搜索链路还必须通过 `DocumentIndex READY`、`Document.deletedAt IS NULL`、`KnowledgeBase.deletedAt IS NULL` 和 `activeIndexId` 校验可见性，而不是只信任向量库返回了某个 Point。

## 【五、在线查询：从用户问题到多个向量空间的 TopK】

### 【单知识库与工作流检索共享哪一层】

现在 [单库搜索 API](../apps/workflow/app/api/knowledge/%5Bid%5D/search/route.ts) 在确认登录用户拥有该知识库后，调用：

~~~typescript
const retriever = createKnowledgeRetrievalService({
  kind: 'user',
  userId,
})
const results = await retriever.retrieve({
  query,
  knowledgeBaseIds: [knowledgeBaseId],
  mode,
  topK,
  threshold,
  vectorWeight: knowledgeBase.vectorWeight,
})
~~~

它不再自己选择默认 Embedding Model，也不再硬编码 Collection。工作流 [KnowledgeExecutor](../packages/ai-engine/src/nodes/executors/knowledge-executor.ts) 也不再自己 new 一套固定 Embedding，而是通过构造函数取得服务端注入的 `KnowledgeRetrievalService`：

~~~typescript
if (!this.retrievalService) {
  throw new Error('Authorized knowledge retrieval service is not configured')
}
const results = await this.retrievalService.retrieve({
  query: query.trim(),
  knowledgeBaseIds,
  mode: retrievalMode,
  topK,
  threshold,
})
~~~

因此一个工作流节点仍只需配置 `knowledgeBaseIds: string[]`、`query`、`retrievalMode`、`topK` 等字段；用户不用在节点上填写 768/1024 维。`core/engine.ts` 通过 `WorkflowEngineConfig.knowledgeRetrieval` 注入服务，`createDefaultRegistry` 将它交给知识节点；缺少可信服务的节点选择显式报错，而非回退到默认模型或越权访问向量库。

### 【真实分组算法：一份查询在何处变成多份向量】

[MultiKnowledgeRetriever](../packages/ai-engine/src/knowledge/retriever/multi-knowledge-retriever.ts) 先验证 Query/TopK，去重知识库 ID，调用 `deps.resolveIndexes(ids)` 获取**已经授权**的 READY 活动索引。返回条数、每个请求 ID 和协议都要校验；只有 `provider=ollama`、`bm25ConfigId` 与编码版本匹配的描述符才可参与本次检索。

代码中的关键步骤：

~~~typescript
const groups = new Map<string, KnowledgeIndexDescriptor[]>()
for (const index of indexes) {
  const group = groups.get(index.embeddingSpaceId) ?? []
  group.push(index)
  groups.set(index.embeddingSpaceId, group)
}
const candidateTopK = Math.min(
  100,
  Math.max(20, options.topK * 4)
)
~~~

同一个 `embeddingSpaceId` 内再校验模型、digest、维度、Collection、BM25 配置是否一致。之后按空间创建或复用 `QdrantVectorStore` 和 `OllamaEmbeddingService`。如果检索模式为 `fulltext`，代码**不创建 Dense Embedding Service**。各空间并发上限默认 3，单空间请求超时阈值默认 30 秒；任何必需空间失败，整个调用抛错，不默默返回部分库的结果。

~~~text
Query = “年假如何申请？”
KB-A、KB-B → Space-A（一个 1024 维 Query 向量）
KB-C       → Space-B（一个 768 维 Query 向量）
                       ↓
  每个空间按 mode 执行独立的 Qdrant Collection 检索
                       ↓
  每空间最多取扩展候选 candidateTopK
                       ↓
  对照授权的 (knowledgeBaseId, indexId) 校验候选
                       ↓
  仅保留 READY DocumentIndex + 未删除的文档/库
                       ↓
  再次解析授权和活动索引（防止查询期间撤权/切换）
                       ↓
  跨空间融合或单空间直通
                       ↓
  最后再过滤可见性，截取全局 TopK
~~~

注意分组不是对整个 Qdrant 实例盲搜；`resolveIndexes` 若发现缺少知识库、状态不是 READY、模型协议不符或权限错误就拒绝。对被查询之外的模型没有必要额外生成 Query Embedding。

### 【Qdrant 检索为什么需要成对的 KB/Index 条件】

实际的 [QdrantVectorStore.filter](../packages/ai-engine/src/knowledge/store/qdrant-store.ts) 构建：

~~~typescript
return {
  should: scopes.map(s => ({
    must: [
      { key: 'knowledgeBaseId', match: { value: s.knowledgeBaseId } },
      { key: 'indexId', match: { value: s.indexId } },
    ],
  })),
}
~~~

表示对每一组身份做 `(KB=A AND Index=a) OR (KB=B AND Index=b)`。如果把 `knowledgeBaseId IN [A,B]` 和 `indexId IN [a,b]` 当作两个可独立组合的过滤条件，就可能混入错误的 KB/Index 配对。`QdrantVectorStore.search` 与 `textSearch` 共用这份过滤；Qdrant 的 Filter 是数据库召回约束，之后应用层还会做状态和权限复核。

### 【vector / fulltext / hybrid 在代码里究竟执行什么】

[HybridRetriever](../packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts) 将三种模式变成明确的检索路径：

| 模式 | 实际动作 | 需要 Dense Query Embedding？ |
| --- | --- | --- |
| `vector` | Ollama Embed Query → `Qdrant client.query({using:'dense'})` | 是 |
| `fulltext` | `bm25Document(Query)` → `Qdrant client.query({using:'bm25'})` | 否 |
| `hybrid` | Dense 与 BM25 并行召回 → 组内加权 RRF | 是 |

Qdrant 代码的两条路径分别为：

~~~typescript
// Dense：向量由当前空间的 Ollama 模型产生
await this.client.query(this.collectionName, {
  query: options.vector,
  using: 'dense',
  filter,
  limit: options.topK,
  score_threshold: options.threshold ?? 0,
})

// BM25：Query 原文由 Qdrant 原生推理产生稀疏表示
await this.client.query(this.collectionName, {
  query: bm25Document(options.query.trim()),
  using: 'bm25',
  filter,
  limit: options.topK,
})
~~~

新 `textSearch()` 已经不再调用 `scroll(limit:1000)` 后逐条 `includes()` 或在 Node.js 用正则统计词频，而是从 Qdrant 稀疏索引返回 BM25 排名。BM25 与 Dense 仍然各自有局限：精确术语通常更利于词项匹配；同义改写通常更利于语义模型。`threshold` 仅作用于 Dense，不应直接拿 0～1 的 Cosine 阈值过滤 BM25 或 RRF。

## 【六、结果融合：为什么同时有“组内”和“跨空间”两层】

### 【先看分数含义，再决定如何排序】

假设 Model-A 的候选分数为 0.82（Dense Cosine），Model-B 的某候选 BM25 分数为 5.7；这两个值不是同一量纲，不能简单相加。甚至两个 Dense 模型都使用 Cosine，其训练结果和分数分布也不一定可比。项目采用基于**排名**而非原始分数的 Reciprocal Rank Fusion（RRF）。

当前 [rank-fusion.ts](../packages/ai-engine/src/knowledge/retriever/rank-fusion.ts) 核心计算：

~~~typescript
const contribution = list.weight / (60 + rank + 1)
const key = evidenceKey(result)
candidates.set(key, {
  ...result,
  score: (previous?.score ?? 0) + contribution,
  scoreType: 'rrf',
  sources: [...(previous?.sources ?? []), ...originInfo],
})
~~~

上面是对实际代码关键语句的简化展示，完整 `sources` 处理详见源码。对同一证据，RRF 在其出现的每份有权重候选列表中累加 `weight/(60+rank)`。组内 `hybrid` 使用 `vectorWeight` 与 `1-vectorWeight` 分别作为 Dense/BM25 权重；跨空间列表则使用等权重 1。融合结果按 RRF 分数降序，分数相同时按稳定的证据键排序。

[HybridRetriever.hybrid](../packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts) 先将每一路候选数扩充为 `ceil(topK×1.5)`（上限 100），通过 `fuseRankedLists(...)` 合并，截取本空间候选列表；随后 [MultiKnowledgeRetriever](../packages/ai-engine/src/knowledge/retriever/multi-knowledge-retriever.ts) 对不同空间的候选列表再次 RRF，并最后按节点的全局 `topK` 截断。跨空间默认候选数量 `min(100,max(20,topK×4))`，不是每个模型最后各返回 5 条直接拼接。

去重不能只看正文是否相似。当前 `evidenceKey()` 将 `knowledgeBaseId`、`indexId`、`documentId` 和 `chunkId` 拼为身份，确保同一个 Chunk 在 Dense/BM25 中命中时能够融合，但新旧索引版本即使内容相似也不会错误合并为同一条记录。

`RetrievalResult` 保留 `scoreType`（`cosine`、`bm25`、`rrf`）、`sources`（各来源分数、名次、空间及索引版本）、`metadata` 与正文；`KnowledgeExecutor` 的 JSON 输出以 `{...r}` 保留这些字段，而 `text` 输出仍按原有方式拼接文本。

**RRF 的重要边界**：不同 Collection 的 Chunk 列表往往没有交集，同名次可能得到相同贡献，最终结果并不代表模型相关性已“统一标定”。当前项目**没有实现统一 Reranker**，也不能凭“有两层 RRF”就断言 Evidence Recall/nDCG 已得到提升。需要使用问题-证据标注集做跨空间排序评测。

## 【七、权限与可见性：检索范围不是客户端传来的任意 ID】

当前 [KnowledgeRetrievalService 业务适配器](../apps/workflow/lib/services/knowledge-retrieval.ts) 支持两种服务端作用域：

- `{kind:'user', userId}`：单知识库 API 与编辑器测试，需确认库归属当前登录用户；
- `{kind:'published', appId, publishedAppId}`：API Key、SSE 和公开 WebApp，需确认应用仍已发布、发布版本仍激活、指定库在发布节点静态声明范围内，并且仍归属应用所有者。

发布时由 [collectPublishedKnowledgeBaseIds](../packages/ai-engine/src/knowledge/published-knowledge.ts) 读取知识节点中的静态 `knowledgeBaseIds`，不接受动态变量在调用期间扩大知识库范围；[publish API](../apps/workflow/app/api/apps/%5Bid%5D/publish/route.ts) 还检查库归属和 READY 索引。实际服务适配器分别位于 [workflow](../apps/workflow/lib/services/knowledge-retrieval.ts)、[api-server](../apps/api-server/src/modules/workflow/knowledge-retrieval.ts)、[webapp](../apps/webapp/lib/services/knowledge-retrieval.ts)。

~~~text
用户登录的编辑器测试：
  当前用户身份 → 校验知识库归属 → 解析活动 READY 索引

公开/发布调用：
  激活发布版本 → 收集快照静态知识库 ID
              → 逐库核验归属及 READY 活动索引
              → 只允许快照范围的检索
~~~

**快照冻结的是节点可访问的知识库 ID，不是知识库正文快照**：发布后同一知识库新完成的文档可以进入后续检索；取消发布、库归属变化、活动索引切换或删除标记会在执行时重新检查。`filterVisibleResults` 还会去 PostgreSQL 查询 `DocumentIndex.status='READY'`、文档和知识库未删除、`(documentIndexId, documentId, indexId)` 配对正确。`MultiKnowledgeRetriever` 在查询前、查询后及输出前再次确认授权/索引版本和数据可见性，避免“Qdrant 已返回旧 Point”直接变成可引用证据。

这也说明为什么 `KnowledgeExecutor` 不应该相信普通 `WorkflowInput` 中的 `userId` 或 `collectionName`：它们可以被调用者伪造。模型调用、数据访问和授权的装配需要发生在可信业务服务端。

## 【八、当前实现的选择、未完成部分与验证方法】

### 【为什么采用按空间分 Collection，而不是所有库共享一个向量表】

| 方案 | 可行性 | 当前取舍 |
| --- | --- | --- |
| 所有库共享匿名 Dense Collection | 只能满足单一维度/空间；相同维度的异模型会语义污染 | 已停止作为新索引方案 |
| 每个 KnowledgeBase 建独立 Collection | 可隔离，但同模型多库重复索引资源，库数量扩大后管理开销增加 | 当前未采用 |
| 每个不可变 Embedding Space 一个 Collection | 各模型有独立 Dense Schema；同空间多库可共享 Query Embedding 和 Collection，并通过 KB/Index Filter 隔离 | **当前已实现** |
| 同一个 Point 配多套 Dense Named Vectors | 适合同一 Chunk 要由多种模型表示、进行多 Dense 查询的情况 | 当前不需要；命名 `dense` 不等于多模型多 Dense |

Qdrant 的 Collection 在这里不是独立的 PostgreSQL 数据库；当前仍使用 Qdrant 服务，Collection 由不可变空间指纹寻址。`bm25` 虽然共用命名字段，但其词项协议冻结为一个 `BM25_CONFIG_ID`；不同 Dense Space 仍要向各自 Collection 发送 BM25 Query，不能因 BM25 编码器相同而误认为一个查询自动搜索了所有 Collection。

### 【状态边界和运行前提】

此次代码覆盖了存储空间、索引版本、任务生命周期与权限链路；但**代码存在不等于业务数据已部署、真实模型已安装或检索效果达标**。当前仓库中包含 [multi-knowledge 单元测试](../packages/ai-engine/src/knowledge/__tests__/multi-knowledge.test.ts)、[Qdrant Store 测试](../packages/ai-engine/src/knowledge/__tests__/qdrant-store.test.ts)、[知识库生命周期集成测试](../packages/ai-engine/tests/integration/knowledge-lifecycle.test.ts)。集成测试用 `KNOWLEDGE_INTEGRATION_DATABASE_URL` 和 `QDRANT_INTEGRATION_URL` 控制条件运行：缺少这些环境变量时会 skip，不能只看测试文件存在就声称在目标业务环境跑通。

[Docker Compose](../docker/docker-compose.yml) 已将 Qdrant 镜像固定为 `qdrant/qdrant:v1.16.2`；部署仍需要应用迁移、实际 Ollama 模型、`DATABASE_URL`、`QDRANT_URL`、常驻 worker 及发布入口的端到端验证。原独立实施计划提到过一份“部署与验证记录”，但本次仓库读取未找到该文件，因此这里不作不存在的记录引用，也不据此声称已复核完整线上验收结果。

### 【验收应从实际输入到最终证据逐层进行】

| 需要回答的问题 | 可复核的测试与期望 |
| --- | --- |
| 同模型、同空间两个知识库 | 一次 Query Dense Embedding；Filter 严格限定两对 KB/Index |
| 不同维度（如 1024/768） | 对应空间各自生成正确维度并进入匹配 Collection；不补零、不截断 |
| 维度相同但模型不同 | `EmbeddingSpace` digest/协议指纹不同；不能误共享 Collection |
| BM25 是否真替换旧扫描 | `fulltext` 只调用 `using:'bm25'`，不请求 Dense；超过 1000 Chunk 仍可通过词项索引召回 |
| `hybrid` 与 TopK | Dense + BM25 组内 RRF，空间间 RRF；最终统一 TopK；原始分数与来源保留 |
| 中文及技术词 | 测试完整中文、空白/标点、`E1042`、`C++` 等；区分词项匹配与精确身份匹配 |
| 未授权、撤权、重建、删除 | 在调用前后校验当前库/索引状态；只返回 READY 的存活文档 |
| 宕机、任务失败、并发删除 | 重试租约恢复、状态幂等、软删即时隐藏、清理补偿可追踪 |
| 发布态执行 | 静态知识库 ID 快照 + 当前应用拥有者权限；取消发布或索引不可用时拒绝 |
| 检索质量和成本 | 固定 Qrels，比较 Dense、BM25、Hybrid 的 Evidence Recall@K、MRR/nDCG、耗时和失败率 |

### 【仍需继续验证与演进的点】

1. **真实部署与模型可用性**：不同 Ollama 模型的 digest、维度、吞吐与超时要在实际目标环境完成联调；现有端到端代码并不自动保证每种模型已安装。
2. **中文 BM25 词项质量**：`multilingual` Tokenizer 不保证业务编号整体匹配；对明确需要完全相等的合同编号、工单号应再设计精确字段匹配或额外 Analyzer，不应把 BM25 相关性检索当作业务主键查询。
3. **分数校准和全局排序**：当前 Dense threshold 仍是全空间共用的节点参数，不具备按模型概率意义的自动标定；多列表 RRF 的平分和来源公平性需要标注集，必要时引入统一 Reranker。
4. **可用性取舍**：重建期间不允许查询和上传；若将来需求要求零停机，就要另外设计旧索引服务与新索引构建的版本切换，不能把未实现的双写/回滚描述成现状。
5. **跨系统一致性**：PostgreSQL 与 Qdrant 不具备单个原子事务，依靠工作任务、版本状态、最终授权过滤维持“未准备好的数据不对外可见”；应通过故障注入检验极端并发下的补偿和清理。
6. **检索资源消耗**：空间数量增加会放大 Query Embedding 与 Qdrant 请求；当前限制并发数和候选数，但需要基于真实负载评估缓存、限流、按需路由。超时由 `Promise.race` 实现，不代表底层外部调用已被真正取消。

## 【九、从源码到面试回答：为什么这样设计、怎样验证】

**问题一：一次查询多个不同维度知识库，必须生成几份向量？** 不按知识库数量算，而按本次授权目标中的兼容 Embedding Space 数量算。A/B 同空间、C 另一空间，则 Dense Query Embedding 两次。BM25 为独立的词项检索路径，`fulltext` 模式不需要 Dense Query；三个知识库依然分别由空间和索引范围过滤。

**问题二：为何不同模型同为 1024 维仍要隔离？** 向量维度只决定张量形状，不定义坐标语义。此项目使用模型 digest、模型名、维度、距离、编码版本及 BM25 协议生成空间指纹，防止同维异模型混存。

**问题三：为何引入 DocumentIndex 而非只存 Document.status？** 同一文档可能经历多个知识库索引版本，只有 `DocumentIndex(documentId, knowledgeBaseIndexId)` 才能准确说明哪一份向量已构建完成；Qdrant 返回旧 Point 时也能够依该状态拒绝不可用证据。

**问题四：为什么 BM25 也叫 Sparse Vector？** 这是 Qdrant 为词项及权重提供的检索表示，不是 Dense Embedding；当前通过原生 `qdrant/bm25` 把 Query/Document 文本交给推理接口并生成稀疏索引。它擅长词项匹配，和 Dense 的语义召回互补。

**问题五：多个空间的分数如何统一？** 不直接相加 Cosine 和 BM25，也不能跨不同模型直接比 Cosine。当前按候选排名做空间内加权 RRF 和空间间等权 RRF，保留来源原始分数；最终 TopK 统一裁剪，效果仍需 Qrels 评测。

**问题六：如何保证异步入库和删除可靠？** 上传原子创建任务，worker 认领后带租约执行，Point 身份按版本稳定生成，索引 READY 后才可检索；删除先设置 `deletedAt` 即时隐藏，再用持久清理任务删除历史 Point。它是可恢复的最终一致性流程，不是跨 PostgreSQL/Qdrant 的分布式原子事务。

## 【源码与官方参考资料】

**源码主链路**：
- [Prisma 模型与索引版本状态](../apps/workflow/prisma/schema.prisma)、[Embedding Space 创建](../apps/workflow/lib/services/embedding-space-service.ts)、[模型 digest 获取](../packages/ai-engine/src/knowledge/embeddings/model-revision.ts)
- [知识库创建 API](../apps/workflow/app/api/knowledge/route.ts)、[配置更新](../apps/workflow/app/api/knowledge/%5Bid%5D/route.ts)、[索引重建 API](../apps/workflow/app/api/knowledge/%5Bid%5D/reindex/route.ts)
- [文档上传](../apps/workflow/app/api/knowledge/%5Bid%5D/documents/route.ts)、[任务排队与重建](../apps/workflow/lib/services/knowledge-index-service.ts)、[文档处理](../apps/workflow/lib/services/document-processor.ts)、[Worker](../apps/workflow/lib/services/knowledge-worker.ts)
- [BM25 固定协议](../packages/ai-engine/src/knowledge/bm25.ts)、[Ollama 向量编码](../packages/ai-engine/src/knowledge/embeddings/ollama-embeddings.ts)、[Qdrant Store](../packages/ai-engine/src/knowledge/store/qdrant-store.ts)
- [单库检索 API](../apps/workflow/app/api/knowledge/%5Bid%5D/search/route.ts)、[授权索引解析](../apps/workflow/lib/services/knowledge-retrieval.ts)、[跨空间检索](../packages/ai-engine/src/knowledge/retriever/multi-knowledge-retriever.ts)、[组内 Hybrid](../packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)、[RRF](../packages/ai-engine/src/knowledge/retriever/rank-fusion.ts)
- [KnowledgeExecutor](../packages/ai-engine/src/nodes/executors/knowledge-executor.ts)、[引擎服务注入](../packages/ai-engine/src/core/engine.ts)、[发布态知识库静态声明](../packages/ai-engine/src/knowledge/published-knowledge.ts)
- [代码级单元测试](../packages/ai-engine/src/knowledge/__tests__/multi-knowledge.test.ts)、[数据库与 Qdrant 生命周期集成测试](../packages/ai-engine/tests/integration/knowledge-lifecycle.test.ts)

**官方机制参考**：
- [Qdrant Collections](https://qdrant.tech/documentation/manage-data/collections/)、[Qdrant Vectors](https://qdrant.tech/documentation/manage-data/vectors/)、[Qdrant Hybrid Queries](https://qdrant.tech/documentation/search/hybrid-queries/)
- [Qdrant BM25](https://qdrant.tech/documentation/inference/inference-bm25/)、[Qdrant v1.16.2 BM25 实现](https://github.com/qdrant/qdrant/blob/v1.16.2/src/common/inference/bm25.rs)
- [Ollama Embed API](https://docs.ollama.com/api/embed)

