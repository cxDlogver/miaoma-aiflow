# RAG 多 Embedding 知识库跨空间检索改造实施计划

> 状态：待实施。本文为任务分解、源码改造顺序和验收标准，不代表代码已经支持多模型联合检索，也不记录尚未执行的测试结果。
>
> 对应设计讨论：[RAG 多 Embedding 模型知识库隔离与跨模型检索设计分析](./RAG多Embedding模型知识库隔离与跨模型检索设计分析.md)。基础链路见 [RAG 知识库构建与向量检索源码学习记录](./RAG知识库构建与向量检索源码学习记录.md)，检索质量见 [RAG 检索能力评测与证据标注源码学习记录](./RAG检索能力评测与证据标注源码学习记录.md)。

## 【一、改造目标与交付边界】

当前工作流知识节点可以多选知识库，但向量检索实际依赖单个 `EmbeddingService`、单个 `knowledge_chunks` Collection 和一个 `HybridRetriever`。目标是让一个节点能够检索**不同模型、不同维度、不同向量空间**的知识库，独立召回候选，再合并成统一、可追溯的检索结果。

用户继续使用现有节点配置中的 `knowledgeBaseIds`、`query`、`retrievalMode`、`topK`、`threshold` 和 `outputFormat`，不要求在节点上手填向量维度。模型、版本、维度与目标 Collection 应从知识库已建立的索引配置读取；**不能根据查询文本长短决定向量维度**，也不能靠维度相等推断不同模型的语义空间兼容。

### 【完成后的业务表现】

~~~text
KnowledgeNode：query + [KB-A, KB-B, KB-C]
                     ↓
调用者身份和知识库授权校验
                     ↓
加载三个知识库的有效向量索引配置
                     ↓
按 Embedding Space 分组
            ┌────────┴─────────┐
            ▼                  ▼
        Space-A              Space-B
       KB-A、KB-B             KB-C
   Model-A / 1024维      Model-B / 768维
            │                  │
    Query Embedding-A  Query Embedding-B
            │                  │
   Collection-A + Filter  Collection-B + Filter
            │                  │
        组内召回             组内召回
            └────────┬─────────┘
                     ▼
              合并、去重、融合
                     ▼
              可选统一 Rerank
                     ▼
        最终 TopK + 证据来源及状态
                     ▼
              KnowledgeNode 输出
~~~

### 【范围分层】

- **必须交付**：向量空间身份与存储定位；离线按空间写入；单库查询兼容；工作流多库授权与分组；多空间查询向量生成和独立检索；统一候选融合与 TopK；历史默认索引兼容；最小完整测试。
- **本次保留/复用**：原有 `KnowledgeSettingsForm` 多选交互、`HybridRetriever` 单空间检索协议、Qdrant Payload Filter、Document Chunking、已有 Embedding 输出校验。
- **暂不包含**：全面替换为 Named Vectors、通用跨模型向量对齐训练、给同一 Chunk 预生成所有模型的向量、重新建设 BM25、引入复杂模型路由 Agent、无依据的性能指标承诺。独立 Reranker 可作为后续增强，基础版本先交付正确的跨空间召回及明确的排名融合。

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
| 检索与融合 | `packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts` | 一份 Query 向量做向量检索；现有 RRF 是组内向量 + 文本候选融合 | 增加**跨空间**汇总与排名策略，避免直接比较异构相似度 |
| 引擎注册/身份 | `packages/ai-engine/src/nodes/index.ts`、`packages/ai-engine/src/core/engine.ts` | `createDefaultRegistry()` 无参数地创建 `KnowledgeExecutor()`，`ExecutionContext` 未直接承载可用于知识库授权的主体信息 | 需要从业务入口注入已验证身份与知识库配置读取能力 |
| 文档与库删除 | `apps/workflow/app/api/knowledge/[id]/documents/[docId]/route.ts`、`apps/workflow/app/api/knowledge/[id]/route.ts` | 按固定集合删向量；删除知识库仍有 Qdrant 清理 TODO | 按历史/当前索引空间精准删除，不留下可检索的孤儿数据 |
| 多入口运行 | `apps/workflow/app/api/apps/[id]/workflow/run/route.ts`、`apps/api-server/src/modules/workflow/workflow.service.ts` | 编辑器测试和应用/API 运行是不同入口 | 两条路径均需注入被验证的执行主体与检索依赖 |

**前置风险**：如果只重构 `KnowledgeExecutor` 而不改变离线存储及 Collection 路由，那么不同维度仍无法共存；如果先开放自定义模型而尚未实现空间隔离，相同维度但不同模型的向量可能混存，造成没有报错的检索质量问题。实施顺序必须从数据与权限约束开始。

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
  vectorType         本期只支持 dense
  queryEncodingVer   Query 编码协议版本
  documentEncodingVer Document 编码协议版本
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
  source: 'vector' | 'fulltext' | 'hybrid'
}
~~~

`RetrievalPrincipal` 是**可信服务端上下文**，不能由用户在节点 JSON 或普通工作流输入中任意声明。除了保存 ID，还应在每次查询时对当前授权状态进行检查；发布工作流的 API Key 是否继承应用拥有者权限、能访问哪些知识库，需要形成明确政策，不能默认允许访问全部知识库。

建议边界：
- `apps/workflow`、`apps/api-server`：负责 Prisma、应用权限、活动索引解析、模型服务凭据与 Collection 关联。
- `packages/ai-engine`：以注入的授权配置描述符或应用层提供的 `KnowledgeRetrievalService` 执行检索，避免直接依赖 Next.js Cookie、Prisma 或客户端传来的任意 Collection 名。
- `KnowledgeExecutor`：处理变量、节点参数、调用服务、序列化结果；不再推断模型/维度。
- `MultiKnowledgeRetriever`：负责分组、调度、失败策略、候选融合，复用 `HybridRetriever` 执行单空间查询。
- `QdrantVectorStore`：维持一个实例对应一个 Collection 的清晰责任。

## 【四、按依赖顺序实施的任务清单】

### 【阶段 0：冻结兼容基线与迁移输入】

**T00-1 [ ] 清点历史知识库及 Qdrant 数据。** 统计当前知识库模型、维度、Document 状态和共享 `knowledge_chunks` 中的 Point/过滤字段；判断旧向量是否都使用同一种受控模型版本。对于来源不明的历史向量，标记“需重建”，不要仅凭维度将其归入默认空间。

**T00-2 [ ] 建立基线测试与回滚数据。** 固定同模型双知识库、异维度知识库、同维不同模型知识库的教学测试数据；保留单库搜索、工作流节点 JSON 及已发布工作流的输出样本。记录当前可重复的检索行为，而非虚构实际效果。

**交付**：清点记录、默认空间兼容策略、测试样本与数据库备份/快照策略。没有可靠的旧向量来源确认之前，不执行原地覆盖式迁移。

### 【阶段 1：空间身份、索引版本与配置解析】

**T01-1 [ ] 数据库迁移。** 修改 `apps/workflow/prisma/schema.prisma` 并生成迁移，增加稳定空间、知识库活动索引、文档写入版本的关系。为外键、状态及唯一性设置必要约束；默认已有知识库不因新字段而失去可用性。

**T01-2 [ ] 建立统一解析服务。** 在业务层新增 `resolveKnowledgeBaseIndex(knowledgeBaseId)`、`resolveAuthorizedIndexes(principal, ids)` 与 `resolveDocumentIndex(documentId)`（名称为建议）。返回可信的空间/Collection 描述符，对缺少有效索引、模型版本不明、维度错误等情况显式拒绝。

**T01-3 [ ] 定义创建/变更配置的业务规则。** 现有创建接口只使用默认模型，更新接口也未开放模型字段。先增加受控创建配置，校验供应商、模型可用性、实际输出维度与空间记录；已有知识库切换模型必须转为**新建索引版本＋重新 Embedding**，不能直接就地修改配置而不重新索引。

**T01-4 [ ] 建立默认 Collection 兼容映射。** 对已确认使用默认空间的老数据，将其索引记录映射至现有 `knowledge_chunks`；不重命名或删除旧集合。其他无法证明模型来源的记录先停止自动纳入跨模型检索。

**预期变更文件**：
- `apps/workflow/prisma/schema.prisma` 和新迁移；
- 新增 `apps/workflow/lib/services/embedding-space-service.ts` / `knowledge-index-service.ts`（建议命名）；
- `apps/workflow/app/api/knowledge/route.ts`、`apps/workflow/app/api/knowledge/[id]/route.ts`；
- 相应类型与状态转换校验。

**阶段验收**：能从 KB-A、KB-B 得到同一 Space；从 KB-C 得到不同 Space；给定非法/未授权 KB ID 不返回任何 Collection 信息；旧默认知识库仍能解析到原有索引。

### 【阶段 2：离线入库、删除与版本安全切换】

**T02-1 [ ] 在文档上传时固定索引目标。** 修改 `apps/workflow/app/api/knowledge/[id]/documents/route.ts`：先读活动写入配置的快照，再交给 `processDocument()`。并发更改模型不应导致同一文档部分 Chunk 用模型 A、部分用模型 B。

**T02-2 [ ] 按空间写入 Qdrant。** 修改 `apps/workflow/lib/services/document-processor.ts`：用描述符中的 `collectionName`，根据指定模型生成 Embedding；保留现有数量、实际维度、NaN/Infinity、全零向量校验；`ensureCollection()` 仍校验 Collection Schema。Point 保留 `knowledgeBaseId`、`documentId`、`metadata` 和便于追踪的索引版本字段。

**T02-3 [ ] 补齐删除与重试幂等。** 文档删除通过其已写入的 `DocumentIndex` 定位全部仍在使用的空间；知识库删除触发所有索引版本的向量清理。注意当前删除文档接口是先删 PostgreSQL 记录再调用固定 Collection 删除，修改后不能先丢失定位信息再试图清理向量。建议使用可重试删除任务并保存清理状态，失败要可重新执行。

**T02-4 [ ] 提供模型迁移的安全切换。** 创建新索引、按原始文档重新生成向量、校验覆盖及检索结果；只有 `READY` 的新索引才允许激活；活动索引切换后，新查询读新版本，失败可回滚到旧版本。迁移期间读旧/写新/删除的并发边界需明确，避免混合使用新旧结果。

**预计涉及**：
- `apps/workflow/app/api/knowledge/[id]/documents/route.ts`、`apps/workflow/lib/services/document-processor.ts`；
- `apps/workflow/app/api/knowledge/[id]/documents/[docId]/route.ts`、`apps/workflow/app/api/knowledge/[id]/route.ts`；
- `packages/ai-engine/src/knowledge/store/qdrant-store.ts`；
- 新增索引迁移/删除服务和可重试任务实现（是否引入队列由现有运行环境评估）。

**阶段验收**：同一 Qdrant 实例可保存 A/B 两种维度至不同 Collection；768 维向量不会进入 1024 维空间；已删除文档不再出现在检索结果中；失败重试不产生可见重复 Chunk；新索引未就绪不会影响旧索引查询。

### 【阶段 3：统一单库检索入口，确保新旧一致】

**T03-1 [ ] 调整单知识库搜索 API。** `apps/workflow/app/api/knowledge/[id]/search/route.ts` 不再硬编码 `knowledge_chunks`。在用户归属校验后解析活动索引，按该索引的模型、维度和 Collection 执行检索；明确区分缺索引、索引准备中、模型服务失败。

**T03-2 [ ] 校验在线 Query Vector。** `HybridRetriever` 的 `embedText(query)` 返回后，验证实际维度、有限数值、非全零和空间协议；当前 `OllamaEmbeddingService.getDimensions()` 只返回配置值，并没有对 `embedQuery()` 的实际输出进行维度保证。必要时将这类校验纳入独立公共函数供入库和查询复用。

**T03-3 [ ] 规范检索模式。** 当前 `fulltext` 实际使用 `scroll(limit:1000)` 与本地字符串匹配，并非 BM25。保持现有行为作为兼容基线，但将该模式的索引覆盖限制和质量边界写入文档；多 Collection 下的纯文本搜索要访问对应索引范围，不能误认为向量跨空间检索已自动完成。

**阶段验收**：单 KB API 在默认空间和新空间都能返回正确文档；查询向量与目标索引维度不一致时在 Qdrant 查询前得到明确错误；现有 API 返回格式保持兼容。

### 【阶段 4：工作流鉴权、依赖注入与多空间检索编排】

**T04-1 [ ] 贯通可信执行主体。** 当前 `createWorkflowEngine()`、`createDefaultRegistry()` 和 `new KnowledgeExecutor()` 之间没有直接承载应用用户/授权知识库列表的契约。需要改造依赖注入：由业务入口确定 principal，注入知识库配置/授权服务和检索服务，不让 `ai-engine` 直接读取浏览器 Cookie 或信任流程节点里携带的 owner ID。覆盖编辑器测试运行、API Key 发布调用及其他实际调用引擎的入口。

**T04-2 [ ] 实现 MultiKnowledgeRetriever。** 推荐在 `packages/ai-engine/src/knowledge/retriever/` 下新增 `multi-knowledge-retriever.ts`（如授权配置获取只能驻留服务端，可将编排器放业务层，再给节点注入标准接口）。执行顺序必须是：授权验证 → 读取 READY 索引 → 空间分组 → 每组创建对应 EmbeddingService/VectorStore → 查询向量校验 → 各组检索。

**T04-3 [ ] 空间内复用 HybridRetriever。** 保留 `HybridRetriever` 的 vector/fulltext/hybrid 逻辑；每个组的 `knowledgeBaseIds` 只包含该空间下且已授权的知识库。以 `Promise.all` 执行多路召回前，添加受控并发限制、超时和错误分类。**默认严格模式**：任一必需空间失败则整个检索失败；若后续开放允许降级，返回值必须显式标明未覆盖的空间和知识库。

**T04-4 [ ] 更改 KnowledgeExecutor 调用与注册。** 取消 `KnowledgeExecutor` 直接固定模型、维度与集合的依赖，保留解析变量及节点输出责任。相应调整 `packages/ai-engine/src/nodes/index.ts`、`core/engine.ts` 的依赖注册与服务注入，但保持旧工作流 `KnowledgeNodeConfig` 的 JSON 格式可继续加载执行。

**主要文件**：
- `packages/ai-engine/src/nodes/executors/knowledge-executor.ts`、`packages/ai-engine/src/nodes/index.ts`、`packages/ai-engine/src/core/engine.ts`；
- `packages/ai-engine/src/types/node.ts` / `core/context.ts` 等服务注入契约；
- `apps/workflow/app/api/apps/[id]/workflow/run/route.ts`；
- `apps/api-server/src/modules/workflow/workflow.service.ts`、其他可确认的工作流运行入口；
- 新增 `MultiKnowledgeRetriever` 与业务侧索引解析适配器。

**阶段验收**：多选两个相同空间知识库，Query Embedding 只计算一次；多选两个不同空间知识库，各自使用正确模型及 Collection；无权库即使被手动写入节点 JSON 也不可检索；编辑器测试执行和已发布 API 入口行为一致。

### 【阶段 5：跨空间候选融合与结果输出】

**T05-1 [ ] 扩展 RetrievalResult 但保持原输出兼容。** 在 `packages/ai-engine/src/knowledge/types.ts` 中设计 `sourceScore`、`sourceRank`、`embeddingSpaceId`、`indexId`、`retrievalSource` 等可选字段；明确 `score` 是原始相似度还是融合后的分数，避免把融合分数误当 0～1 的 Cosine 相似度。现有 JSON 消费者继续看到 `content`、`chunkId`、`documentId` 等既有字段。

**T05-2 [ ] 实现合并去重。** 收集各空间候选，基于跨空间稳定的 `documentId + chunkId + indexId` 或明确的统一文档身份去重；不盲目用 `chunkId` 认定两个索引版本语义相同。对重复证据保留来源列表，以便引用与调试。

**T05-3 [ ] 实现基础跨空间融合。** 每个空间先检索 `candidateTopK`（可以是最终 `topK` 的若干倍并设置上限），再以排名融合得到全局结果；禁止跨模型原始相似度直接 `sort((a,b) => b.score-a.score)`。可先使用 RRF 作为低成本基线，但需说明：**不同空间候选几乎完全不重合时，RRF 同名次可能打平，无法证明语义上谁更相关**；定义明确、稳定的 tie-breaker 与空间公平性策略。

**T05-4 [ ] 保留后续统一 Reranker 扩展点。** 以相同 Query + 不同来源 Chunk 文本统一重排是更强的跨空间相关性对齐方式；首批可不开启，先保留 `RerankProvider`/配置开关接口，待评测有收益再接入模型。

**T05-5 [ ] 统一最终 Top K 与返回语义。** 先得到组内候选，再跨空间融合，**最后**截取最终 `topK`；不要每组各返回 `topK` 之后直接拼接作为节点最终结果。`KnowledgeExecutor` 原有 `text/json` 输出应保留，并向结构化结果添加来源字段；禁止越权来源、已删除文档和无效版本进入输出。

**阶段验收**：结果不直接以异构 Cosine 分数比较；多空间最终数量不超过用户设定 TopK；来源、分数含义和失败状态可追溯；同一个 Chunk 在多个召回路径出现时能合并，不因融合丢掉内容及 metadata。

### 【阶段 6：联调、迁移发布与观测】

**T06-1 [ ] 构建测试矩阵。** 至少包含：单知识库；同模型多库；不同维度；相同维度不同模型；多个空间 + hybrid；全文模式；无权限；部分模型超时；Qdrant Collection 缺失或 Schema 不兼容；旧版工作流 JSON；文档重建、删除和迁移回滚。

**T06-2 [ ] 分层验证。** 单元测试覆盖空间分组、配置解析、查询维度和数值校验、RRF/去重、失败策略；集成测试使用实际 Qdrant 对两种维度执行写入/检索/删除；端到端分别通过单库搜索 API、编辑器测试工作流和已发布工作流接口验收。Mock 单元测试不能冒充真实 Embedding 与 Qdrant 联调。

**T06-3 [ ] 对比检索质量与开销。** 固定问题与相关证据标注，记录 Evidence Recall@K、MRR/nDCG、错误召回、答案引用来源；并比较 Query Embedding 调用次数、各模型耗时、Qdrant 检索耗时、候选池大小、端到端 P95 和失败率。数值目标应依据基线再设定，不凭空填定量收益。

**T06-4 [ ] 渐进上线与可回滚。** 先将历史默认知识库映射至旧 Collection、保持现有调用路径兼容；再灰度单库空间路由；随后开启多空间检索；最后视评测开启 Reranker。保留临时开关，并记录一个活动索引/旧索引的回滚边界。禁止通过直接删除 Collection 来“修复”不兼容向量。版本/权限状态更新后缓存应正确失效。

**阶段验收**：全部硬性测试场景通过，默认单模型使用方式未回退；历史可确认兼容的向量可查；不存在通过任意库 ID 越权读取；切换与回滚有明确操作步骤、状态与观测指标。

## 【五、跨模块验收标准与必须保持的不变量】

### 【数据与模型】

1. 一个查询**按不同 Embedding Space 数量**生成向量，不按知识库数量机械重复。
2. Query Encoder 与 Document Encoder 使用配对的模型版本及编码协议；相同维度不代表相同空间。
3. 每个 Qdrant Collection 只接受自身 Schema 所定义的向量；不截断、补零或静默切换模型以绕过校验。
4. 每个 Point 可追溯到知识库、文档、Chunk 和索引版本；文档删除、重新索引和迁移均有可定位的实际存储目标。

### 【检索与排序】

1. 向量检索必须包含**服务端授权确认后的**知识库范围过滤。
2. 各空间独立检索并返回候选；最终 TopK 在跨空间合并后统一截断。
3. 原始相似度仅在其自身空间/检索路径内有直接的比较意义；跨空间排序使用显式融合或同一 Reranker。
4. 失败既不能被静默忽略，也不能把一个空间的结果伪装成所有空间均成功；默认全量成功或明确失败。
5. 结果保持来源可追溯，`metadata`、`documentId`、`knowledgeBaseId` 等信息不能被中间层静默丢弃。

### 【兼容性与运维】

1. 老版 `KnowledgeNodeConfig` 可以继续解析；多库配置无需用户手动填维度。
2. 现有 `knowledge_chunks` 的历史数据不能被未经核实的模型版本重新解释，也不能因新建空间被清空。
3. 单库搜索、编辑器测试和应用发布执行都使用同一套空间解析/授权语义。
4. 文档删除与知识库删除必须覆盖所有仍需清理的索引版本。
5. 新功能出错时可回退到旧的单模型路径，不依赖手工破坏 Qdrant Schema。

## 【六、工作量边界、阶段依赖和完成定义】

~~~text
阶段0：清点旧数据与建立基线
  ↓
阶段1：空间身份 + 活动索引 + 权限解析
  ↓
阶段2：离线存储分流 + 删除/迁移一致性
  ↓
阶段3：单知识库查询改用空间路由
  ↓
阶段4：工作流身份传递 + 多空间并发检索
  ↓
阶段5：全局候选融合/去重/TopK + 输出兼容
  ↓
阶段6：真实联调 + 评测 + 灰度/回滚
~~~

实施时可以把**阶段1的最小数据契约、阶段2的写入路由、阶段3的单库查询路由**合并为第一批可验证改动；随后实施**阶段4与阶段5**，最后做完整迁移上线。阶段之间以验收结果为依赖，不建议一次提交覆盖全部文件而难以定位回归原因。

**推荐提交/PR 切分**：
- PR-1：数据结构、索引配置解析、历史默认索引兼容和基本测试。
- PR-2：Document Processor 与删除链路的空间化，单库 API 改造及集成测试。
- PR-3：工作流可信主体/服务注入与 MultiKnowledgeRetriever。
- PR-4：跨空间融合、输出来源追踪、完整 E2E 和迁移发布文档。

**完成定义（DoD）**：一个工作流知识节点选择 KB-A（1024 维）和 KB-C（768 维）并使用相同 Query 时，系统能在已授权条件下分别用各自模型生成查询向量、路由到正确 Collection、获得各自候选，最终返回来源明确的统一 TopK；测试同时证明旧默认模型知识库、单库 API、文档删除和旧工作流 JSON 不受破坏。实现经过真实服务端联调前不得宣称该能力已经完成。

## 【七、延后处理与关联问题】

- 生产级任务持久化：当前上传接口 `processDocument(...).catch(...)` 是不等待完成的普通 Promise，进程中断可能导致 PENDING/PROCESSING 文档停滞。多模型重建索引会放大这一风险，阶段2需确保迁移和清理任务可重试；是否采用 BullMQ/其他任务执行器可以另行决策。
- 全文检索：现有 `textSearch()` 仅取前 1000 个符合过滤条件的 Point 后做字符串匹配，不能覆盖大规模内容。多空间方案不应把这一实现误写成完整 BM25；可作为独立的检索质量迭代。
- 相似度阈值：目前用户可统一配置一个 `threshold`，但不同模型分数分布不同。基础改造应明确它适用的检索路径；跨空间可选择先只执行各空间受控阈值再全局排名，并通过评测决定是否升级为按空间校准阈值。
- Qdrant Named Vectors：保留为未来单 Chunk 多模型表示的选型；本次按空间划分 Collection，不同时实施两套存储架构。

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

