# RAG 检索能力评测与证据标注源码学习记录

## 【文档定位与知识链路】


本篇是《[RAG 知识库构建与向量检索源码学习记录](./RAG知识库构建与向量检索源码学习记录.md)》后续的**项目分析与面试讨论记录**，以已经掌握的文档切分、Embedding、Qdrant 向量存储、HNSW 与 Top-K 为基础，研究如何为 RAG 检索建立可验证的质量基线。按照知识点自身的需要保留完整原理、公式推导、具体示例、真实项目链路、验收和面试回答，**不强制每个知识点使用相同排版**。历史单题讨论被重组为连续的知识链路，完整保留已讨论的问题与回答；尚未讨论的方向仍不预先编造标准答案。

原理和方法应脱离项目独立成立；**妙码 AI Flow** 的业务上下文、源码与实现现状仅在相应节点作实战验证。源码的存在只能证明该功能已实现，不能自动证明检索指标达标。涉及项目的未实现部分明确标为**建议方案**，未执行的数值例子明确标为**教学示例**，不虚构实验数据。

与通用知识体系的关系：

- [RAG 与知识库工程完整知识体系](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/R-RAG与知识库工程完整知识体系.md)：离线知识供给、在线检索生成、评测反馈和横切治理的完整主线。
- [向量知识表示、存储与索引完整链路](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/X-向量知识表示存储与索引完整链路.md)：Chunking、Embedding、向量距离、HNSW、Payload Filter 和 Segment 聚合的通用机制。
- 本篇已沿着**正确证据与 Ground Truth → 检索索引 → 在线召回和权限过滤 → RRF/Rerank → Context Construction → Evidence Verifier 与受控补检 → 质量归因**展开完整讨论。最终生成答案的 Faithfulness、Answer Correctness 和 Citation Accuracy 仍保留为下一轮研究方向；不将建议设计或尚未完成的评测冒充已落地功能。

## 【一、RAG 检索的目标与评价基础】

**通用机制衔接：** [Ground Truth、Qrels 与检索排序评测](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/R-RAG检索目标GroundTruth与排序评测完整知识体系.md) 逐步推导相应算法、数据结构、执行过程与验证边界；本章节继续保留 AI Flow 的全部具体源码、数据案例、工程问题和方案，不以通用正文替代项目分析。

先明确“找到正确证据”到底意味着什么，再构建可审核的 Ground Truth，最后学习 Hit、Recall、Precision、MRR 与 nDCG 如何分别衡量候选覆盖和排序质量。

### 【1.1 检索能力、证据相关性与正确证据】

*原讨论问题：如何定义 RAG 检索能力，并判断知识库是否真正找到了正确证据*


#### 【提问与知识目标】

我们已掌握的一条典型向量检索链路是：

~~~text
用户问题 Query（例如：年假需要提前多久）
      ↓
Embedding：得到查询向量
      ↓
Vector Search：按距离度量、向量索引和授权后的过滤条件搜索
      ↓
Top-K：返回最多 K 条排序后的 Chunk 候选
~~~

这条链路回答“怎样找到**向量距离近**的内容”，但并未直接回答“是否找到了**能够正确回答问题**的证据”。因此本题建立三个基本判断：

1. **检索结果的相关性**不能简单等同向量相似度高。
2. **Ground Truth（参考真值）**应标注问题真正需要的证据，并明确标注粒度和版本。
3. **ANN Recall** 与 **Evidence Recall** 衡量不同层次，才能据此判断应优化索引、Embedding 还是知识源/切分。

本题只为**现有向量检索**建立可重复评测的最小基础，不要求先完成 BM25、Hybrid Search、Rerank 或完整 RAG 自动评测平台。

#### 【知识概述：检索能力应同时考虑相关性、覆盖性、有效性和效率】

定义：RAG 检索能力是系统在给定的知识范围、用户问题、身份和资源约束下，能否找到足以支持回答的有效证据，并以可接受的查询开销返回。

- **相关性（Relevance）**：返回片段能否满足 Query 的信息需求。“年假申请入口”与“年假提前多久”同属年假主题，但前者不能解答后者。
- **覆盖性（Coverage）**：是否找齐问题所有必要事实。例如“提前多久、由谁审批”至少包含两个答案槽位，找到其中一个不代表完整成功。
- **有效性（Validity）**：文档版本/生效时间是否适用、来源是否可追溯、是否在调用者获授权范围。无权访问的数据即使相似度最高也不能当作有效证据。
- **效率（Efficiency）**：在检索时延、内存、向量库负载和后续上下文成本约束内提供上述能力。

以上是**工程化能力维度**，不是四个可以随意加权抵消的单一评分。权限通常属于硬约束；不能用更高相关性得分来容忍越权返回。

教学示例：假定用户问“员工年假申请需要提前多久？”：

| Chunk ID | 片段内容 | 向量相似度（假设） | 能否回答 |
|---|---|---:|---|
| A | 年假通过内部系统提交 | 0.94 | 否：仅描述入口 |
| B | 年假由直属主管审批 | 0.91 | 否：仅描述审批 |
| C | 年假必须提前三个工作日申请 | 0.86 | 是：包含申请时限 |

若 `TopK=2`，系统返回 A/B，可能完全符合向量距离排序，但没有包含 C。**向量检索在当前索引距离定义下排序正确，不等于业务证据召回成功。**这组分数为解释机制而假设，不是模型真实运行结果。

#### 【Ground Truth、Qrels 与评测集的输入输出】

Ground Truth 是评测所使用的参考真值；用于检索相关性评价时，通常存成**问题与证据项之间的相关性标注（Qrels，Query Relevance Judgments）**。标签可为二元的相关/不相关，也可使用 0、1、2 等分级相关性。NIST TREC 明确把相关性标注视为检索评测集合的重要组成部分，Qdrant 的检索相关性指南也采用查询与预期相关文档配对的标注集合。参见文末资料 [1][2]。

对于一份简化员工休假知识库，先假设四条 Chunk：

| ID | 内容 |
|---|---|
| C1 | 员工年假必须提前三个工作日申请 |
| C2 | 年假申请由直属主管审批 |
| C3 | 员工使用内部系统提交年假申请 |
| C4 | 员工病假需提供医疗证明 |

两个问题可形成以下标注（**示例数据结构，不是当前项目已存在的评测记录**）：

~~~json
[
  {
    "queryId": "q1",
    "query": "年假需要提前多久？",
    "relevantChunkIds": ["C1"]
  },
  {
    "queryId": "q2",
    "query": "年假需要提前多久申请，由谁审批？",
    "relevantChunkIds": ["C1", "C2"]
  }
]
~~~

- q1 是单一事实检索，只要完整命中 C1 就可能支持回答。
- q2 是多个事实组成的查询：找到 C1 而遗漏 C2，代表**部分覆盖**。不能只用“至少一条命中”宣布完全成功。
- 这组标注不暗示它列出了语料库中所有可能的相关片段。真实知识库可能有重复、摘要、父章节或其他等价证据；需要标注审查、去重与“可替代的证据集合”策略。

**输入与输出边界：**原始 Query 与人工标注形成 Qrels；检索系统执行后产生 Run（每个 Query 的排序结果和得分）；评测器基于同一个身份/版本/语料快照对 Qrels 与 Run 作比较，并输出指标及逐题失效记录。

~~~text
固定知识库快照 + 标注过的 Query/Qrels
                 │
                 ▼
    当前检索系统 Query → 候选 Chunk ID 排序（Run）
                 │
                 ▼
      对齐 ID、版本、授权范围与标注粒度
                 │
                 ▼
        命中/覆盖/排序指标与失败案例
~~~

关键不变量：**评测语料、标注 ID、查询身份/权限、知识库版本与实际检索环境必须匹配**。不能在标注依据是 v1 文档时，对随时更新的 v3 文档直接比较相同的 Chunk ID 得分。NIST TREC 也强调检索语料与 Qrels 的一致性，参见 [1]。

#### 【Hit、Recall 与证据完整性如何区分】

仍以 q2 为例：

~~~text
Ground Truth：{C1, C2}
检索 Top-3： [C1, C3, C4]
~~~

以二元相关性、正确证据 ID 不重复计算为前提：

- **Hit@3**：前 3 条是否至少包含 1 条相关证据；命中 C1，Hit@3=1。
- **Evidence Recall@3**：正确证据总共有 2 条，检索命中 1 条，因此 Recall@3=1/2=0.5。
- **证据完整性**：需要的事实“时限+审批人”是否均得到支持；缺少 C2，因此**尚不足以完整回答 q2**。

对于只有一条正确证据的查询，Hit@K 和 Recall@K 可能在数值上相同；对于多证据查询，二者差别通常更重要。

但“召回了全部预先标注的 Chunk ID”不是所有情形下的事实完整性充分条件：

- 若一条较大的父章节同时涵盖 C1/C2，系统返回父章节可能足以支持完整答案，但 Chunk-ID 召回因粒度不同而被低估；
- 若一个 Chunk 内有相似词汇却缺少约束条件，它即使标注为同主题，也可能不足以成为回答证据；
- 当文档切分参数变化，Chunk ID、Offset 与文本边界可能变化，需建立文档版本/原文位置/原子事实与检索片段之间的映射，或重新审核标签。

**Document 粒度与 Chunk 粒度需要区分：**如果返回的是“员工休假制度”中的病假片段，而问题问年假时限，Document-level 命中可能为真，但 Chunk-level 相关性应为假。应该根据实际下游消费的是文件、段落还是证据集合，明确评价单位。

#### 【项目实践：妙码 AI Flow 目前已经具备哪些基础数据】

业务上下文：系统从文档处理模块得到 Chunk 和对应 Embedding，写入 Qdrant 中的 `knowledge_chunks` Collection；用户问题在线生成 Query Vector 后，经 Retriever/VectorStore 搜索得到 Chunk 候选，交给后续工作流。此处关注**向量存储搜索接口返回的可验证证据 ID**，不假定应用已接入完整评测模块。

需要核对的源码：

- [知识库类型与配置：`types.ts`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/types.ts)
- [Qdrant 搜索实现：`qdrant-store.ts`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)
- [文档切分、Embedding 与写库：`document-processor.ts`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts)

`VectorSearchOptions` 规定 `vector`（Query 向量）、`knowledgeBaseIds`（检索范围）、`topK`（返回数量上限）、可选 `threshold`（相似度阈值）；`VectorSearchResult` 保留 `chunkId`、`documentId`、`content`、`knowledgeBaseId`、`score` 等字段。

核心数据库调用：

~~~typescript
const response = await this.client.search(this.collectionName, {
  vector,
  limit: topK,
  score_threshold: threshold,
  filter: {
    must: [
      {
        key: 'knowledgeBaseId',
        match: { any: knowledgeBaseIds },
      },
    ],
  },
  with_payload: true,
  with_vector: false,
})
~~~

**上游来源**：`vector` 是查询文本经过 Embedding 得到的向量；`knowledgeBaseIds` 应由业务可信授权范围决定，而不仅仅由用户自行提交。**本段执行**：Qdrant 在所选 Collection 范围内按知识库字段过滤，计算近邻，返回最多 `topK` 条达到阈值的 Point。**下游结果**：映射为包含 Chunk/Document ID、正文与分数的 `VectorSearchResult[]`，可以作为评测器的 Run 输入。

源码事实与边界：
1. 现有 `search()` 返回的 `chunkId`/`documentId` 可以用于对齐人工标签，`score` 保留检索排序分数。
2. 源码包含检索、范围过滤和 Top-K，但**尚不能仅据此认定已实现 Ground Truth 数据集、自动化指标评测或达到某个实际 Recall 数值**。
3. 评测时应固定合法授权范围；`knowledgeBaseIds` 作为搜索条件不等于接口独立完成了身份认证。
4. 如更换 Chunking 或重新入库，`document-processor.ts` 使用 `documentId + index` 构造 Chunk ID；索引位置可能变化，必须重新对齐标注，不能把跨版本 ID 相同当成同一事实。
5. Qdrant 返回的 `score` 是向量相关性信号，**不是标注的业务相关性分数**。

#### 【最小评测方法：先用现有 VectorStore 建立基线】

**建议方案（未实施）**：先独立保存测试案例，不改动业务检索逻辑；以可复现的固定文档/模型/索引版本运行，记录每次搜索的实际 Chunk 排名。最小测试用例可以采用：

~~~typescript
type RetrievalCase = {
  queryId: string
  query: string
  knowledgeBaseIds: string[] // 必须经过可信授权
  expectedEvidenceIds: string[] // 与当前语料版本对应
  expectedDocumentVersion: string
  queryType: "single-fact" | "multi-fact" | "exact-code" | "unanswerable"
}

// 教学案例，非项目真实 ID：
const testCase: RetrievalCase = {
  queryId: "q1",
  query: "年假需要提前多久？",
  knowledgeBaseIds: ["kb-1"],
  expectedEvidenceIds: ["chunk-001"],
  expectedDocumentVersion: "v1",
  queryType: "single-fact",
}
~~~

执行顺序：

1. 固定知识库及文档版本，确保标注 ID 仍对应正确正文，加载人工审查的 Qrels；
2. 使用与入库兼容的 Embedding 模型编码 Query；
3. 调用当前 `QdrantVectorStore.search()`，指定固定的 `topK`、`threshold` 和合法 `knowledgeBaseIds`；
4. 从返回结果提取排名、Chunk ID、Document ID、得分，产生每题的 Run；
5. 按同一评测粒度与 Ground Truth 比较，记录命中/覆盖和漏检原因；
6. 用固定样本、版本、权限和指标对照不同配置，避免把数据变动误判为参数收益。

教学运行示例：

~~~text
Ground Truth for q1: {chunk-001}

VectorStore.search() 返回：
排名 1  chunk-003
排名 2  chunk-002
排名 3  chunk-001

Hit@2 = 0；Evidence Recall@2 = 0
Hit@3 = 1；Evidence Recall@3 = 1
~~~

这证明同一有序候选在不同 K 下会得到不同结果，**不是实际项目跑出的测试数据**。

#### 【诊断边界：精确向量近邻与业务参考证据不应混为一谈】

当正确证据没有进入 Top-K，应按输入→处理→输出顺序追查：

| 检查问题 | 若发现异常 | 优先研究的层 |
|---|---|---|
| 文档是否已经完整入库？ | 正确原文不存在、更新失败或旧版本残留 | 数据接入与版本生命周期 |
| Chunk 是否保留完整条件？ | 原始事实被错误切开、Metadata 丢失 | 文档解析、Chunking、上下文保真 |
| 精确向量检索能否找出对应 Chunk？ | Exact kNN 的前 K 也不包含正确证据 | Embedding、Query 表示、混合检索 |
| ANN 与精确向量结果差多少？ | Exact Top-K 包含目标、ANN Top-K 不包含 | HNSW、`hnsw_ef`、过滤执行/近似误差 |
| 候选已包含正确证据但最终答案不正确？ | 排序或上下文、生成阶段未使用证据 | Rerank、上下文构建、生成与引用 |

**ANN Recall@K** 的参考集合是 Exact kNN 的 Top-K（同一向量空间、同一过滤条件、同一语料快照），评估近似索引是否遗漏几何近邻。

**Evidence Recall@K** 的参考集合是业务标注的正确证据，评估结果是否有助于回答实际问题。

假设 HNSW 与 Exact kNN 完全一致，但它们都优先返回“年假申请入口”和“年假审批人”，漏掉“提前三个工作日”。ANN Recall@K 可能是 100%，Evidence Recall@K 却仍然不足。此时不能靠继续调 `hnsw_ef` 从根本上修复业务语义表示问题。Qdrant 将这两类评测明确分层，参见资料 [2][3]。

#### 【实践边界与下一步验收】

目前可以完成**独立的基础检索相关性评测**，但尚不能用它直接断言完整 RAG 系统的答案忠实度、业务成功率或生成质量。那些能力要求额外捕获模型实际收到的上下文和最终输出。

评测集的基本质量门禁应包括：真实且多样的查询、准确的参考证据、标注粒度一致、源文档版本可追溯、用户权限匹配。对于未标注的候选，**“没有列在 Qrels 中”不必然等于人工确认不相关**：真实大语料很难穷举全部相关文档，应通过多路检索结果池化、人工复核与补标逐步提高 Ground Truth 覆盖。对精确编号、多证据、否定、过期文件、无答案查询应单独查看失败案例，避免平均分掩盖问题。

#### 【面试标准回答】

RAG 检索评测首先要明确评价的不是向量距离本身，而是用户问题与所需证据之间的相关性。应先构建 Query—Evidence 的 Ground Truth/Qrels，声明评价粒度是 Document、Chunk 还是原子事实及证据集合，再在固定知识库版本、权限范围和检索配置下执行查询，形成有序结果 Run。

在单事实和多事实问题上，至少区分“是否命中任意正确证据”与“正确证据是否完整覆盖”；例如两条证据只召回一条时 Hit@K=1，Evidence Recall@K=0.5，但不一定能够回答全部问题。文档级命中不必然表示 Chunk 级命中，Chunk 更新还可能引起标注 ID 漂移。

最后要分开 ANN Recall 与业务 Evidence Recall：前者以精确向量 Top-K 为基准，衡量近似索引误差；后者以人工证据标注为基准，判断检索是否真正满足业务问题。这样才能确定问题出在知识源、切分、语义表示、索引近似、排序还是下游证据使用，而不是盲目增大 Top-K 或修改 HNSW 参数。

#### 【本轮权威依据与项目源码】

1. NIST TREC：[Relevance Judgments](https://trec.nist.gov/data/reljudge_eng.html)。相关性标注与检索语料/问题的匹配原则。
2. Qdrant：[Measuring Retrieval Relevance](https://qdrant.tech/documentation/search-evaluation/retrieval-relevance/)。Gold Query Set、Qrels/Run、文档/片段标注与检索相关性评价。
3. Qdrant：[Measuring ANN Recall](https://qdrant.tech/documentation/tutorials-search-engineering/ann-recall/)。Approximate 与 Exact kNN 的区别。
4. NIST TREC：[How to TREC](https://trec.nist.gov/howto.html)。Qrels 和检索评测术语。
5. 项目源码：[VectorStore 搜索实现](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)、[知识库类型定义](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/types.ts)、[文档入库处理](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts)。

---

### 【1.2 Ground Truth、Qrels 与必要事实标注】

*原讨论问题：如何构建可靠的 RAG Ground Truth 评测数据集*


#### 【提问与知识目标】

前两题建立了评价对象（Query、Ground Truth/Qrels、Run）和 Hit@K、Evidence Recall@K、Precision@K、MRR、nDCG 等指标。**指标计算依赖一个前提：我们能够可靠地区分哪条知识是正确证据，且测试问题足以代表系统应处理的实际需求。**

本题讨论如何从真实查询、人工标注与 LLM 合成数据构造可复用的检索评测集，重点研究证据标注完整性、测试场景覆盖、语料版本、偏差与可复现性。评测数据集不是代码里的几条 `query→expectedChunkId` 测试常量，而是能长期衡量检索方案是否变好的**标准化实验资产**。

#### 【知识概述：Query 的来源不等于 Ground Truth 的正确性】

Ground Truth（参考真值）由两类信息构成：

1. **测试输入 Query**：用户想解决什么问题，使用什么表达，在什么业务范围及权限下查询。
2. **参考证据标注 Qrels**：哪些文档、Chunk 或原子事实可以支持该问题的哪些答案要求，相关程度、有效版本以及允许的替代证据是什么。

对于问答任务，还可以维护参考答案或必须覆盖的事实列表，但它们与检索 Qrels 不是同一种对象。最终答案的正确性，不应该直接当作检索结果 ID 的相关性标签。

设文档包含：

~~~text
C1：员工申请年假需要提前三个工作日。
C2：年假申请需要直属主管审批。
C3：员工申请病假需要提供医疗证明。
~~~

基于 C1 让 LLM 自动生成：

~~~json
{
  "query": "员工申请年假需要提前几个工作日？",
  "relevantChunkIds": ["C1"]
}
~~~

这可以成为**待审核样本**，但不能因为 LLM 由 C1 生成了问题，就宣布 C1 是唯一正确证据。若其他 FAQ 同样完整说明时限，直接只标 C1 会把合理的替代证据误判为错误；若生成的问题过于接近原文，又会让语义召回任务异常简单。

Qdrant 官方指出，LLM 生成的查询通常比真实用户查询更容易被检索，可能抬高离线指标；点击日志也存在位置偏差，不能把点击直接等同人工验证的相关性。见 [1]。**因此应将“样本生成”和“标签验证”分为两个不同环节。**

#### 【真实查询、人工标注与 LLM 合成各自负责什么】

| 来源 | 获得方式 | 主要贡献 | 需要控制的风险 |
|---|---|---|---|
| 真实用户 Query | 脱敏的查询日志、明确的用户反馈、历史问答 | 真实措辞、问题频率、实际意图 | 高频问题偏置、隐私、没有天然正确答案、点击位置偏差 |
| 人工设计与标注 | 产品/领域专家提出问题、查阅现行知识确认事实 | 严格的证据定义、高风险与边界问题覆盖 | 标注费用、个人理解差异、漏标 |
| LLM 合成 Query | 从审核过的源文档与事实生成不同表达和难度的询问 | 低成本扩充覆盖、压力测试复杂场景 | 问句复述原文、事实幻觉、误以来源 Chunk 是唯一答案 |

推荐的职责分工不是固定的百分比分配，而是：

- **真实查询决定主分布**：尽量代表线上会出现的实际问题；按主题/意图/难度分层抽样，避免高频简单问题淹没少量重要困难问题。
- **人工审核决定参考标准**：至少对进入正式回归集的关键事实与证据对应关系进行核验；有争议的标签应由规则和复核解决。
- **LLM 负责扩展**：生成同义表达、复杂限定条件、多证据问题、无答案和难例，但正式入库前进行事实校验。合成数据和真实数据分别报告评测结果，避免总体分数被“容易的合成问题”主导。

#### 【Ground Truth 的实际构建流程】

~~~text
确定评测范围（知识领域、版本、权限、业务目标）
    ↓
真实 Query 采样 + 专家设计问题 + LLM 辅助合成
    ↓
形成待标注 Query：去重、分类、脱敏、难度标记
    ↓
构造候选证据池 Pool
  ├─ 人工查找原始文档/章节
  ├─ 关键词和字段检索
  ├─ 向量召回
  └─ 可用的其他检索器/检索配置
    ↓
人工判定证据相关性、事实覆盖、版本/权限适用性
    ↓
生成正式 Qrels / 必要事实标注 / 参考答案（按需）
    ↓
冻结语料版本 + 标签版本 + 评测配置
    ↓
检索器生成 Run，计算指标并逐题分析
    ↓
新发现的漏标和新问题 → 复核、增补，发布新的数据集版本
~~~

**为什么要使用 Pool（候选池）？**如果只运行当前向量检索器，把返回的 Top-K 人工标成相关/不相关，那么它本来检索不到的正确文档永远不进入标注范围。当我们引入 Hybrid Search 后，它找到了另一条真正正确的证据，却可能因旧 Qrels 漏标而被误判。TREC 检索评测使用 Pooling，NIST 也分析过不完整 Pool 可能对未参与建池的新系统产生偏差。见 [2][3]。

**Pooling 不是穷尽所有正确证据的数学保证。**应保留“未审核/未知”状态，必要时追加新检索方法和人工调查扩大候选池；对新系统反复发现的“未知但有用”结果做盲审和补标。不能把“不在标签表里”直接当成“人工确认无关”。

#### 【人工标注的粒度：从 Chunk ID 扩展到必要事实】

仍用问题：“年假需要提前多久申请、由谁审批？”

仅存：

~~~json
{
  "query": "年假需要提前多久申请、由谁审批？",
  "relevantChunkIds": ["C1", "C2"]
}
~~~

可以计算 Chunk-ID 的 Recall，但无法直接知道返回的一条新父章节是否已经同时覆盖两个事实，亦难以跨 Chunking 方案长期复用。因此建议让评测数据保留**事实与证据两种关联**：

~~~json
{
  "queryId": "leave-q-001",
  "query": "年假需要提前多久申请、由谁审批？",
  "queryType": "multi-fact",
  "answerable": true,
  "requiredFacts": [
    {
      "factId": "F1",
      "description": "提前三个工作日申请",
      "supportingChunkIds": ["C1"]
    },
    {
      "factId": "F2",
      "description": "由直属主管审批",
      "supportingChunkIds": ["C2"]
    }
  ],
  "corpusVersion": "policy-v2",
  "annotationStatus": "verified"
}
~~~

以上是**教学示例的数据结构**，不是妙码 AI Flow 现成的评测记录，也不是所有 RAG 场景必须采用的统一 Schema。

需要解释的数据关系：

1. `queryId` 是稳定的问题身份，可跨不同检索 Run 比较。
2. `requiredFacts` 表示回答问题需要的独立证据要求；一个 Chunk 可能支持多个 Fact，同一 Fact 也可能被多个 Chunk 支持。
3. `supportingChunkIds` 记录当前语料版本下可核实的证据映射；如果文档切分或重建，映射可能需要重算/审核。
4. `answerable` 标记**在当前授权和语料快照内**是否存在足够证据，不应把“知识库外现实中有答案”误判为“系统有权且有能力回答”。
5. `annotationStatus` 区分刚生成的候选、等待复核、有争议和验证通过，不允许未经审核的样本悄悄进入正式基准。

**Qrels 与必要事实覆盖应分别实现：**普通 Chunk-level 指标可以使用 Qrels；多事实任务可以单独计算“最终候选或 Context 支持了多少 requiredFacts”。只有全部必要事实被证据支持，才可能判断信息覆盖完整；仍不代表最终 LLM 答案必然正确。

#### 【怎样设计具有代表性的 Query 覆盖】

**数量多不代表覆盖好。**如果一千条 Query 大多是“某某制度是什么”，评测分数很高也无法证明系统理解编号、例外条款或多文档问题。

可以按照业务风险和用户真实分布设计几个必要切面：

| 查询类别 | 示例 | 主要暴露的检索困难 |
|---|---|---|
| 单事实 | 年假需要提前多久？ | 基础语义召回 |
| 同义/口语 | 下周请年假，什么时候开始报？ | Query 表述与知识措辞差异 |
| 精确编号 | E-1042 故障如何处理？ | 标识符精确匹配 |
| 多事实 | 年假时限和审批人分别是什么？ | 必要证据覆盖 |
| 跨文档 | 年假制度与审批流程如何衔接？ | 多来源召回与关联 |
| 约束与例外 | 入职半年是否适用年假政策？ | 条件、例外及否定 |
| 时间/版本 | 新政策的申请期限有何变化？ | 生效版本与时效性 |
| 无答案 | 资料里是否说明无限期带薪休假？ | 无证据识别与不当召回 |

Ragas 官方提供通过知识结构/关系生成单跳（Single-hop）与多跳（Multi-hop）、具体（Specific）与抽象（Abstract）等查询场景的方法；它们可以帮助生成测试覆盖，但不意味着所有真实业务场景都必须等比例使用这些分类。见 [4]。

推荐分别维护：
- **主代表集**：分布尽量接近真实查询，用于判断业务整体趋势。
- **专项挑战集**：刻意增加低频但高风险的复杂、条件、版本、无答案问题，用于发现能力边界。
- **固定回归集**：包含历史检索失败和已修复问题，避免优化一个环节时破坏另一个环节。

三者可以相互有重合，但报告时注明来源、分组和统计口径；不能随意把挑战集占比变化解释为线上质量变化。

#### 【LLM 在数据集构建中的合理工作边界】

LLM 适合做的工作是：从已核实文档中抽取待核实的原子事实、生成不同口语和专业表达、组合多证据场景、建议可能的引用片段、去除明显重复问题。完成后仍需校验：

1. **是否可回答**：能否找到当前授权语料内的直接证据？无答案题是否确实没有充分证据？
2. **是否真实**：生成答案、日期、编号和例外规则是否完全来自文档？不能把 LLM 常识当源文档事实。
3. **是否漏标**：其他文档/父章节/同义片段是否也提供等价证据？
4. **是否具有代表性**：是否仅是原文的机械问句变形？复杂问题是否真实会发生？
5. **是否有标注分歧**：多个审核人结论不一致时，记录争议并仲裁，而非强制给定一个假确定标签。

数据状态可以分为：

~~~text
candidate（候选，尚未审核）
    ↓ 审核原文事实、版本、授权范围、证据完整性
verified（已经验证，允许进入正式评测）
    ↓ 固化语料和标签、完成发布检查
released（固定版本的正式基准）
~~~

对低风险大样本可以使用自动检查与人工抽样核验，但**正式参考真值的可信度与人工投入之间的取舍，应在评测报告中如实说明**。不能把 LLM 自行生成且自行判分称作无偏的真实人工 Ground Truth。

#### 【如何在妙码 AI Flow 当前检索架构上落地】

首先解释项目上下文。已核对的 [`VectorRetriever`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts) 负责把 Query 编码为向量、调用存储层 `search()` 并映射为带 `chunkId`/`documentId`/`content`/`score` 的结果；[`HybridRetriever`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts) 在 `vector/fulltext/hybrid` 模式间调度，双路结果经过加权 RRF 融合。[`QdrantVectorStore`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts) 支持按 `knowledgeBaseIds` 过滤和 `topK` 返回 Chunk 身份。

**可以证明项目已有检索入口，不能直接推断项目已有标注 Qrels、持久化评测集、人工复核界面或线上 Retrieval Benchmark。**下述为建议的最小独立评测结构：

~~~text
固定语料快照（文档/Chunk/Embedding/索引和权限范围）
                        ↓
evaluation-dataset.json
  ├─ Query、QueryType、来源（真实/专家/合成）
  ├─ 正确证据 Qrels / 必要事实
  ├─ 文档、Chunk 和数据集版本
  └─ 标注状态与审核信息
                        ↓
Evaluation Runner（评测脚本）
  → 以可信的知识库范围调用 Retriever.retrieve()
  → 保存每个 Query 的有序结果 Run
  → 与 Qrels 计算 Recall/MRR/nDCG
  → 分组分析：类型、来源、难度、权限、版本
  → 记录漏检案例供补标与检索优化
~~~

一个可供后续实现的测试用例类型草案：

~~~typescript
type EvaluationCase = {
  queryId: string
  query: string
  queryType: "single-fact" | "multi-fact" | "exact-code" | "condition" | "unanswerable"
  source: "production" | "expert" | "synthetic"
  corpusVersion: string
  annotationStatus: "candidate" | "verified"
  knowledgeBaseIds: string[] // 应由可信测试权限映射，不允许越权
  relevantChunkIds: string[] // 对应此 corpusVersion；需避免漏标
  requiredFacts?: Array<{
    factId: string
    description: string
    supportingChunkIds: string[]
  }>
}
~~~

在没有验证之前，这是**设计建议**而非项目已经上线的数据结构。实验时固定相同语料/权限/Embedding/检索深度，对比 `vector` 和真实启用全文 Provider 的 `hybrid` Run；不能因源码存在 Hybrid 模式，就假定运行时始终成功调用了两条检索通道。

#### 【评测数据集与检索系统的版本应如何关联】

最低限度记录：

| 对象 | 为什么需要固定 |
|---|---|
| `datasetVersion` 与标注规则 | 避免不同版本的 Qrels 被当成同一评分标准 |
| `corpusVersion`、Document ID/版本 | 防止文档修改、删除后“旧答案”成为假真值 |
| Chunking 参数、Chunk ID 与原文位置 | 切分方案改变时可定位和重标 |
| Embedding 模型及版本 | 向量空间变化可能影响近邻排序 |
| 检索模式、过滤权限、`topK`/`threshold` | 保证不同方案在可比条件下运行 |
| 指标定义、评测工具版本 | 保证计算口径一致，可复算 |

当底层 Chunking 改变时，应保留一份可对齐到源文档和事实的评测定义，必要时映射新 Chunk 并复审；不应强行沿用已经失效的 Chunk ID。测试集标签升级时，应说明历史指标是否需要按新版本重算。

#### 【实践边界与质量检查】

- **标签完整性**：未被 Pool 覆盖的结果状态是未知，不能默认为“不相关”；对新检索器发现的合理结果追加审核。
- **用户反馈偏差**：点击受名次、展示方式影响；点击率不是天然 Qrels。
- **无答案问题**：对于无可用证据的 Query，不直接套用分母为 0 的普通 Recall；单独测“是否错误地自信返回”和后续拒答能力。
- **权限与隐私**：生产查询需脱敏、限制评测数据访问，遵守来源数据授权；测试不能无权限检索敏感知识以提高 Recall。
- **统计可靠性**：除整体平均，至少按 Query 类型和来源分组；对于微小差异，在样本不足、标签不全时不应轻率宣布新方案优越。
- **避免只考自己擅长的题**：生成测试问题与被评估的模型/检索器高度同源时，需保留独立验证集和真实查询集，避免评测偏乐观。

#### 【面试标准回答】

RAG 检索评测的 Ground Truth 是经过验证的 Query—Evidence 相关性标注，而不是模型自动生成的参考答案或初始检索器的 Top-K。数据集应结合真实用户查询、人工设计/审核和 LLM 合成数据：真实查询提供实际分布，人工审核保证事实与证据关系可信，LLM 用于扩充同义表达、复杂问题和边界场景。

构建时先确定任务和知识库快照，收集并分类 Query，再通过人工查找、多路检索 Pooling 收集候选证据，审核相关性、必要事实、文档生效版本与权限，形成 Qrels。对多事实问题还应保留原子事实及可替代的支持证据，避免只靠 Chunk ID 命中判断答案完整性。

评测集按语料/标注/检索配置版本管理，使用同一套已审核样本比较不同检索方案，分别统计真实查询与合成查询、普通与挑战用例。对于未标注但可能正确的结果要复核补标，而不能默认错误。这样构建的 Ground Truth 才能作为后续 Chunking、Embedding、Hybrid Search、Rerank 等技术改进的稳定对照基线。

#### 【权威资料与源码】

1. [Qdrant：Measuring Retrieval Relevance](https://qdrant.tech/documentation/search-evaluation/retrieval-relevance/)：真实用户日志、人工标注、LLM 合成及评测数据质量风险。
2. [NIST TREC：Relevance Judgments](https://trec.nist.gov/data/reljudge_eng.html)：Pooling、语料与 Qrels 匹配。
3. [NIST：A Comparison of Pooled and Sampled Relevance Judgments](https://www.nist.gov/publications/comparison-pooled-and-sampled-relevance-judgments)：Pool 不完整导致的评测偏差。
4. [Ragas：Testset Generation for RAG](https://docs.ragas.io/en/latest/getstarted/rag_testset_generation/)；[RAG Test Data Generation](https://github.com/vibrantlabsai/ragas/blob/main/docs/concepts/test_data_generation/rag.md)：从知识结构生成 Single-Hop/Multi-Hop、具体/抽象测试场景。
5. [妙码 AI Flow：VectorRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts)、[HybridRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)、[QdrantVectorStore](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)。

---

### 【1.3 检索质量指标与完整计算】

*原讨论问题：Recall@K、Precision@K、Hit@K、MRR 与 nDCG 分别衡量什么*


#### 【提问与知识目标】

上一题已经建立：给定查询 Query、人工标注的正确证据集合 Ground Truth/Qrels，以及按得分排序的检索结果 Run，可以判断系统是否检索到了有效证据。本题进一步讨论：为什么不能只用一个分数衡量所有检索能力，**候选覆盖、无关噪声与排序先后**应分别用什么指标观察？

统一教学场景：员工提问“年假需要提前多久申请、由谁审批？”；假设资料已经审核，正确证据分别为 C1（提前三个工作日申请）和 C2（由直属主管审批）。某检索器的有序结果为：

| 名次 | Chunk ID | 内容（简写） | 二元相关性 |
|---:|---|---|---:|
| 1 | C3 | 年假申请入口 | 0 |
| 2 | C1 | 年假申请时限 | 1 |
| 3 | C4 | 病假医疗证明 | 0 |
| 4 | C2 | 年假审批人 | 1 |
| 5 | C5 | 考勤打卡规则 | 0 |

~~~text
Ground Truth（正确证据）：{C1, C2}
Run（实际排序）：[C3, C1, C4, C2, C5]
~~~

以下计算全部基于这组**教学数据**，不是项目运行结果；在没有其他相关证据且标注完备的假设下，Ground Truth 的正确证据数是 2。现实中还应考虑未标注但同样正确的替代证据。

#### 【知识概述：五种指标在回答不同问题】

| 指标 | 实际判断 | 适用重点 | 无法单独证明什么 |
|---|---|---|---|
| Hit@K | 前 K 条有没有至少一条正确结果 | FAQ、单答案/至少一次命中 | 多证据问题是否找齐 |
| Recall@K | 全部正确证据中找到了多少 | 候选召回阶段，避免漏证据 | 排序是否靠前、噪声多少 |
| Precision@K | 返回的前 K 条有多少是相关的 | 候选噪声/有限上下文利用 | 有没有找齐语料中的所有证据 |
| RR / MRR | 第一条正确证据的位置是否靠前 | 单答案、用户优先使用首条 | 第二、第三条必要证据在哪里 |
| nDCG@K | 重要证据是否排在前面、整体排序是否接近理想 | 重排、融合、分级相关性 | 数据未入库或事实是否正确 |

**K 是同一运行结果的前缀截断深度，不是 HNSW 的 `hnsw_ef` 或 Embedding 维度**。初始检索可能返回 50 条候选，而最终送入 LLM 的只有 5 条，因此两阶段应分别评价 `Recall@50` 和 `Context 证据覆盖@5`，不能用前者代替后者。

#### 【Hit@K：前 K 条有没有任何一条正确证据】

对单个 Query：

~~~text
Hit@K(q) = 1，前 K 条至少出现一条相关证据
Hit@K(q) = 0，否则
~~~

示例：Top-1 只有无关的 C3，故 `Hit@1=0`；Top-2 有 C1，`Hit@2=1`；Top-3 与 Top-5 依然为 1。

如果存在 100 个 Query，其中 80 个 Query 的 Top-5 至少包含一条相关证据，则 `Hit Rate@5=80/100=80%`。它直观但不能表示多证据问题找得够不够完整：对当前场景 `Hit@2=1`，尽管 C2 完全没出现。

#### 【Recall@K：标注的全部正确证据被覆盖多少】

对单个 Query，在二元标注、按唯一证据 ID 计算的条件下：

~~~text
Evidence Recall@K(q)
 = |TopK(q) ∩ Relevant(q)| / |Relevant(q)|
~~~

示例结果：

| K | 前 K 条的相关证据数 | Ground Truth 总数 | Recall@K |
|---:|---:|---:|---:|
| 1 | 0 | 2 | 0% |
| 2 | 1 | 2 | 50% |
| 3 | 1 | 2 | 50% |
| 4 | 2 | 2 | 100% |
| 5 | 2 | 2 | 100% |

这说明检索深度为 3 时，只覆盖了“申请时限”，未覆盖“审批人”，不能完整回答问题。

**为何第一阶段应重视 Recall？**检索器没有返回的证据，后续仅作用于已有候选的 Reranker 无法恢复。提高 Top-K 可能改善覆盖，但也会增加候选噪声与计算成本，不能只凭更高 K 声称质量更好。

**边界**：若查询没有任何相关证据，分母为零，普通 Recall 公式不适用，应把无答案识别、拒答和误召回作为独立评测目标；若存在很多等价证据，必须先规定文档/Chunk/事实的去重与标签口径。

#### 【Precision@K：前 K 条中有多少条真正相关】

~~~text
Precision@K(q)
 = |TopK(q) ∩ Relevant(q)| / K
~~~

示例：

- `Precision@2 = 1/2 = 50%`。
- `Precision@3 = 1/3 ≈ 33.3%`。
- `Precision@5 = 2/5 = 40%`。

Top-3 比 Top-2 额外加入了无关的病假内容，召回仍为 50%，但 Precision 反而下降。这表示候选噪声增加，而不是检索进步。

如果实际返回少于 K 条，某些评测实现仍按固定 K 作分母，另一些报告实际结果条数；必须**写清评测工具的计算口径**，否则相同 Run 也可能得出不同 Precision。

Precision 可以间接反映“塞给模型多少不相干文本”，但不直接等于最终 Prompt 的利用效率：去重、父子扩展、压缩或上下文裁剪会改变真正进入 LLM 的材料。

#### 【MRR：第一条正确结果排在第几名】

单个 Query 使用 **RR（Reciprocal Rank，倒数排名）**：

~~~text
RR(q) = 1 / rank_firstRelevant(q)

没有任何正确结果进入本次评测范围时，该查询的 RR 记为 0。
MRR = (所有 Query 的 RR 之和) / Query 总数
~~~

示例的首条正确证据 C1 在第 2 名，因此 `RR(q)=1/2=0.5`。如果另一条 Query 首条正确证据排第 1，`RR=1`；两条 Query 的 `MRR=(0.5+1)/2=0.75`。

若采用截断 `MRR@K`，只有 Top-K 内出现的首条正确结果才贡献分数；当前示例 `RR@1=0`、`RR@2=0.5`。单个 Query 的结果应称 RR，不要把一个查询的 0.5 错称“MRR=0.5”。

**适用边界**：MRR 适合用户只需要一条答案或只看第一条搜索结果的场景；但对于“申请时限+审批人”这样必须找齐两条事实的问题，MRR 在找到 C1 后不再关注 C2，所以不应单独作为能力目标。

#### 【nDCG@K：同时考虑相关性等级与结果位置】

nDCG（Normalized Discounted Cumulative Gain）先给每条候选标注相关性等级，再对后面名次施加折损。常见、但非唯一的增益定义：

~~~text
DCG@K = Σ[ (2^rel_i - 1) / log2(i+1) ]，i 从 1 到 K
IDCG@K = 相同相关性标签在理想排序下的 DCG@K
nDCG@K = DCG@K / IDCG@K
~~~

假设人工把 C1 标为“高度相关”（`rel=2`）、C2 标为“相关”（`rel=1`），其余为无关（`rel=0`）。当前排序 `[C3, C1, C4, C2, C5]` 的实际增益为：

| 排名 | Chunk | rel | 增益/折损贡献 |
|---:|---|---:|---:|
| 1 | C3 | 0 | 0 |
| 2 | C1 | 2 | `3/log2(3) ≈ 1.893` |
| 3 | C4 | 0 | 0 |
| 4 | C2 | 1 | `1/log2(5) ≈ 0.431` |
| 5 | C5 | 0 | 0 |

~~~text
DCG@5 ≈ 1.893 + 0.431 = 2.323
理想排序：C1（第一名）、C2（第二名）
IDCG@5 = 3 + 1/log2(3) ≈ 3.631
nDCG@5 ≈ 2.323 / 3.631 ≈ 0.640
~~~

这个数衡量当前排序与**该标注方案下的理想排序**有多接近，适合比较融合和 Rerank。若改变相关性等级、增益函数或候选集合，数值会变化；标注标准与公式必须固定，不能跨评测口径直接比较。

#### 【同一组数据从 Top-1 到 Top-5，指标如何变化】

| 指标 | @1 | @2 | @3 | @5 |
|---|---:|---:|---:|---:|
| Hit@K | 0 | 1 | 1 | 1 |
| Evidence Recall@K | 0% | 50% | 50% | 100% |
| Precision@K | 0% | 50% | 33.3% | 40% |
| RR@K（单条 Query） | 0 | 0.5 | 0.5 | 0.5 |
| nDCG@K（上述分级标签） | 0 | 0.521 | 0.521 | 0.640 |

这里 `nDCG@2≈(3/log2(3))/3.631≈0.521`，因为理想排序前两名本应分别为 C1、C2。**Recall 随 K 增大不下降**（固定结果和标签时），但 Precision 并不单调；因此不能只看其中一个指标判断某个 Top-K 配置更优。

#### 【工程实践：在什么阶段计算什么指标】

~~~text
Document → Chunking / Embedding → Point/Vector Index
                                  ↓
                    Vector / Keyword 候选召回
                      └─ Evidence Recall@K：正确证据是否进入候选
                                  ↓
                    Fusion / Rerank：重排已有候选
                      └─ nDCG@K / MRR：排序是否更合适
                                  ↓
                    Context Construction：筛选并组织 LLM 输入
                      └─ 最终证据覆盖、Token/冗余与截断
                                  ↓
                    LLM Generation
                      └─ Faithfulness / Answer Correctness

独立对照：ANN 搜索 ↔ Exact kNN
          └─ ANN Recall@K：近似索引的几何近邻误差
~~~

**对妙码 AI Flow 的适用位置**：

- 已核对的 [`VectorRetriever`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts) 接收 Query，经 Embedding 和 `VectorStore.search()` 返回排序好的 Chunk；可以记录初始 Run，计算 Hit/Recall/Precision。
- 已核对的 [`HybridRetriever`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts) 定义 `vector/fulltext/hybrid` 三模式。混合模式使用 `expandedTopK = ceil(topK*1.5)` 分别获取候选，再使用加权 RRF 融合（`k=60`，默认 `vectorWeight=0.7`），最终截取 `topK`。这提供了对照“向量结果 vs 融合后结果”的源码测试位置，**不表示实际环境已经完成 BM25、自动 Rerank 或质量评测**。
- 当 `FulltextSearchProvider` 未提供时，混合检索走向量结果的降级路径；不能仅看到类型名称 `hybrid` 就假定两个通道始终都真实运行。
- 当前 `QdrantVectorStore.search()` 的得分是向量相关性信号；RRF 融合后得分则是排序融合分数，两者不可直接相加或当作 Ground Truth。评测应使用稳定的身份、版本与证据标注，在同一个 Query 集上比较排序指标和响应延迟。

**建议的最小验证**：同一固定语料与查询集执行 `vector` 和 `hybrid` 两种 Run（必须确认混合时全文 Provider 实际生效），使用 `ranx` 或等价工具比较 `Recall@K`、`MRR@K`、`nDCG@K`；参数、Embedding 版本、知识库权限范围、候选深度与最终 K 都随结果一起记录。未运行之前不声称哪个方案在项目中更好。

#### 【面试标准回答】

Hit@K 表示前 K 条是否至少命中一条正确证据；Recall@K 表示所有正确证据中有多少进入了前 K 条；Precision@K 表示前 K 条中相关候选所占比例。RR 是单个 Query 的首条相关结果排名倒数，多 Query 取平均才得到 MRR；nDCG 则综合相关性等级与位置折损，衡量排序与理想排序之间的差距。

选指标应先确定系统消费结果的方式：初始候选阶段优先保证 Evidence Recall，多事实问题还应检查必要事实覆盖；用户只看第一条时可关注 MRR/Hit@1；融合与 Rerank 关注 nDCG；最终上下文还需检验证据是否确实进入模型输入，而非只报告较高的初始 Recall。精确向量搜索对照 ANN 的 Recall 与人工标注的业务 Evidence Recall 是两种不同评测，不能混用。

#### 【资料依据与后续边界】

- [Qdrant：Measuring Retrieval Relevance](https://qdrant.tech/documentation/search-evaluation/retrieval-relevance/)：采用 Qrels/Run 和 ranx 评测 `Recall@K`、`MRR`、`nDCG@K`，并按系统消费场景选取 K。
- [Qdrant：Before Tuning a Collection](https://qdrant.tech/documentation/search-tuning/before-tuning-a-qdrant-collection/)：不同指标可能选出不同的“最佳参数”；应先确定优化目标。
- [妙码 AI Flow 向量检索器源码](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts) 与 [混合检索器源码](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)：现有检索链路的可观察节点和候选排序机制。

---

## 【二、离线知识表示与检索索引】

**通用机制衔接：** [Dense/Sparse/BM25 的索引与评分](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/R-RAG混合检索过滤融合与重排序完整知识体系.md) 逐步推导相应算法、数据结构、执行过程与验证边界；本章节继续保留 AI Flow 的全部具体源码、数据案例、工程问题和方案，不以通用正文替代项目分析。

从 Dense 向量表示与词项检索的差异入手，理解 BM25 的倒排索引、词项权重、Qdrant Sparse Vector 以及离线与在线数据结构的配合。文档切分和基础 Embedding 的完整工程解释沿用相邻专题，不在本篇以摘要替代原有原理和源码。

### 【2.1 Dense 与 BM25 的匹配机制和互补性】

*原讨论问题：为什么 Dense Vector Search 与 BM25 具有互补性，什么时候应该引入 Hybrid Search*


#### 【提问与知识目标】

此前已掌握文档切片、Embedding、Qdrant Dense Vector、HNSW 与 Evidence Recall 等基本链路。接下来讨论一个架构决策：**已经有了语义向量检索，为何还要建立词项检索？** 关键不是“检索算法越多越好”，而是确认不同查询对语义泛化和精确词项的依赖不同，进而用 Ground Truth 检验是否存在可弥补的召回缺口。

仍从企业知识检索的通用问题出发；妙码 AI Flow 的实现作为后续源码实例。所有排序和分数均为教学假设，而非实际项目评测数据。

#### 【相同主题下，为什么语义接近不等于证据正确】

假设企业知识库保存：

| 文档 | 文本内容 |
|---|---|
| D1 | E-1042：数据库连接池耗尽，导致接口超时 |
| D2 | E-1043：数据库连接超时，需要检查网络配置 |
| D3 | E-1088：数据库连接异常，需要检查服务健康状态 |
| D4 | API 请求异常的通用排查流程 |

Query：“E-1042 故障应该如何处理？”

在一个假设的 Dense 排序中，D2、D3 可能排在 D1 前：因为这些文档都包含数据库连接、超时等近似语义，**Embedding 并不天然保证两个字符相近但身份不同的故障编号能被可靠区分**。

若建立合适的词项索引，BM25 能利用 `E-1042` 这个具有区分度的匹配词项，将 D1 作为重要候选。要真正保证“编号完全相同”，实际系统还应给编号建立精确字段或设计不拆分编号的 Analyzer，**不要把 BM25 词项匹配误当严格的业务身份校验**。

换一种 Query：“系统运行一阵后，接口为什么越来越慢？”正确资料可能写“连接池耗尽，排队请求增多，使响应时间持续上升”。Query 和文档词汇不同，Dense Embedding 有机会学习表达之间的语义关系；不带同义词扩展的 BM25 可能漏掉。

**互补的根本原因**：稠密检索以向量空间距离衡量语义相关性；BM25 以显式词项匹配及统计权重衡量文本相关性。两种机制会产生不同的正确候选和不同的错误。

#### 【Dense Search 与 BM25 的输入、索引和匹配机制】

**Dense Search**：

~~~text
离线：
原始文档 → Chunking → Embedding → Dense Vector → Qdrant Point
                                                     ↓
                                             HNSW 等近邻索引

在线：
Query → 同一语义空间的 Query Embedding → kNN/ANN → 相似度排序 Top-K
~~~

优势是语义泛化和同义表达匹配；局限包括精确编号/型号、版本数字、否定条件、稀有术语的权重可能无法按业务需要稳定保持。HNSW 解决**高效搜索近邻**，并不改变 Embedding 对业务相关性的定义。

**BM25**：

~~~text
离线：
原始文档 → Chunking → Tokenization/规范化 → 词项频率等统计
                                             ↓
                                       倒排索引
                          词项 → Posting（哪些文档/Chunk 含有它）

在线：
Query → 兼容的分词规则 → 查询词项
                         ↓
                 倒排列表获得候选
                         ↓
               TF、IDF、长度归一化评分
                         ↓
                       Top-K
~~~

BM25 关注三个主要因素：
- TF：某词项在**当前文档**中出现的次数；
- IDF：某词项在**整个参考语料**中有多稀少（依赖文档总数 N 和文档频率 DF）；
- 文档长度归一化：防止较长文档仅因包含更多文本而获得不合理优势；参数 `k1`、`b` 控制词频饱和及长度校正。

虽然 BM25 不需要训练 Dense Embedding 模型，但仍需要一致的 Tokenizer、大小写/标点规范化、特殊标识符处理、存储统计和索引维护。中文语料尤其需要重视分词粒度与同义词策略。

简化公式：

~~~text
BM25(Q,D) = Σ IDF(t) × [ TF(t,D) × (k1+1)
                        / (TF(t,D) + k1 × (1-b+b×|D|/avgdl)) ]
        t∈Query
~~~

该公式是常见 BM25 写法，具体 IDF 平滑和权重的实现存在差异；它表示**对当前 Query 包含的词项，按该文档 TF、全局 IDF 与长度因素累计得分**，而不是离线把所有词只排列一次。

**对比与边界：**

| 维度 | Dense Vector Search | BM25 |
|---|---|---|
| 查询匹配依据 | Query/Document 向量距离 | Query/Document 的词项匹配及统计 |
| 典型索引 | HNSW 等向量近邻结构 | Inverted Index / Posting List |
| 同义表达 | 往往更有优势 | 缺少共同词项时可能漏检 |
| 编号/术语 | 可能混淆接近形式 | 适当词项分析下常有优势 |
| 否定/条件 | 可能忽略关键约束 | 可能匹配文字，但仍不理解逻辑关系 |
| 工程限制 | Embedding 版本、维度、索引质量 | 分词、统计、查询词项、索引维护 |

**误区**：BM25 匹配“入职不满一年”“不适用”等词，不意味着算法理解条件推理；Dense 与 BM25 都不能替代权限、版本有效性和复杂规则验证。

#### 【Hybrid Search 怎样结合互补能力】

典型实现不是把语义向量与 BM25 原始分数硬相加，而是并行进行两路候选检索，再做融合：

~~~text
                       Query
                     /       \
       Query Dense Embedding  Query Tokenization / BM25 表示
                  |                  |
             Dense Top-K        BM25 Top-K
                  \                  /
                  去重、融合/排序（Fusion）
                            ↓
                       Final Top-K
                            ↓
                     Context / LLM
~~~

例如：

~~~text
Dense 排序：D2、D3、D1、D4
BM25 排序： D1、D2、D4、D5

候选并集：D1、D2、D3、D4、D5
~~~

两路召回的**并集**可能带来覆盖增益，但最终只保留较小 Top-K 时，融合排序仍可能再次丢失正确证据。候选召回要看 Evidence Recall，最终排序还需看 MRR/nDCG，不能仅因两路并行就宣布 RAG 质量改善。

两种评分尺度不能直接无条件相加。例如 Cosine Score 可能在 0～1 附近，而某个 BM25 分数可能为 14.5；原始相加会产生不可解释的偏置。可使用 RRF（基于排序位置）、经过校准的分数融合或额外 Rerank，下一题再详解 RRF 的计算与适用边界。

#### 【妙码 AI Flow：现有检索链路究竟是什么】

源码需要先按业务入口理解，而不是仅看到 `hybrid` 名称就推断已具备“标准 BM25”：

1. [知识库检索 API](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/app/api/knowledge/%5Bid%5D/search/route.ts) 核验用户对知识库的访问权后，读取 `mode`、`topK`、`threshold`，创建 Ollama Embedding、Qdrant Store 与 FulltextSearchProvider，调用 `HybridRetriever.retrieve()`。
2. [VectorRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts) 将 Query 交给 Embedding，然后通过 Qdrant VectorStore 获取 Dense 检索结果。
3. [QdrantVectorStore.textSearch()](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts) 通过一次 `scroll(limit:1000)` 读取所选知识库的部分 Point，再在应用层做子串匹配、匹配次数加权、排序。它未执行完整分页遍历，且没有 BM25 的规范 TF/IDF/长度归一化计算与独立倒排索引；**不能称为 BM25**。
4. [HybridRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts) 支持 `vector/fulltext/hybrid`；混合模式将 `topK` 扩到 `ceil(1.5*topK)` 作为两路候选深度，并行获取后使用加权 RRF 融合（代码 `k=60`，默认 `vectorWeight=0.7`），最后截取最终 `topK`。
5. [KnowledgeExecutor](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/executors/knowledge-executor.ts) 在工作流的知识库节点中也构建相同风格的文本 Provider 并调用 HybridRetriever，将结果组织成工作流输出；不能仅根据执行器已创建 Provider 就认为运行时总是有有效的第二路结果。

**对当前项目准确的描述**：`Dense Vector + 应用层自定义文本匹配 + 加权 RRF`，而不是“Dense + 标准 BM25 倒排索引 + RRF”。如果全文搜索未返回结果，混合检索会返回向量结果的前 K 条。

#### 【通过评测决定是否引入标准 BM25】

固定 Query/Qrels、语料版本、授权范围、Embedding 模型和候选 K，对照：

~~~text
A：Dense
B：标准 BM25（确认词项分析和索引真实可用）
C：Dense + BM25 + Fusion
~~~

至少分组检验：精确编号/产品型号、口语同义表达、跨文档多事实、否定与条件问题。计算 Evidence Recall@K、nDCG@K、MRR、P95 延迟和索引维护成本；如果混合方案相对最强单路没有显著收益，未必值得额外增加基础设施复杂度。

#### 【面试标准回答】

Dense Vector Search 利用 Embedding 将 Query 与知识表示为稠密向量，通过向量距离衡量语义相似，适合措辞不同但语义相近的问题；BM25 基于分词及词项的 TF、IDF 和长度归一化计算相关性，常通过倒排索引高效查询，能够突出精确编号和稀有术语等显式匹配信号。两者保留的相关性信息不同，因此可能互相弥补召回缺陷。

Hybrid Search 分别执行两路候选检索，再去重并通过 RRF、分数融合或 Rerank 得到统一排序。引入双路检索前应通过统一 Ground Truth 检查各类 Query 的真实召回互补性及增益成本，不能仅因存在 Hybrid 类型就认定拥有标准 BM25。妙码 AI Flow 当前实现的是 Dense + 应用层自定义文本匹配 + 加权 RRF，需要另行建设 BM25 词项索引才能与标准方案等同。

#### 【资料与源码】

1. [Qdrant：The Two Families of Search](https://qdrant.tech/course/beginners/module-3/the-two-families-of-search/)：Dense/稀疏两类检索的机制与互补性。
2. [Qdrant：Hybrid Search](https://qdrant.tech/documentation/search-tuning/hybrid-search/)：候选预取、BM25 稀疏通道与 RRF。
3. [Qdrant：Understanding Vector Search](https://qdrant.tech/documentation/overview/vector-search/)：向量和倒排索引的语义与词项匹配边界。
4. [Qdrant：Measuring Retrieval Relevance](https://qdrant.tech/documentation/search-evaluation/retrieval-relevance/)：使用有标注查询评价真实收益。
5. 妙码 AI Flow 源码：以上知识库检索 API、`textSearch()`、`VectorRetriever`、`HybridRetriever` 和 `KnowledgeExecutor`。

---

### 【2.2 BM25 倒排索引、Sparse 表示与运行过程】

*原讨论问题：BM25 的词项、倒排索引和稀疏向量怎样在离线与在线阶段协作*


#### 【提问与知识目标】

问题集中在五个连续判断：

- BM25 是否需要把文档先做词向量拆分，再计算 TF？
- 离线时建立“词与文档”还是“词与词”的关联？
- 是不是离线直接把词按 TF 排序？
- 在线如何对 Query 分词、定位候选和计算 Top-K？
- 这些结构存哪里，Qdrant 是否自带 BM25，它与现有 Dense Point 能否共存？

**先统一术语**：Chunking 按段落/章节形成可检索片段；Tokenization 将片段拆成词项；Sparse Vectorization 将词项映射到稀疏向量的非零维度及权重；Dense Embedding 则是另外一条语义表示链路。BM25 不要求为每个词训练 Dense Embedding。

#### 【离线处理：从 Chunk 到词项倒排索引】

假设同一知识库有：

~~~text
C1：数据库连接池耗尽，数据库请求超时。
C2：数据库连接失败，需要检查网络。
C3：用户登录失败，需要检查密码。
~~~

为说明机制，假设中文词项分析得到：

~~~text
C1：数据库、连接池、耗尽、数据库、请求、超时
C2：数据库、连接、失败、检查、网络
C3：用户、登录、失败、检查、密码
~~~

注意这不是任何特定分词器的精确输出；生产使用需验证中文语言分析、停用词、大小写及错误编号等字段的处理规则。

按词项统计得到：

| Token | C1 的 TF | C2 的 TF | C3 的 TF | DF（包含它的文档数） |
|---|---:|---:|---:|---:|
| 数据库 | 2 | 1 | 0 | 2 |
| 连接池 | 1 | 0 | 0 | 1 |
| 失败 | 0 | 1 | 1 | 2 |
| 登录 | 0 | 0 | 1 | 1 |

**TF 是词项与某个文档之间的统计，不是该词整个知识库中的固定名次。**离线构建的核心结构通常为倒排索引（Inverted Index）：

~~~text
词项（Token） → Posting List（包含它的 Chunk/文档）

数据库 → [(C1, TF=2), (C2, TF=1)]
连接池 → [(C1, TF=1)]
失败   → [(C2, TF=1), (C3, TF=1)]
登录   → [(C3, TF=1)]
~~~

一条 Posting 还可以存词项位置等信息，以支持短语检索。DF 是从“多少篇文档包含某词”得到的集合统计；平均文档长度需要语料级别的长度统计。**离线组织这些数据是为了快速定位候选，并非按 TF 将所有词项统一排序；文档与 Query 的最终相关分数是在查询到来时才有明确意义的。**

**回答索引关系的核心问题**：

- BM25 的倒排关系：**词项/稀疏维度 → 包含它的文档或 Chunk/Point**。
- HNSW 的主要近邻关系：**向量点 ↔ 向量点**，通过图连接近邻。
- 两者都不是将词项顺序连接成“词与词”的邻接图。

#### 【在线查询：Tokenization、Posting 合并、BM25 评分、Top-K】

用户提问：“数据库连接池为什么会耗尽？”

~~~text
1. Query Tokenization：
   数据库、连接池、耗尽

2. 根据倒排索引查找候选：
   数据库 → C1、C2
   连接池 → C1
   耗尽   → C1

3. 合并 Posting：
   候选集合 {C1, C2}

4. 对每个候选按 Query 词项计算得分：
   C1：包含数据库、连接池、耗尽；数据库出现 2 次
   C2：只包含数据库；其余两个关键词项不匹配

5. 按总得分排序：
   Top-1 预期 C1，Top-2 可能包含 C2
~~~

BM25 在离线维护的词项统计基础上，结合当前 Query 执行评分。常见公式：

~~~text
BM25(Q,D) = Σ[ IDF(t) ×
               TF(t,D)(k1+1)
             / (TF(t,D)+k1(1-b+b|D|/avgdl)) ]
           t∈Query
~~~

- `TF(t,D)`：t 在 D 中出现的次数；
- `DF(t)`：包含 t 的文档数；与总文档数 N 一起决定 `IDF(t)`；
- `|D|`：D 的词项长度；`avgdl`：平均文档长度；
- `k1`：词频饱和控制；`b`：文档长度归一化强度。

不同引擎对 IDF 平滑以及 TF 权重预计算与否的实现有所差异，不能将公式的每个计算步骤误认为所有数据库完全相同的运行时序。

示例中 C1 同时匹配更多词项，且包含罕见的“连接池”“耗尽”，因此**通常有理由预期** C1 比 C2 排名更靠前；这不是不经实际统计就可保证的任何文本下的严格次序。

#### 【词项索引保存在哪里：传统检索引擎与数据库的职责】

倒排索引一般由搜索引擎/数据库持久化维护，业务代码不必自己建立如下 SQL 表：

~~~text
term | chunk_id | tf
~~~

这个表只是理解“关联关系”的逻辑模型。Lucene/Elasticsearch 等全文搜索系统持久化管理词项字典、Posting、文档长度与其他评分统计；更新文档时维护相应索引。真实的物理编码、压缩、合并段机制通常比一张关系表复杂。

**索引不一定离线一次完成后永久不变**：新文档增删、分词策略和语料统计变化都可能触发增量索引更新或段优化。这里说“离线构建”是从用户 Query 的实时路径中分离文档入库，而不意味着只能批量停机重建。

#### 【Qdrant 是否提供 BM25：Sparse Vector 索引与原生文本推理】

**提供。**但需分清三个能力：

| Qdrant 结构/能力 | 主要作用 | 是否直接等于 BM25 排名 |
|---|---|---|
| Dense Vector + HNSW | 向量语义近邻搜索 | 否 |
| Payload Full-text Index | 对文本 Payload 做词项/文本条件过滤 | 否，单独的 Payload Filter 不等于 BM25 |
| Sparse Vector Index + BM25 表示与 IDF | 词项加权的 BM25 式排序 | 是，正确配置索引、向量模型和 IDF 时 |

在 Qdrant 中，Sparse Vector 的非零维度可以对应词项的数值标识，权重则编码该词在文档中的重要性。示意：

~~~json
{
  "indices": [12, 35, 79],
  "values": [1.4, 0.8, 2.1]
}
~~~

这里 `indices` 是稀疏向量的非零维度列表，**不是倒排索引本身**；Qdrant 另行维护“维度 → 含此维度的 Point”的稀疏索引。官方把这种索引描述为倒排索引风格的结构，且稀疏检索默认是精确的向量得分计算，不像 HNSW 主要使用 ANN 近似近邻。见 [1][2]。

**同一个 Point 可以同时存 Dense 与 BM25 Sparse 表示**：

~~~text
Collection：knowledge_chunks
      │
      └── Point C1
           ├─ Payload：chunkId、documentId、content、knowledgeBaseId
           ├─ Dense Vector：语义嵌入，用于 Dense Search
           └─ BM25 Sparse Vector：词项非零维度和权重
                  ↓
               Sparse Index（倒排式）
~~~

Collection 配置**概念示例**（REST 创建新 Collection 的形态）：

~~~json
{
  "vectors": {
    "dense": {
      "size": 1024,
      "distance": "Cosine"
    }
  },
  "sparse_vectors": {
    "bm25": {
      "modifier": "idf"
    }
  }
}
~~~

其中 `dense`/`bm25` 是命名向量；`size:1024` 仅是示例，应与实际 Embedding 维度一致；`modifier:"idf"` 表示为稀疏检索启用 Qdrant 管理的 IDF 权重。创建不同名称的索引或更换 Embedding 不能简单把旧 Point 原样当成已经同时持有两种向量，需要确认新 Vector 字段已配置并给现有 Point 补录对应稀疏表示。

**两种可行的 Sparse 生成方式**：

1. 服务端能力允许时，向 Qdrant 提交带 `model:"qdrant/bm25"` 的原始文本，使用其服务器侧 BM25 推理；实际可用性取决于 Qdrant 版本、部署方式和相应推理功能。
2. 使用兼容的客户端（如 FastEmbed）在文档写入时产生 BM25 Sparse Vector，再按命名字段写入 Qdrant；在线 Query 需使用**兼容的模型、Tokenizer 与维度映射**编码。

Qdrant 官方 [Server-side Inference: BM25](https://qdrant.tech/documentation/inference/inference-bm25/) 展示直接使用原始文本构建 BM25 Sparse 表示；[Hybrid Search](https://qdrant.tech/documentation/search-tuning/hybrid-search/) 展示同一请求对 Dense/BM25 做预取、RRF 融合；[Indexing](https://qdrant.tech/documentation/manage-data/indexing/) 说明稀疏索引和其维护机制。

**IDF 不是永远固定在“离线预计算结果”中**。使用 `modifier:"idf"` 时，Qdrant 在检索中依赖存储的语料级统计对稀疏匹配加权，文档增删可能使 IDF 变化。默认统计范围通常是被查询 Shard 的全体数据；对于使用 `knowledgeBaseId` 过滤的多租户知识库，检索结果限制和 IDF 参考语料的范围未必相同，必须依据部署版本、索引配置和隔离设计判断是否需要独立的统计范围。参考 [Qdrant Multitenancy - Per-Tenant IDF](https://qdrant.tech/documentation/manage-data/multitenancy/)。

**中文与特殊标识符**：BM25 要对文档与 Query 使用相兼容的词项分析与 ID 映射；若针对中文，只按英文空格切分会遗漏真正的词边界，需检查 Qdrant 模型/Tokenizer 对语言的支持，并根据精确编号与语义评测结果选择合适配置。对于代码、版本号和故障编号，精确过滤字段通常比仅依赖 BM25 排名更安全。

#### 【妙码 AI Flow 的当前实现与推荐改造位置】

**项目现状（已核对）**：

- [`document-processor.ts`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts) 根据 Markdown/普通文本选择 Splitter；调用 Ollama Embedding 后将 `ChunkWithVector[]` 写入 `QdrantVectorStore.upsertVectors()`。该步骤目前构建的是 Dense 向量，不会自动生成 BM25 Sparse 向量。
- [`QdrantVectorStore.ensureCollection()`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts) 创建 Cosine Dense Vector 集合并为 `knowledgeBaseId`、`documentId` 建立 Payload Index，没有配置 `sparse_vectors.bm25`。
- [`QdrantVectorStore.textSearch()`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts) 用单次 `scroll(limit:1000)` 拿一批 Point，按标点/空格拆 Query，使用 JS 字符串包含与匹配次数自定义打分，并对该批结果排序；这不是 BM25、没有针对全部语料维护真正的 BM25 倒排索引，且没有取完分页就存在覆盖限制。
- [`HybridRetriever`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts) 已有双路候选和加权 RRF 的编排。**需要改造的是文本检索的索引及 Provider 实现，不必为了 BM25 重新发明融合框架**，但也要重新验证融合效果。

**建议方案（尚未实施）**：

~~~text
离线文档写入：
Chunk → Dense Embedding ──────────→ Qdrant Point 的 dense
     → BM25 Tokenizer/Sparse ─────→ 同 Point 的 bm25
                                     ↓
                       Qdrant 持久化向量 + 索引

在线查询：
Query → Dense Query Embedding → Dense 候选
     → BM25 Sparse Query ─────→ BM25 候选
                             ↓
                    Fusion（RRF） → Top-K
~~~

需要核实项目当前部署的 Qdrant 版本/推理功能与客户端 API，再确定使用服务端 BM25 推理或客户端 FastEmbed；对已有 Point 执行稀疏表示补录/重建，确保原 Payload、知识库过滤、授权边界不丢失。对于新增 BM25 通道，应对照此前构建的 Ground Truth，在相同 Query 集上比较现有文本匹配、独立 BM25 和 Dense+BM25 的 Evidence Recall@K、nDCG、MRR、P95 及索引开销。

#### 【本题标准回答】

BM25 的离线阶段不是将词项变成 Dense Embedding，也不是按 TF 给词建立一个全局排行榜，而是将 Document 或 Chunk 分词、统计词项在每个文档中的频率以及语料统计，建立**词项到文档/Chunk 的倒排索引**，并持久化在搜索引擎或数据库中。在线 Query 使用兼容的分词规则，查询词项关联的 Posting，汇总候选后结合 TF、IDF 和文档长度计算与当前 Query 的相关性，排序获得 Top-K。倒排索引的核心是词与文档的关联，而不是 HNSW 那样的向量近邻图。

Qdrant 可以通过 BM25 Sparse Vector 索引实现这套能力，并允许同一个 Point 同时拥有 Dense 向量和 BM25 稀疏向量。Sparse 向量的非零维度与权重由 BM25 表示生成，Qdrant 维护对应的倒排式索引和可用的 IDF 统计，支持独立 BM25 查询以及 Dense/稀疏结果融合。但 Payload Full-text Filter 不等于 BM25，离线词项权重也不是永远固定的完整查询分数。

妙码 AI Flow 当前只写入 Dense 向量，文本检索依靠从 Qdrant 获取一批 Payload 后在 Node.js 层字符串匹配，尚未接入 Qdrant BM25 Sparse 通道。升级时应在已有 Chunk 入库和检索 Provider 处补齐 Sparse 表示、索引及在线 Query 编码，再结合 Ground Truth 验证质量和成本，而不是仅更改 `retrievalMode` 的名称。

#### 【资料与实现边界】

1. [Qdrant：Sparse Vectors and Inverted Indexes](https://qdrant.tech/course/essentials/day-3/sparse-vectors/)：`indices/values` 与真实倒排索引的区别、稀疏检索。
2. [Qdrant：The Two Families of Search](https://qdrant.tech/course/beginners/module-3/the-two-families-of-search/)：词项到 Point 的倒排链路。
3. [Qdrant：Indexing](https://qdrant.tech/documentation/manage-data/indexing/)：Sparse Index 的精确性质及索引构建/优化。
4. [Qdrant：Server-side Inference BM25](https://qdrant.tech/documentation/inference/inference-bm25/)：`qdrant/bm25` 的原生文本推理。
5. [Qdrant：Hybrid Search](https://qdrant.tech/documentation/search-tuning/hybrid-search/)：Dense/BM25 预取与融合机制。
6. [Qdrant：Multitenancy - Per-Tenant IDF](https://qdrant.tech/documentation/manage-data/multitenancy/)：多租户情况下的 IDF 语料统计范围。
7. 项目源码：[知识入库](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts)、[Qdrant Store](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)、[HybridRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)、[检索 API](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/app/api/knowledge/%5Bid%5D/search/route.ts)。

---

## 【三、在线检索、授权过滤与 Hybrid 候选召回】

**通用机制衔接：** [Payload Filter、权限和 Hybrid 召回](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/R-RAG混合检索过滤融合与重排序完整知识体系.md) 逐步推导相应算法、数据结构、执行过程与验证边界；本章节继续保留 AI Flow 的全部具体源码、数据案例、工程问题和方案，不以通用正文替代项目分析。

在理解索引结构后，先明确当前用户允许检索哪些数据、Qdrant 如何执行带约束的近邻搜索，再进入项目真实全文检索链路和 Dense + Sparse 的工程改造。

### 【3.1 Payload Index、过滤时机与权限边界】

*原讨论问题：RAG 的权限与有效性过滤应在离线建索引、检索中还是检索后执行*


#### 【提问】

在 RAG 检索中，如果需要按照知识库/租户权限、文档状态、有效版本、生效时间等条件限制检索范围，这些条件通常在**离线入库时**处理，还是在**执行向量检索前/过程中**过滤，或应当先检索再由应用程序做**检索后过滤**？Qdrant 的 Payload Keyword Index 是如何发挥作用的？已有项目采取了什么机制？

#### 【结论与知识概述：离线建索引、在线定范围、检索时过滤、必要时检索后复核】

这并非三个互斥方案，而是不同职责分层：

| 阶段 | 目标 | 核心输入与操作 | 对最终证据的影响 |
|---|---|---|---|
| 离线文档入库/索引准备 | 提供可过滤的数据结构 | 将 `knowledgeBaseId`、`documentId`、`tenantId`、`status`、`effectiveFrom/To` 等适用字段写入 Payload，建立相应类型的 Payload Index | 为之后的高效过滤提供数据与索引，但不能替当前用户做授权决策 |
| 在线查询发起前 | 计算本次合法访问范围 | 验证身份；读取后端的知识库/文档授权关系、当前有效版本与时间约束，构造查询 Filter | 得到当前调用者真正被允许访问的数据集合 |
| Qdrant 检索执行期间 | 在 Filter 约束下求相关 Top-K | Query Vector 或 Sparse Query + Payload Filter，由 Qdrant 查询规划器选择执行策略 | 避免不合法候选先占据无过滤 Top-K，再被应用层删掉 |
| 检索后、Rerank/Context 前 | 必要的二次校验 | 检查版本、文档是否失效、权限是否撤销、来源信息是否仍有效 | 增加一致性与安全保护，但不能取代检索期的范围约束 |

**硬性授权和已知业务约束应尽量下推到检索请求中，而不是依赖“全库 Top-K → 后置删除”**。同时后置复核仍有意义，尤其用于处理动态授权与文档状态变更；如果复核失败，不能继续向 Reranker、LLM、前端或日志释放该证据。

注意这里的“在线检索前”是指**先由业务层计算授权与过滤条件**；向量数据库内部并不一定按“先物化所有过滤后的 Point，再对它们启动 HNSW”的固定顺序执行。应从**逻辑约束**和**物理执行计划**两个层次理解。

#### 【概念边界：Payload、Payload Index、Filter 与向量索引分别做什么】

假设 Point：

~~~json
{
  "id": "point-001",
  "vector": [0.12, 0.84, 0.23],
  "payload": {
    "chunkId": "doc-001_0",
    "content": "员工应提前三个工作日申请年假。",
    "knowledgeBaseId": "kb-A",
    "documentId": "doc-001",
    "tenantId": "tenant-01",
    "status": "ACTIVE"
  }
}
~~~

上面的向量只是教学示例，实际维度与项目 Embedding 模型一致。

- **Payload**：附在 Point 上的正文和业务属性，作为过滤表达式可访问的数据；存在 Payload **不自动等于**已为字段建立索引。
- **Payload Index**：按字段类型为 Qdrant 的过滤和查询规划提供加速、基数估计及过滤式 HNSW 关联能力；例如 `keyword` 适合精确匹配的知识库 ID，不是对 `content` 做 BM25 倒排索引。
- **Filter**：某次请求真正要执行的业务范围约束，例如当前用户仅可访问 `kb-A`；必须在在线 Query 中传入，**建立索引本身不代表自动启用该条件**。
- **Dense HNSW / Sparse Index**：决定相似度/词项候选如何发现并排序；Payload Index 是与之协作的过滤机制，不是把过滤字段本身变成语义向量。

重要澄清：将 `tenantId` 建立为 Payload Keyword Index，并不意味着给每位用户创建一个物理隔离的 Collection 或独立向量空间。共享 Collection 上的 Filter 首先提供**逻辑隔离**；是否采用 per-tenant 布局、`is_tenant` 优化、独立 Shard 或独立 Collection，是另一层有关隔离、性能与租户规模的架构决策。高隔离要求还应考虑服务端权限、密钥与数据部署边界。

#### 【Qdrant 如何把 Filter 与 HNSW 搜索结合起来】

Qdrant 官方[Filtering in Vector Search](https://qdrant.tech/documentation/search-patterns/vector-search-filtering/)明确区分：

- **纯后置过滤**：先执行无约束近邻搜索，截断 Top-K，再删除不满足条件的候选。它可能导致返回数量不足，且正确的合法候选根本未进入无约束 Top-K。
- **朴素完全前置过滤**：先找到所有符合条件的 Point，再逐一精确计算向量距离。对匹配很少的情况可行，但过滤后集合较大时穷举开销可能很高。
- **Qdrant 的检索中融合过滤**：结合 Payload Index、过滤条件及分段查询规划，可能直接评分少量过滤后的候选，也可能在 Filterable HNSW 上进行带约束的近邻搜索；具体执行路径与过滤基数、索引构建状态和配置有关。

逻辑链路：

~~~text
查询者身份
     ↓
后端鉴权与权限计算
     ↓
授权的 KnowledgeBase/Document IDs、有效版本等
     ↓
[Query Embedding + Qdrant Payload Filter + topK]
     ↓
Qdrant Query Planner
     ├─ 少量匹配候选：直接评分
     └─ 大范围匹配：利用支持过滤的向量索引
     ↓
在过滤约束下返回相似候选 Top-K
     ↓
必要时进行失效/授权复核
     ↓
Fusion → Rerank → Context Construction → Generation
~~~

因此不能在面试中笼统回答“Qdrant 总是先过滤完所有文档，再去运行一次 HNSW”。正确表达是**在向量检索执行中施加 Filter 约束，并由 Qdrant 选择合适的搜索策略**。

**过滤不意味着 ANN 一定变为精确搜索**：当采用近似 HNSW 时，严格 Filter、多个过滤条件的交集以及索引状态都可能影响 Recall 和延迟。可使用精确过滤向量搜索作为小样本基线，对比正常过滤式 HNSW 的 Recall@K 和 P95；部分 Qdrant 版本/部署支持 ACORN 等提高严格过滤场景召回的策略，应基于实际 Server 版本测试。

#### 【为什么不能先取全库 Top-K 再在应用端过滤：正确性与安全性】

假设用户只允许访问知识库 A，查询返回上限为 `topK=3`，知识库 B 不可访问。全库原始相似度排序：

| 全库名次 | Chunk | 知识库 | 当前用户是否有权 |
|---:|---|---|---|
| 1 | B1 | B | 否 |
| 2 | B2 | B | 否 |
| 3 | A1 | A | 是 |
| 4 | B3 | B | 否 |
| 5 | A2 | A | 是 |
| 6 | A3 | A | 是 |

错误方案：

~~~text
无过滤 Query → 全库 Top-3 = [B1, B2, A1]
                         ↓
                    应用层删除 B1/B2
                         ↓
                     最终仅 [A1]
~~~

虽然 A2/A3 合法且相关，但已在无过滤 Top-3 之外，被提前截断；返回仅一条而非请求的三条，损害**授权语料内的 Candidate Recall**。

正确的查询约束：

~~~text
filter = { knowledgeBaseId in ["A"] }
              ↓
     在 A 范围内执行 Top-3
              ↓
          [A1, A2, A3]
~~~

这个例子是假设 A 中确实有三条候选的教学情况，实际 ANN Top-K 还受阈值和近似搜索影响。

还有权限与信息流问题：无约束检索可能把 B 的 Payload 带回应用服务，并在调试日志、Reranker 或模型输入中产生不必要的越权处理风险。**所以应在服务端使用经过授权的 Filter 限制候选发现，不能仅在最后输出 HTML/JSON 前过滤**。

后置验证仍然可以作为额外检查，例如检索执行期间某文档刚好被撤销或者文档发布状态变更；此时可丢弃失效候选并在合法范围内适度补检，但不能只依赖这种后续修复。

#### 【妙码 AI Flow 的源码现状：已建立两种 Keyword Index，在线只按知识库 ID 过滤】

##### 【一、离线创建 Collection 与 Payload Index】

[`packages/ai-engine/src/knowledge/store/qdrant-store.ts`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts) 的 `ensureCollection()` 会在**新建 Collection** 后执行：

~~~typescript
await this.client.createPayloadIndex(
  this.collectionName,
  {
    field_name: "knowledgeBaseId",
    field_schema: "keyword",
  },
);

await this.client.createPayloadIndex(
  this.collectionName,
  {
    field_name: "documentId",
    field_schema: "keyword",
  },
);
~~~

作用：

- `knowledgeBaseId`：在 Dense Search 与 `textSearch()` 的 `scroll` 过滤中使用，限制检索范围；
- `documentId`：在 `deleteByDocumentId()` 删除点数据的过滤等操作中使用，也方便后续文档级查询。**不能因为建立了该字段索引就声称当前 Dense Search 已经自动增加 `documentId` 查询过滤**。

`upsertVectors()` 将 `chunkId/content/chunkIndex/documentId/knowledgeBaseId` 等作为 Point Payload 写入 Qdrant。这样离线将业务字段编码成可过滤的数据。

**源码细节**：`ensureCollection()` 检查到 Collection 已存在时会提前返回。因此若对老 Collection 新增过滤字段索引或发现旧索引缺失，不能只调用此方法就假设索引已被自动补齐；应单独检查索引 Schema 并执行可重复的索引迁移/修复逻辑。

Qdrant 官方建议在已知过滤字段时**优先在写入 Point 前建立 Payload Index**，让 Filterable HNSW 的过滤关联随着索引结构创建得更充分；如果先积累大规模数据、后来再补索引，可能需要重建 HNSW 相关结构才能得到相同的过滤性能。参见 [Production: Bulk Data Import](https://qdrant.tech/documentation/production-operations/bulk-data-import/)。

##### 【二、业务 API 在线先判断知识库归属】

[`apps/workflow/app/api/knowledge/[id]/search/route.ts`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/app/api/knowledge/%5Bid%5D/search/route.ts) 首先：

~~~typescript
const userId = await getCurrentUserId();
if (!userId) {
  return apiError(ErrorCode.UNAUTHORIZED);
}

const knowledgeBase = await prisma.knowledgeBase.findFirst({
  where: { id: knowledgeBaseId },
});
if (!knowledgeBase || knowledgeBase.userId !== userId) {
  return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND);
}
~~~

即这条 API 在调用检索器之前，先核对用户身份及其对指定 Knowledge Base 的所有权，然后传入：

~~~typescript
const results = await retriever.retrieve({
  query,
  knowledgeBaseIds: [knowledgeBaseId],
  mode,
  topK,
  threshold,
  vectorWeight: knowledgeBase.vectorWeight,
});
~~~

这说明 API 的权限边界并非依靠 Qdrant 自动识别当前用户，而是由**业务层核验之后，将合法的知识库 ID 作为检索过滤范围传入**。

##### 【三、Qdrant 向量检索在 Query 内执行 Filter】

同一个 `QdrantVectorStore.search()` 通过：

~~~typescript
const response = await this.client.search(
  this.collectionName,
  {
    vector,
    limit: topK,
    score_threshold: threshold,
    filter: {
      must: [
        {
          key: "knowledgeBaseId",
          match: { any: knowledgeBaseIds },
        },
      ],
    },
    with_payload: true,
    with_vector: false,
  },
);
~~~

对结果施加 `knowledgeBaseId` 限制。当前的文本分支 `textSearch()` 虽然仍是 `scroll(limit:1000)` 后在 Node.js 进行字符串匹配，但 `scroll` 同样带有 `knowledgeBaseId` Filter；这不能被误写成真正 BM25 Sparse Search，也不能消除该分支只读第一页 1000 个 Point 的限制。

**结论：此 API 的“业务侧所有权校验 + 向量库检索时字段过滤”是明确的现有机制**。但项目尚未实现 `tenantId`、文档有效时段、状态或复杂 ACL 字段的统一检索过滤体系，不能将建议架构描述为已交付。

##### 【四、工作流知识节点的授权边界需要单独说明】

[`packages/ai-engine/src/nodes/executors/knowledge-executor.ts`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/executors/knowledge-executor.ts) 使用工作流节点配置里的 `knowledgeBaseIds` 调用 Retriever，在该执行器自身的代码中检查了 ID 列表非空、Query 非空等，但**没有在该执行器内做与知识库搜索 API 相同的 `userId → knowledgeBase.userId` 所有权查询**。

因此不能由“知识库搜索 API 安全”推断“所有工作流执行入口都已做同样授权”。应在所有运行入口/服务层统一保证传入执行器的是**按当前调用者授权确定的合法知识库集合**；更强的方案可把已验证的授权 Scope 当作不可由用户任意覆盖的运行时上下文，以避免节点配置绕过权限边界。

#### 【如果进一步增加生效时间、版本和细粒度 ACL，应怎样建模】

可以将已知且稳定、需要用于高频查询过滤的字段放入 Payload；示例为未来改造结构：

~~~typescript
type KnowledgeChunkPayload = {
  chunkId: string;
  documentId: string;
  knowledgeBaseId: string;
  tenantId: string;
  content: string;
  status: "ACTIVE" | "ARCHIVED";
  effectiveFrom?: string;
  effectiveTo?: string;
  version?: string;
};
~~~

入库/维护阶段：

- `keyword` 适于精确 ID、状态和版本匹配；
- 日期或数值范围应使用适当的 `datetime`、`integer` 等字段索引及 `range` 条件；
- 选择真正高频过滤字段建立索引，索引会增加存储/维护成本，且需匹配字段的值类型；
- 文档发布、版本变动、权限撤销后应确保 Qdrant Payload 与业务权威数据源间的一致性，不应让旧 `ACTIVE` 状态无限期滞留。

在线语义示意，**以下为新功能设计草案，不是当前代码**：

~~~typescript
const allowedKnowledgeBaseIds =
  await authorizationService.getAllowedKnowledgeBaseIds(currentUser);

const response = await client.query("knowledge_chunks", {
  query: queryVector,
  filter: {
    must: [
      {
        key: "knowledgeBaseId",
        match: { any: allowedKnowledgeBaseIds },
      },
      {
        key: "status",
        match: { value: "ACTIVE" },
      },
    ],
  },
  limit: topK,
  with_payload: true,
});
~~~

其中 `authorizationService` 是拟新增或复用的可信业务授权服务，而不是已有实现；若授权列表为空应直接拒绝/返回空，不可删除 Filter 退化为全库查询。

对于生效日期，既要支持开始时间约束，也要考虑 `effectiveTo` 为空（长期有效）的语义；复杂范围条件必须根据具体的 Qdrant Filter Schema 显式表达，不要把日期字符串简单当成 Keyword 做字典序比较。

**动态用户权限不宜全部当成静态 Payload**：例如用户加入/退出团队、权限变更、文档共享名单变动，真正的权限关系通常在业务数据库或授权服务中，以该权威数据源计算当前可见集合，再生成 Qdrant Filter。若 ACL 很复杂，可以考虑文档可见性物化或不同粒度的索引隔离设计，但必须平衡更新成本、查询选择性和安全性。

#### 【过滤与索引的工程验收】

应同时衡量**访问控制正确性、授权语料中的检索质量以及性能**，而不只是响应是否有结果：

| 检查 | 用例与方法 | 预期 |
|---|---|---|
| 用户隔离 | A/B 两个用户拥有不同 Knowledge Base，相同 Query | A 无法获取 B 的 Chunk 内容或来源 Metadata |
| 文档状态 | ACTIVE/ARCHIVED 两个版本同时留在存储 | 本次请求只检索当前许可且生效的版本 |
| 精确范围与后置过滤对照 | 教学情形：全库前 K 被大量越权数据占据 | 检索期 Filter 不会先让越权候选占据 Top-K |
| ANN 近似误差 | 选取严格过滤 Query，对比精确评分与普通 Qdrant 搜索 | 检查过滤范围内的 Recall@K 与 P95，必要时调整索引/参数 |
| 撤权/版本变更 | 查询期间修改权限或文档状态 | 不释放过期越权证据，必要时失败关闭、复核与补检 |
| 多入口一致性 | 管理 API、工作流知识节点、批处理调用 | 相同调用者授权 Scope 可解释、一致且不会被任意扩大 |
| 索引维护 | 新 Collection 创建、已有 Collection 迁移 | 检查字段索引存在、类型正确、索引构建状态可追踪 |

注意：`Payload Index` 能改善过滤检索性能，但本身**不等于访问控制系统**；访问控制由受信任的服务端鉴权与 Filter 构造实现，并应避免将 Qdrant 无约束查询能力直接暴露给不可信调用者。

#### 【面试标准回答】

在 RAG 系统中，权限与文档有效性过滤通常采用**离线建索引、在线检索时约束和检索后必要复核**的分层模式。离线入库时将知识库/租户 ID、文档状态、生效范围、版本等字段写入 Payload，并针对高频过滤字段创建 Payload Index；在线由服务端验证用户身份与授权，生成 Filter，与 Query Vector 一起提交给 Qdrant。

Qdrant 可以结合 Payload Index 和 Filterable HNSW，把过滤约束纳入近邻搜索执行；查询规划器依据匹配量选择对少量候选直接评分或在过滤式 HNSW 上搜索，并非固定“先把所有文档过滤完，再启动一次 HNSW”。相比“全库 Top-K 后应用层删除”，检索时 Filter 可以避免不合法候选先挤占 Top-K，减少无效数据处理，也有利于保障授权语料下的召回质量。

妙码 AI Flow 现已对 `knowledgeBaseId` 和 `documentId` 建立 Keyword Payload Index；知识库搜索 API 先核对知识库归属，再把合法 `knowledgeBaseId` 下推给向量检索及文本 `scroll` 分支。工作流 KnowledgeExecutor 本身未重复执行用户所有权校验，需要依赖受信任的运行入口统一保证其知识库 ID 范围。未来扩展有效版本和动态 ACL 时，应在可靠授权数据源上计算过滤约束，检索后对撤权、失效和来源进行必要复核，但不应把后置检查作为唯一控制。

**一句话：离线准备索引，在线计算授权范围，向量检索中执行 Filter，使用证据前必要时复核；Payload Index 是加速与查询规划工具，不是自动授权或独立向量空间。**

#### 【参考资料与源码】

1. [Qdrant：Filtering in Vector Search—Filter During the Search, Not Before or After](https://qdrant.tech/documentation/search-patterns/vector-search-filtering/)：过滤时机、Filterable HNSW 与基数感知策略。
2. [Qdrant：Bulk Data Import—Create Payload Indexes Before Uploading](https://qdrant.tech/documentation/production-operations/bulk-data-import/)：先建索引和过滤式 HNSW 关联的性能影响。
3. [Qdrant：Filtering and Exact String Matching](https://qdrant.tech/documentation/search/text-search/text-filtering/)：Keyword Index 的准确职责。
4. [Qdrant：Production Checklist](https://qdrant.tech/documentation/production-checklist/)：过滤索引与查询优化建议。
5. [Qdrant：FAQ（Logical Separation、Per-tenant Index、Sharding）](https://qdrant.tech/documentation/faq/)：共享 Collection 中的逻辑隔离与更强隔离设计的区别。
6. 项目：[Qdrant Store](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)、[知识库搜索 API](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/app/api/knowledge/%5Bid%5D/search/route.ts)、[KnowledgeExecutor](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/executors/knowledge-executor.ts)、[document-processor.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts)。

---

### 【3.2 妙码 AI Flow 文本检索源码与 BM25 改造】

*原讨论问题：妙码 AI Flow 当前文本检索的实现、与 BM25 的区别以及改造方案*


#### 【问题背景与结论】

上一题已经理解：BM25 借助词项、TF/DF/IDF、文档长度与倒排索引快速找到相关 Chunk；Dense Search 则依据 Embedding 向量进行语义近邻检索。现在回到项目源码回答三个实际工程问题：**当前所谓“全文/关键词检索”到底如何执行？它和真正的 BM25 差在哪里？如果用现有 Qdrant 引入 BM25，应该调整哪些代码与数据结构？**

**结论先行**：

1. 妙码 AI Flow **有 Dense 向量检索和两个 Payload Keyword 过滤索引，但没有为正文构建真正的全文倒排索引，也没有实现标准 BM25**。
2. 当前全文分支的实现是：`Qdrant scroll` 读取满足 `knowledgeBaseId` 过滤的一批 Point，Node.js 在返回的 `content` 中执行字符串子串匹配与自定义评分，再从这批结果排序得到 Top-K。该批次仅调用一次、上限为 1000 个 Point，**不保证覆盖同一知识库所有 Chunk**。
3. 项目已经有 `HybridRetriever` 与加权 RRF 的编排能力。改造重点应放在**离线增加 BM25 Sparse 表示、持久化 Sparse Index、在线把旧 `textSearch()` 替换为真正的 BM25 检索**；第一阶段可以复用原应用层 RRF。
4. 当前 Docker Compose 部署的是自建 Qdrant（`qdrant/qdrant:latest`），**不能直接照搬 Qdrant Cloud/Cluster 服务端 `qdrant/bm25` 推理代码并当成当前环境必然可运行**。自建部署优先确认客户端/独立服务生成 Sparse Vector 的可行性，或经实际测试证明服务器推理能力存在后再启用相应 API。Qdrant 的官方推理选择指南明确区分这两种部署方案。

为帮助理解，下文先重建源码调用链，再对照 BM25 的处理链，最后按模块给出可实施但**尚未写入项目代码、尚未运行验证**的方案。

#### 【业务上下文：两个入口共用同一个检索器，但分别组装 Provider】

**入口一：用户在知识库管理页面发起搜索。**

源码：[`apps/workflow/app/api/knowledge/[id]/search/route.ts`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/app/api/knowledge/%5Bid%5D/search/route.ts)。

该 API 首先识别用户并核对知识库归属，再解析 `query/topK/threshold/mode`，初始化 Ollama Embedding Service、QdrantVectorStore 和 FulltextSearchProvider。Provider 不直接查询独立文本索引，而是调用 `(vectorStore as any).textSearch()`。最后由 `createHybridRetriever(...)` 创建检索器，执行 `retriever.retrieve()`，把有序 Chunk 和执行时长返回页面。

**入口二：工作流中的“知识库”节点。**

源码：[`packages/ai-engine/src/nodes/executors/knowledge-executor.ts`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/executors/knowledge-executor.ts)。

该执行器解析 `knowledgeBaseIds`、Query、模式和 Top-K，创建自己的全文检索 Provider，同样调用 `vectorStore.textSearch()`，随后由 `HybridRetriever` 返回结果，并将它们整理成工作流输出 `output/results/count/query/mode`。

因此两处都需要调整 Provider，**只修改 API 会造成页面与工作流结果不一致**。知识库执行器自身虽然接受知识库 ID 数组，但不能仅据此证明该执行入口已经做了与 API 相同的最终用户权限校验；改造不得弱化或越过调用链上的授权边界。

#### 【离线入库：存储了正文，并不等于对正文建立关键词检索索引】

源码：[`apps/workflow/lib/services/document-processor.ts`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts) 与 [`QdrantVectorStore`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)。

实际执行：

~~~text
上传/解析后的 Document Content
       ↓
按 Markdown/普通文本选择 Text Splitter
       ↓
chunks = splitter.split(content)
       ↓
Ollama Embedding：embedTexts(chunkTexts)
       ↓
生成 ChunkWithVector：{id, content, documentId, knowledgeBaseId, vector, ...}
       ↓
ensureCollection(dimensions)
       ↓
upsertVectors(vectorChunks)
       ↓
Qdrant Point：
  - 未命名 Dense Vector（Cosine）
  - Payload：chunkId、documentId、knowledgeBaseId、content、chunkIndex、...
~~~

`ensureCollection()` 为已经存在的 Collection 直接返回；创建新 Collection 时配置：

~~~typescript
vectors: {
  size: dimensions,
  distance: 'Cosine',
}
~~~

并分别执行：

~~~typescript
createPayloadIndex(collectionName, {
  field_name: 'knowledgeBaseId',
  field_schema: 'keyword',
});
createPayloadIndex(collectionName, {
  field_name: 'documentId',
  field_schema: 'keyword',
});
~~~

这里 `keyword` 的含义是**字段值的精确过滤索引**：

~~~text
knowledgeBaseId = kb-001 → 找到归属 kb-001 的 Point
documentId = doc-008    → 找到归属 doc-008 的 Point
~~~

它不是对 `payload.content` 建立的中文分词倒排表，也不用于按 BM25 对正文排序。

**概念边界**：

- `keyword Payload Index`：结构化字段过滤。
- `full-text Payload Index`：按词项进行文本条件过滤；单纯过滤不等于 BM25 排序。
- `BM25 Sparse Vector Index`：索引稀疏词项维度并使用 BM25 权重计算检索相关性。

Qdrant 目前支持这几种不同能力，但**项目仅使用了第一种和 Dense 向量索引**。

#### 【在线全文检索：scroll 后在 Node.js 逐个扫描】

源码：[`QdrantVectorStore.textSearch()`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)。

**第一步：按知识库 ID 过滤并读取一批 Chunk**：

~~~typescript
const response = await this.client.scroll(this.collectionName, {
  filter: {
    must: [{
      key: 'knowledgeBaseId',
      match: { any: knowledgeBaseIds },
    }],
  },
  limit: 1000,
  with_payload: true,
  with_vector: false,
});
~~~

上游 `knowledgeBaseIds` 是 Retriever 调用输入，应由可信的业务权限检查和范围决策得到；Qdrant 在此按字段索引过滤。`with_payload: true` 表示返回正文等 Metadata；`with_vector: false` 不要求返回稠密向量。

**本步不使用查询正文匹配的倒排索引**，仅根据 `knowledgeBaseId` 返回一批 Point。`scroll(limit:1000)` 没有使用 `next_page_offset` 再取下一页，因此不能假设本次搜索已经扫描某知识库的全部 Chunk。即使正确文档已经存在，只要不在这批结果里，后面就无从命中。

**第二步：对 Query 进行字符串拆分**：

~~~typescript
const queryLower = query.toLowerCase();
const queryTerms = queryLower
  .split(/[\s,，。.!！?？;；:：、]+/)
  .filter(term => term.length > 0);
~~~

这只是**按空格和标点拆开文本**，不是通常意义上的中文词法分析。教学反例：

~~~text
用户输入：数据库连接池为什么耗尽？

当前逻辑可能只得到：
["数据库连接池为什么耗尽"]

而不会天然得到：
["数据库", "连接池", "耗尽"]
~~~

由于通常以子串而非真正 Token 匹配，中文常见连续句子难以有效利用多个有区分度的查询词项。

**第三步：对每个候选正文执行包含判断和频次评分**：

~~~typescript
if (contentLower.includes(queryLower)) {
  matchScore += 2;
}

for (const term of queryTerms) {
  if (contentLower.includes(term)) {
    matchedTerms++;

    const regex = new RegExp(term, 'gi');
    const matches = content.match(regex);
    matchScore += matches ? matches.length * 0.5 : 0;
  }
}
~~~

若至少存在一个匹配，还会加上：

~~~typescript
matchScore +=
  (matchedTerms / Math.max(queryTerms.length, 1)) * 1.5;
~~~

**评分的实际含义**：完整 Query 子串命中加 2、分隔得到的 term 每次正则命中乘 0.5、命中词项占比再奖励。没有 IDF、标准 BM25 的词频饱和与文档长度归一化，也没有通过倒排列表先定位匹配文档。

**第四步：排序、截断和归一化**：

~~~typescript
matchedResults.sort((a, b) => b.matchScore - a.matchScore);
const maxScore = matchedResults[0]?.matchScore || 1;

return matchedResults.slice(0, topK).map(({ result, matchScore }) => ({
  ...result,
  score: matchScore / maxScore,
}));
~~~

因此得分是**这一批候选内部相对最高分的归一化结果**，并非跨 Query 具有统一解释的相关性或 BM25 分数。变化这批 Point 就可能变化归一化结果，不能把 `score=0.9` 当作“有 90% 概率是正确证据”。

**边界与缺陷**：直接 `new RegExp(term, 'gi')` 未对用户提供的词项做正则转义；输入若包含 `.`、`[`、`(` 等正则元字符，可能改变匹配语义或触发正则解析异常。这是独立于是否引入 BM25 的当前实现风险。

#### 【与标准 BM25 的主要差异：索引结构和运行成本比公式更关键】

| 对比项 | 当前 `textSearch()` | 传统 BM25 或 Qdrant BM25 Sparse |
|---|---|---|
| 离线词项处理 | 仅 Chunking 与 Dense Embedding | 对 Chunk 产生与 Query 兼容的词项/稀疏表示 |
| 词项索引 | 无正文倒排索引 | 词项或稀疏维度 → 包含它的 Chunk/Point |
| 候选发现 | 查询时先 `scroll` 一批 Payload | 通过倒排式索引找到含查询词项的候选 |
| TF | 自定义子串出现次数加分 | BM25 的词频饱和贡献 |
| DF/IDF | 未使用 | 通过语料文档频率区分常见词和稀有词 |
| 文档长度 | 未归一化 | BM25 按文档长度与平均长度调整 |
| 词项分析 | 正则按空格/标点拆分 | Tokenizer、词项规范化、中文/编号专门配置 |
| 持久化索引 | Qdrant 只持久化 Dense 与过滤索引 | Qdrant 同时维护 Sparse Vector 与相应索引 |
| 语料规模影响 | 一次获取最多 1000 个 Point 后 JS 扫描 | 利用检索索引定位词项对应的 Point |
| Score 含义 | 自定义匹配分与本批归一化 | 与特定 Query 相关的 BM25/稀疏检索分数 |

最关键的区别是：

~~~text
当前：
  Query → 按 knowledgeBaseId 取一批 Chunk → 逐条检查字符串 → 自定义分数 Top-K

BM25：
  文档离线产生词项和倒排式索引
  Query → 词项映射 → Posting 候选 → BM25 相关性评分 → Top-K
~~~

**不能只给当前 JS 循环加上一段 BM25 评分公式就认为完成了改造**。如果依然从有限的前 1000 个 Point 里计算分数，未进入此批次的正确证据依旧永远找不到。真正解决候选发现与规模化检索问题，需要替换数据组织和索引查询方式。

#### 【现有 HybridRetriever 如何把文本候选与 Dense 结果融合】

源码：[`packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)。

`retrieve()` 接收 `mode: vector | fulltext | hybrid`，分别选择：

- `vector`：Query 经 Ollama Embedding → Qdrant Vector Search → 带 Score 的有序 Chunk；
- `fulltext`：调用传入的 `FulltextSearchProvider.search()` → 当前应用层 `textSearch()`；
- `hybrid`：将 `topK` 扩大为 `ceil(topK × 1.5)`，并行执行前两路，再用 `reciprocalRankFusion()` 进行融合，截取最终 Top-K。

当前加权 RRF 使用 `k=60` 和默认向量权重 `vectorWeight=0.7`：

~~~text
RRF(d)
  = vectorWeight / (60 + denseRank(d))
  + (1 - vectorWeight) / (60 + textRank(d))

缺失于某一路的候选，该路贡献为 0。
~~~

源码按 `chunkId` 合并重复候选，把原始 Score 替换为融合 Score；如果全文检索结果为空，则直接退化成向量结果。

**因此当前可复用的能力是“检索模式控制 + 两路异步调用 + 候选去重融合”**；升级 BM25 的第一阶段无需强制重写 RRF，但要保证真实 BM25 通道返回的 Chunk ID、文档信息与现有类型兼容。RRF 的公式、权重与逐条计算在下一题单独展开。

#### 【建议改造目标：让同一 Chunk 拥有 Dense 与 BM25 两种表示】

本项目已有 Qdrant、Ollama Embedding 与 RRF，可以优先引入 Qdrant 的 BM25 Sparse Vector，暂不增加 Elasticsearch 这一独立基础设施。建议目标：

~~~text
离线入库：
Document → Chunking
                ├─ Ollama Dense Embedding ─────→ dense 表示
                └─ BM25 Tokenizer/Sparse 生成 ─→ bm25 表示
                                                 ↓
                                    Qdrant 持久化 Point + 双索引
                                      Payload：chunkId/documentId/
                                               knowledgeBaseId/content

在线查询：
Query ──→ Dense Query Embedding ──→ Dense Search ─┐
      └─→ BM25 Sparse Query ──────→ BM25 Search ──┤
                                                   ▼
                                         现有 HybridRetriever
                                            RRF → Final Top-K
                                                   ↓
                                             工作流 / LLM
~~~

注意：**同一 Point 可以存多种向量，但必须把新字段值实际写入每个 Point**；仅为 Collection 增加 `sparse_vectors` Schema 不会自动从现有 Payload 正文构建 BM25 Sparse 值。Qdrant 官方对现有 Collection 的命名向量扩展也明确了这一点。

#### 【改造步骤一：Qdrant Collection 的向量 Schema】

建议对于首次验证创建一个新 Collection（例如 `knowledge_chunks_v2`），可与旧 Collection 并存以保证回滚。**以下为目标配置示例，不是当前已执行代码**：

~~~typescript
await client.createCollection("knowledge_chunks_v2", {
  vectors: {
    dense: { size: dimensions, distance: "Cosine" },
  },
  sparse_vectors: {
    bm25: { modifier: "idf" },
  },
});
~~~

这里 `dense` 和 `bm25` 是命名向量：Dense 使用业务 Ollama 模型的维度，Sparse 使用倒排式索引并通过 `modifier:"idf"` 引入词项文档频率信号。同一个 Point 保留现有 `chunkId/documentId/knowledgeBaseId/content` Payload，也应在新 Collection 为 `knowledgeBaseId`、`documentId` 建立必要的 Keyword 过滤索引。

**重要兼容点**：项目旧 Collection 使用的是**未命名** Dense Vector（配置为 `vectors: {size, distance}`），而不是 `dense`。切换到新 Collection 的 `dense` 字段后，所有旧的向量搜索调用必须显式使用该向量名，不能仅换一个 Collection 名称而仍使用旧 API 的未命名搜索约定。

另一个可选方案：若实际自建 Qdrant Server >=1.18，官方提供 `createVectorName(...)` 或 REST `PUT /collections/{collection}/vectors/{name}` 为**现有 Collection** 添加 Sparse 命名向量 Schema，再为已有 Point 补录 Sparse 值；原未命名 Dense 仍需按实际兼容情况测试。参见 [Qdrant Collections — Update Vector Schema](https://qdrant.tech/documentation/manage-data/collections/)。

两种方案的工程取舍：

| 方案 | 优点 | 需要重点防范 |
|---|---|---|
| 原 Collection 增加 Sparse 字段并补录（适用版本需确认） | 复用已有 Point 和 Dense 表示，降低搬迁量 | 与在线写入竞争、补录中数据不完整、版本/API 兼容 |
| 新 `knowledge_chunks_v2` 并行迁移（更适合首次验证） | 双版本对照和回滚明确，可独立验收 | 双倍暂存成本、增量数据同步与切换一致性 |

#### 【改造步骤二：离线 Chunk 生成 BM25 Sparse 表示】

现有 [`processDocument()`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts) 只运行：

~~~text
splitter.split(content)
  → embeddingService.embedTexts(chunkTexts)
  → ChunkWithVector[]
  → vectorStore.upsertVectors()
~~~

应使 Chunk 经过两条独立表示链：

~~~text
chunk.content
   ├─ embedText / embedTexts（原 Ollama 模型）→ dense: number[]
   └─ BM25 Tokenizer + 参数策略              → sparse: {indices, values}
                                                        ↓
                                             Qdrant 同一 Point
~~~

**部署与能力边界必须特别说明**：

- 项目 Docker Compose 使用 `qdrant/qdrant:latest`，表示自建 Qdrant 容器，当前运行版本需从实际容器或服务端版本接口确认。仓库使用的 `@qdrant/js-client-rest` 声明为 `^1.16.2`，既有联调手册记录过一次本地 Server 为 1.19.0，**不能把历史测试记录当作当前正在运行的服务版本**。
- Qdrant 官方 [Inference](https://qdrant.tech/documentation/inference/) 将“自建 Qdrant”列为优先使用 **Client-side Inference（如 Python FastEmbed）** 的情形，而直接以 `{text, model:"qdrant/bm25"}` 请求服务端推理的说明面向相应支持该能力的 Qdrant Cluster/Cloud 方案。不能仅因为数据库**能存储 Sparse Vector**就假定当前 Docker Server 必然会处理原始文本的 `qdrant/bm25` 推理请求。
- 对现有 TypeScript 工作流，实际选择可以是：独立 Python FastEmbed 处理进程/服务生成 `indices/values`；或引入并验证兼容的 TypeScript/Node 稀疏 BM25 编码实现。两者都必须固定分词器版本、中文词项处理、ID 映射和 BM25 参数，确保离线与在线完全兼容。
- 如果将来验证部署环境确实支持 Qdrant 服务端 BM25 推理，则可直接提交原始文本与模型名；此时应核对 `model`、`tokenizer` 选项与 JS SDK/Server 版本，并用真实自建实例联调后再写成可运行代码，而非把云文档示例当成本地现状。

**客户端生成 BM25 Sparse 的目标数据结构**：

~~~typescript
type SparseVector = {
  indices: number[]  // 词项映射得到的非零维度
  values: number[]   // BM25 文档侧的权重
};

type ChunkWithHybridVectors = {
  id: string;
  content: string;
  documentId: string;
  knowledgeBaseId: string;
  dense: number[];
  bm25: SparseVector;
};
~~~

使用客户端生成方案时，向 Qdrant 写入 Point 的结构可表示为：

~~~typescript
// 目标结构示意；encoder 是拟新增的 BM25 编码组件，非现有实现。
const point = {
  id: pointId,
  vector: {
    dense: denseEmbedding,
    bm25: await bm25Encoder.encodeDocument(chunk.content),
  },
  payload: {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    knowledgeBaseId: chunk.knowledgeBaseId,
    content: chunk.content,
    chunkIndex: chunk.index,
  },
};
~~~

**不是必须同时为同一 Chunk 再建一张 SQL 关键词表**。Qdrant 会管理稀疏向量、维度对应的索引和与其配置兼容的 IDF 修正；Embedding 和 BM25 编码负责提供可检索的表示，而不是自己实现物理倒排表。

#### 【改造步骤三：在线使用 BM25 Sparse Index，而不是 scroll 正文】

旧链路：

~~~text
textSearch()
  → scroll(limit:1000, with_payload:true)
  → JS includes() / RegExp 匹配
  → 自定义 Score 排序
~~~

目标新链路：

~~~text
bm25Search()
  → Query 使用与入库相同的 BM25 Tokenizer/编码器
  → 根据 sparse indices/values 查询 Qdrant 的 bm25 命名向量
  → 按合法 knowledgeBaseIds 过滤
  → 返回 BM25 排序后的 Top-K Chunk
~~~

**自建环境的推荐实现草案**，展示 API 职责；假定编码器已按相同词项映射和权重规则实现并通过测试：

~~~typescript
// 提案伪代码：encoder、collection、client 版本都需真实项目联调。
async function bm25Search(
  query: string,
  knowledgeBaseIds: string[],
  topK: number,
) {
  const sparseQuery = await bm25Encoder.encodeQuery(query);

  const result = await client.query("knowledge_chunks_v2", {
    using: "bm25",
    query: sparseQuery, // {indices, values}；需与当前 JS SDK 类型兼容
    filter: {
      must: [{
        key: "knowledgeBaseId",
        match: {any: knowledgeBaseIds},
      }],
    },
    limit: topK,
    with_payload: true,
  });

  // 将 result.points 映射回 RetrievalResult[]；
  // 注意源 metadata / chunkId / documentId / score 的统一处理。
  return result.points;
}
~~~

在**经验证确实支持原生 BM25 文本推理**的部署环境下，也可以把 `query` 改成 `{text: query, model:"qdrant/bm25", options:{tokenizer:"multilingual"}}`，并设置 `using:"bm25"`。这是**另一条有部署前提的实现路径**，不是当前自建实例可直接保证运行的代码。

可参考 [Qdrant Full-Text Search](https://qdrant.tech/documentation/search/text-search/full-text-search/) 与 [Qdrant Sparse Vectors](https://qdrant.tech/documentation/manage-data/vectors/)。

原有 `knowledgeBaseIds` 范围过滤必须保留；若同一 Collection 存储多租户知识，BM25 的 IDF 统计范围与 Query 结果过滤范围并不天然相同。使用 Qdrant 支持的 per-tenant IDF 统计或隔离策略前，需要核对版本和统计语义，不能把授权过滤误当作自动的租户隔离 IDF。参考 [Qdrant Multitenancy](https://qdrant.tech/documentation/tutorials/multiple-partitions/)。

#### 【改造步骤四：复用 HybridRetriever，统一两个业务入口】

**优先采用最小改动**：保留 `HybridRetriever.retrieve()`、`vector/fulltext/hybrid` 三模式及 `reciprocalRankFusion()`，只替换 `FulltextSearchProvider.search()` 的底层实现。

~~~text
改造前：
HybridRetriever
  ├─ vectorSearch()   → Dense Qdrant Search
  └─ fulltextSearch() → scroll + Node.js 子串匹配
                             ↓
                           RRF

改造后：
HybridRetriever
  ├─ vectorSearch()   → Dense Qdrant Search
  └─ fulltextSearch() → BM25 Sparse Qdrant Search
                             ↓
                           RRF
~~~

必须处理的接口及代码位置：

| 文件 | 预期修改 |
|---|---|
| `packages/ai-engine/src/knowledge/types.ts` | 定义 `SparseVector`、`bm25Search` 或 `LexicalSearchProvider` 契约，避免 `as any` |
| `packages/ai-engine/src/knowledge/store/qdrant-store.ts` | Collection 多向量配置；Hybrid Point 写入；BM25 查询及查询结果映射 |
| `apps/workflow/lib/services/document-processor.ts` | 文档入库时生成或获取 BM25 Sparse 表示，重新入库和删除时维护一致性 |
| `apps/workflow/app/api/knowledge/[id]/search/route.ts` | 把页面 `fulltextProvider` 改为真实 BM25 检索 |
| `packages/ai-engine/src/nodes/executors/knowledge-executor.ts` | 同步修改工作流知识节点的 Provider，维持授权边界与可观测性 |
| `packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts` | 第一阶段保留 RRF；根据真实两路召回测试再确定是否修改候选深度/权重 |
| 测试/迁移脚本与部署配置 | 固定 Qdrant/Client 与编码器版本，补录旧 Point 并做完整回归测试 |

**关于阈值和 Score**：原 `threshold` 用于 Dense 相似度检索，不能自动沿用为 BM25 的得分阈值，因为两种 Score 不同尺度。现有应用层加权 RRF 以排名为输入而非直接相加两路 Score，因此第一阶段可以复用，但替换了文本检索算法后，融合顺序仍需要由 Ground Truth 实验验证。

#### 【历史数据迁移与回滚】

不能只改 `ensureCollection()` 配置然后宣布历史数据都已具备 BM25。旧 Point 存的是 Dense 与 Payload；必须为每个历史 Chunk 提供 BM25 表示。

**方案 A：原 Collection 扩字段**。实际 Server 若支持 Qdrant v1.18+ 的动态向量 Schema，可添加 `bm25` 命名 Sparse Vector 并补写旧 Point 的值；需要测试现有未命名 Dense 表示与新 Sparse 命名字段的兼容性，并在补录期间控制检索结果不一致风险。适合变更窗口、版本与数据量均可控的情况。

**方案 B：新 Collection 蓝绿迁移（建议首次实验使用）**。创建 `knowledge_chunks_v2`，迁移既有 Chunk ID、Payload、Dense Vector，为每个 Point 增加 BM25 Sparse，建立过滤索引；独立验证数量、Chunk 完整性、查询结果与权限；同时处理迁移期间新写入/更新/删除的同步问题，通过受控切换把 API 和工作流两入口统一指向新集合，保留回滚路径。

如使用 `upsert()` 全量更新原有 Point，必须验证新的 Vector/Payload 组合不会意外覆盖或丢失旧字段；仅补写向量可优先查验对应的 `updateVectors` 等增量 API 并选择适配当前 Server 的操作。**不要默认“新增 Sparse 字段”能够自动从既有 Payload 反向生成向量值。**

#### 【验证方案：证明升级比当前实现更好】

不要把“BM25 API 能返回结果”当完整验收。建议沿这条链路验证：

1. **环境兼容**：确认运行中的 Qdrant Server 版本与 `@qdrant/js-client-rest` 的实际解析版本；固定 Docker 镜像，不再依赖 `latest`；验证部署中的 BM25 Sparse 生成方式。
2. **数据覆盖**：确保现有全部 Chunk 已持有 Sparse，检验超出旧 `scroll(limit:1000)` 范围的正确文档仍能被 BM25 召回；计数与正文、文档身份映射一致。
3. **语言与标识符**：中文无空格查询、技术缩写、故障编号、精确 SKU、否定/条件词；测试词项分析器是否导致编号被错误拆分。
4. **权限与一致性**：检索结果只能来自已授权知识库；增量上传、更新、删除和迁移切换都同步维护 Dense 与 Sparse，不让旧版本文档残留。
5. **指标对照**：固定 Qrels/语料/Query/权限，对比当前 `textSearch`、Dense、标准 BM25、Dense+BM25+RRF 的 Evidence Recall@K、MRR/nDCG、无答案误召回、P95 延迟与运行成本。
6. **质量可归因**：按同义表达、专业编号、多证据、条件/否定等查询类别单独分析收益与退化；对融合前、融合后有序候选保存必要的 Trace，防止平均分掩盖特定场景失败。
7. **部署与回滚**：保持新旧 Collection/入口的切换策略、迁移幂等、索引补录进度和失败恢复方案；验证原检索模式可以在出现异常时恢复。

#### 【面试标准回答】

妙码 AI Flow 当前通过 Qdrant 存储 Dense 向量及 Chunk 正文，对 `knowledgeBaseId` 和 `documentId` 建立 `keyword` Payload Index，用于权限范围或文档定位；它没有为正文建立 BM25 倒排索引。现有 `textSearch()` 在查询时一次 `scroll` 最多 1000 个 Point，在 Node.js 中对 Query 按标点/空格拆分、执行子串匹配和出现次数打分，再取 Top-K，因此既缺少规范 TF/IDF/长度归一化，也存在语料扫描覆盖上限和中文分词不足的问题。

改造应从数据与查询两端同时进行：在 Qdrant 中配置 BM25 Sparse Vector 字段，为每个 Chunk 在入库阶段产生兼容的 Sparse 表示；在线由 Query 编码为 BM25 Sparse 后直接查询 Sparse Index，而不是扫描 Payload。原有 `HybridRetriever` 的加权 RRF 可以先复用，将两个业务入口的 `FulltextSearchProvider` 同时替换为真实 BM25 检索，并在固定 Ground Truth 下检验召回、排序、时延和成本。

由于项目采用自建 Docker Qdrant，还必须验证 Qdrant Server/Client 版本与推理部署条件；官方面向支持服务端文本推理的 `qdrant/bm25` 请求不能不经验证就当成本地可用。对现有数据选择新增 Sparse 字段并补录，或建立新 Collection 蓝绿迁移，最终保证历史与增量数据都拥有完整的 Dense/Sparse 表示。

#### 【参考文档与本项目证据】

1. [Qdrant Collections：Update Vector Schema](https://qdrant.tech/documentation/manage-data/collections/)：Qdrant v1.18 起为现有 Collection 新增命名 Dense/Sparse Vector，已有 Point 需要补录实际向量值。
2. [Qdrant Inference：Choose Your Approach](https://qdrant.tech/documentation/inference/)：自建环境优先通过客户端或 FastEmbed 管理 Sparse 生成；服务端 `qdrant/bm25` 推理有部署差异。
3. [Qdrant BM25 Sparse Inference](https://qdrant.tech/documentation/inference/inference-bm25/)：具备相应推理能力的实例通过模型名生成 BM25 Sparse Vector。
4. [Qdrant Full-Text Search](https://qdrant.tech/documentation/search/text-search/full-text-search/)：包括 BM25、`multilingual` Tokenizer、Query API 的搜索调用。
5. [Qdrant Sparse Vectors](https://qdrant.tech/documentation/manage-data/vectors/)：同 Point 命名 Dense/Sparse、`indices/values` 与稀疏存储。
6. [Qdrant Hybrid Search](https://qdrant.tech/documentation/search-tuning/hybrid-search/)：BM25 通道、候选深度与 RRF 的工程权衡。
7. [Qdrant Multitenancy and IDF Scope](https://qdrant.tech/documentation/tutorials/multiple-partitions/)：稀疏 IDF 的统计范围与 Filter 的差异。
8. [妙码 AI Flow：Qdrant Store](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)、[文档处理](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts)、[HybridRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)、[检索 API](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/app/api/knowledge/%5Bid%5D/search/route.ts)、[KnowledgeExecutor](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/executors/knowledge-executor.ts)、[Docker Compose](https://github.com/cxDlogver/miaoma-aiflow/blob/main/docker/docker-compose.yml)。

---

## 【四、多路候选融合与语义重排序】

**通用机制衔接：** [RRF 与 Cross-Encoder Rerank](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/R-RAG混合检索过滤融合与重排序完整知识体系.md) 逐步推导相应算法、数据结构、执行过程与验证边界；本章节继续保留 AI Flow 的全部具体源码、数据案例、工程问题和方案，不以通用正文替代项目分析。

候选来自不同检索通道后，需要先解决分数不可直接比较的问题，再判断融合排序是否真正理解证据与问题的关系，循序展开 RRF、Bi-Encoder 和 Cross-Encoder Rerank。

### 【4.1 RRF 排名融合、加权计算与源码实现】

*原讨论问题：RRF 如何融合不同检索通道的排序，以及它与 Rerank 有什么区别*


#### 【问题背景：多路检索的分数不能直接相加】

前一题已经明确，Dense Search 利用 Embedding 语义相似度查找候选，BM25 利用词项统计和倒排索引查找候选；妙码 AI Flow 目前第二路仍是应用层字符串匹配，而不是标准 BM25。

无论第二路具体采用 BM25 还是当前的 Fulltext Provider，只要两路都返回了有序候选，就需要回答：

1. 两套原始 Score 的数值范围和语义不同，如何得到一个共同排序？
2. 同一 Chunk 同时出现在两路结果里，如何合并并利用双路共识？
3. 当两路意见冲突时，排名、权重和候选深度分别如何影响结果？
4. 哪些能力可以由 RRF 解决，哪些必须交给检索器本身或语义 Rerank？

例如同一 Query 的教学检索数据：

| 名次 | Dense Search | BM25 Search（假设已实现） |
|---:|---|---|
| 1 | D2；Cosine = 0.92 | D1；BM25 = 18.6 |
| 2 | D3；Cosine = 0.89 | D2；BM25 = 12.4 |
| 3 | D1；Cosine = 0.85 | D4；BM25 = 8.1 |
| 4 | D4；Cosine = 0.79 | D5；BM25 = 6.3 |

Query 是“E-1042 故障如何处理？”，D1 含目标故障编号，假设人工正确证据是 D1。当前两路分别产生不同排序：语义接近可能使 D2、D3 靠前，而词项匹配可能使 D1 排前。**这是教学示例，不代表项目实际 BM25 输出，也不代表 RRF 必然会将 D1 排第一。**

不能无条件简单加分：

~~~text
Dense(D1) = 0.85
BM25(D1) = 18.6
RawSum(D1) = 19.45
~~~

BM25 与 Cosine 的来源、数值尺度和统计意义不同。直接相加可能因 BM25 数值量级较大而支配合并得分。即使把两路分数都变到 0～1，也需要核查归一化范围、分布漂移与跨 Query 可比性，而不是简单认为量纲已经完全相同。

#### 【知识概述：RRF 用排名代替原始分数】

RRF（Reciprocal Rank Fusion，倒数排名融合）不直接比较 Dense 与 BM25 的原始 Score，而只使用**候选在每一路排序中的位置**，将倒数贡献累加为融合分数。

常见形式：

~~~text
RRF(d) = Σ 1 / (k + rank_i(d))
         i=1..m
~~~

- `d`：当前候选文档或 Chunk，要求合并时使用稳定的身份（如 `chunkId`）；
- `m`：参与融合的检索结果列表数；
- `rank_i(d)`：d 在第 i 路列表中的排名，**从 1 开始**；
- `k`：控制前排与后排名次贡献差距的平滑常数；
- 缺席于第 i 路列表的候选：该路贡献为 0，而不是错误地补一个末位名次。

RRF 结果是**排名融合信号**，不是原始 Cosine Score、BM25 Score，也不是“答案正确的概率”。

##### 【Weighted RRF：妙码 AI Flow 使用了什么公式】

项目的加权变体：

~~~text
Weighted RRF(d)
  = vectorWeight / (k + denseRank(d))
  + fulltextWeight / (k + fulltextRank(d))

fulltextWeight = 1 - vectorWeight
d 缺席的一路不计分
~~~

当前源码常数与默认值：

~~~typescript
const k = 60;
const fulltextWeight = 1 - vectorWeight;
// retrieve() 的默认 vectorWeight = 0.7;
// 因而默认 fulltextWeight = 0.3
~~~

这表示向量排名贡献按系数 0.7 计算，文本排名贡献按 0.3 计算。**不是**要求最终结果 70% 出自 Dense，也不是“该结果正确概率为 70%”；若某个 Chunk 同时位于两路候选中，两路贡献都会累加。

#### 【完整教学手算：合并候选 → 算每路得分 → 最终排序】

使用本节最初的排序，不再需要两路原始 Score：

~~~text
Dense：D2、D3、D1、D4
BM25： D1、D2、D4、D5

最终候选并集：{D1, D2, D3, D4, D5}
~~~

**第一步：将相同身份的候选视为同一个结果。**例如 D1 在 Dense 排第 3，在 BM25 排第 1，不是生成两条 D1，而是将两路贡献计入同一个 D1。

**第二步：逐个计算，使用 k=60、向量权重 0.7、文本权重 0.3。**

对 D1：

~~~text
Dense Rank(D1) = 3
BM25 Rank(D1)  = 1
Score(D1) = 0.7/(60+3) + 0.3/(60+1)
          = 0.011111 + 0.004918
          ≈ 0.016029
~~~

对 D2：

~~~text
Dense Rank(D2) = 1
BM25 Rank(D2)  = 2
Score(D2) = 0.7/(60+1) + 0.3/(60+2)
          ≈ 0.011475 + 0.004839
          ≈ 0.016314
~~~

对仅位于 Dense 第 2 的 D3：

~~~text
Score(D3) = 0.7/(60+2) + 0
          ≈ 0.011290
~~~

两路所有候选的计算结果：

| Chunk | Dense 名次 | 文本名次 | Dense 贡献 | 文本贡献 | RRF Score |
|---|---:|---:|---:|---:|---:|
| D2 | 1 | 2 | 0.011475 | 0.004839 | **0.016314** |
| D1 | 3 | 1 | 0.011111 | 0.004918 | **0.016029** |
| D4 | 4 | 3 | 0.010938 | 0.004762 | **0.015699** |
| D3 | 2 | 无 | 0.011290 | 0 | **0.011290** |
| D5 | 无 | 4 | 0 | 0.004688 | **0.004688** |

**第三步：按最终得分排序**：

~~~text
D2 → D1 → D4 → D3 → D5
~~~

由此可以观察到两个机制：

- **双路共识累积优势**：D4 即便在 Dense 只有第 4、文本第 3，也因两路都包含它而最终超过仅 Dense 第 2 的 D3。
- **通道权重影响冲突结果**：D1 在文本第 1，但 D2 在 Dense 第 1；向量通道权重更高，使 D2 最终仍领先 D1。**RRF 在本例中没有将正确证据 D1 排到第 1**，因此 RRF 不是正确性保证。

#### 【k 为什么通常选择 60，它改变的是什么】

单路名次贡献为：

~~~text
score(rank) = 1/(k + rank)
~~~

当 k 较小时，排名 1 与排名 10 的得分差距相对较大；k 增大时，前几名的贡献相对接近，**同一候选是否被多个检索器都找出来**可能相对更重要，但实际综合结果仍由列表、权重和长度决定。

| Rank | k=1 | k=60 |
|---|---:|---:|
| 1 | 0.500000 | 0.016393 |
| 2 | 0.333333 | 0.016129 |
| 10 | 0.090909 | 0.014286 |

传统 RRF 论文中对 `k=60` 的经验选择，使其成为经常出现的默认示例，但不是任何语料与检索器组合的数学最优值。应使用固定 Ground Truth 比较 `k`、权重、候选深度对 nDCG/MRR、Evidence Recall 与延迟的影响。

**Qdrant 原生参数化 RRF 的差异**：Qdrant 官方当前 [Hybrid Queries](https://qdrant.tech/documentation/search/hybrid-queries/) 文档把原生 RRF 的默认 `k` 描述为 2，并给出

~~~text
score(d) = Σ [ 1 / (k + (rank_in_result / weight) - 1) ]
~~~

其权重作用于排名的有效位置，而妙码 AI Flow 使用的是 `weight / (k + rank)`。两者默认 `k`、权重表达及可能的排序都**不一定相同**。文档解释和代码迁移时要分别标注具体公式/版本，不能把项目源码 `k=60` 直接视为 Qdrant 原生的默认参数。

#### 【源码分析：HybridRetriever.reciprocalRankFusion()】

源码路径：[`packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)。

**上游：`hybridSearch()` 如何确定两路候选规模**

~~~typescript
const expandedTopK = Math.ceil(topK * 1.5);

const [vectorResults, fulltextResults] = await Promise.all([
  this.vectorSearch(query, knowledgeBaseIds, expandedTopK, threshold),
  this.fulltextProvider
    ? this.fulltextSearch(query, knowledgeBaseIds, expandedTopK)
    : Promise.resolve([]),
]);

if (fulltextResults.length === 0) {
  return vectorResults.slice(0, topK);
}
~~~

实际逻辑是：用户指定 `topK=10`，两路均最多请求 15 条候选，再融合得到最终不多于 10 条。候选并集数量不必然等于 30：两路有重复，或者某一路没有足够候选，就会更少。如果文本 Provider 不存在或结果为空，此实现退化为**仅取向量前 K**，不会对这批结果重新做 RRF。

**中间结构：用 `Map<chunkId, {result,score}>` 累加贡献**

~~~typescript
const scoreMap = new Map<
  string,
  { result: RetrievalResult; score: number }
>();

vectorResults.forEach((result, index) => {
  const rrfScore = vectorWeight / (k + index + 1);
  const existing = scoreMap.get(result.chunkId);
  if (existing) {
    existing.score += rrfScore;
  } else {
    scoreMap.set(result.chunkId, { result, score: rrfScore });
  }
});
~~~

`index` 从 0 起算，所以 `index+1` 才是人类定义的第一名；若同一个 Chunk ID 在第二路又出现，应用其相应的文本权重贡献。这里将 Chunk ID 作为跨检索通道的身份键，若一条文档被切分成多个 Chunk，则每个不同 Chunk ID 仍是不同候选，**不是自动做文档级去重**。

文本通道以 `fulltextWeight/(k+index+1)` 执行相同累加。双路映射时保留先插入的 `result` 对象为返回基础对象，替换其 `score`；不会保存原 Dense Score 或 BM25 Score 到另外的明细字段，**若要诊断融合，应额外记录每路原始排名/Score**。

**下游：按累加分排序，再截断**

~~~typescript
return Array.from(scoreMap.values())
  .sort((a, b) => b.score - a.score)
  .map(item => ({ ...item.result, score: item.score }));
~~~

`hybridSearch()` 最后 `fusedResults.slice(0, topK)`。因此即使 Dense Top-15 或文本 Top-15 某处包含正确证据，如果经过融合后排名落在最终 Top-10 之外，最终结果仍会丢失该证据；应分开记录**初始候选 Evidence Recall** 与**最终融合 Top-K 的覆盖**。

**项目事实边界**：当前 Fulltext Provider 仍使用 `QdrantVectorStore.textSearch()` 的 `scroll(limit:1000)` + Node.js 字符串匹配，而不是标准 BM25。RRF 已实现，并不代表第二路已经升级到 Qdrant 原生 BM25 或新增了 Cross-Encoder Reranker。

#### 【RRF 为什么不能替代检索器，也不能替代 Rerank】

**第一，RRF 不改变候选的来源。**若正确 Chunk 同时缺席于 Dense Top-15 与文本 Top-15，RRF 没有它的文本、Score 和 ID，无法产生这一候选。它只能**融合已有候选的排序**。

**第二，RRF 不使用候选实际正文。**它不判断 Query 中“E-1042”和文档中“E-1043”的身份差别，只能利用上游检索器在两路列表中的排序信号。如果某个错误候选在多路都排高，RRF 仍可能把它排在前面。

**第三，RRF 丢弃原始 Score 差值。**例如 Dense 结果 0.96、0.95、0.30，RRF 只看它们分别是第 1、第 2、第 3，而不会感知后两条原始分数差距很大。这有助于消除不同量纲的影响，但也损失了上游置信度形状（注意原 Score 本身也不必然是概率）。

**第四，RRF 的每路质量与候选深度很重要。**项目全文检索当前的 `scroll(limit:1000)` 可能漏掉大量相关片段；盲目给该通道更高权重，不一定提高准确性。`expandedTopK=ceil(1.5*topK)` 也是工程经验值，可通过初始 Recall 与最终 nDCG 的变化验证是否合理。

#### 【RRF 与 Rerank：排序融合和语义重排之间的边界】

| 对比对象 | RRF / Rank Fusion | Cross-Encoder Rerank（常见模型方案） |
|---|---|---|
| 主要输入 | 多路有序 ID/Rank | Query 与候选 Chunk 正文组成的文本对 |
| 排序依据 | 多路检索器排名 | 模型对 Query–Chunk 相关性给出的新分数 |
| 是否读取全文 | 不需要 | 需要 |
| 是否引入模型推理 | 不需要 | 通常需要 |
| 适合的阶段 | Dense/BM25 融合后获得共同候选顺序 | 融合候选的第二阶段精排 |
| 能否发现完全未召回的文档 | 不能 | 对已有候选做重排时也不能 |
| 主要成本 | 极低的列表计算 | 每个候选的模型推理及对应延迟 |

典型（但非必选）的两阶段结构：

~~~text
Query
  ├─ Dense Retrieve → Top-30
  └─ BM25 Retrieve  → Top-30
                ↓
           RRF Fusion
       合并/去重/初步排序
                ↓
          Candidate Top-20
                ↓
        Cross-Encoder Rerank
      Query 与各 Chunk 成对评分
                ↓
             Final Top-5
                ↓
       Context Construction
                ↓
            LLM Generation
~~~

RRF 和 Rerank 都不能“找到从未被上游召回的正确证据”，不过前者整合多个 Rank，后者重新计算文本与 Query 的相关性。实际系统可只使用 Dense、Dense+RRF，或引入 Cross-Encoder，是否值得由评测与成本约束决定。

#### 【验证方案：不要只看最终融合得分】

在相同 Ground Truth/语料/权限/Query 集合下分别执行：

| 方案 | 检验目的 |
|---|---|
| Dense Only | 语义检索基线 |
| 词项检索 Only（现有 Fulltext 或真实 BM25 分别标明） | 词项/文本匹配是否有独立召回价值 |
| Dense + BM25 + Weighted RRF | 两路是否互补，融合后的排序和覆盖是否提高 |
| Dense + BM25 + RRF + Rerank | 额外读取正文和模型推理是否改善精排与最终可用证据 |

建议至少比较：初始候选 Evidence Recall@N、最终 Recall@K、MRR@K、nDCG@K、精确编号/同义/多证据问题的子集表现、P95 时延和推理成本。对不同 `vectorWeight`、`k` 和 `expandedTopK` 分别做参数实验，保留未参与选参的验证 Query 防止过拟合。

**注意相关性口径**：RRF Score 只是融合排序数，不适合作为“答对概率”的阈值；要判断最终答案是否准确，还需要保留进入 LLM 的 Context 并评估 Faithfulness / Answer Correctness。

#### 【面试标准回答】

RRF 是基于候选在多个检索通道中的**排名**进行融合的方法。标准算法对每条候选在第 i 个结果列表中的贡献使用 `1/(k+rank_i)`，累加得到融合分数；缺席某一路时该路贡献为零。同一 Chunk 在多路都出现就可以获得累积得分，有助于不经原始 Score 归一化就组合不同检索器。

妙码 AI Flow 使用加权 RRF：`vectorWeight/(60+denseRank) + (1-vectorWeight)/(60+textRank)`，默认为 0.7/0.3。实现中先把每路候选规模扩大为 `ceil(1.5*topK)`，并行取结果，按 `chunkId` 在 Map 中累计得分，排序后截断最终 Top-K。Score 表示融合排序贡献，不应与 Cosine/BM25 原始相关性分数直接比较。

RRF 的局限是依赖候选召回、忽略原始 Score 间隔、不能判断文本是否真正支持 Query；因此它不是语义 Rerank，也无法找回不在候选池中的正确证据。若需要进一步提高精排，可以在融合之后对有限候选使用 Cross-Encoder Rerank；是否引入及选参必须由 Ground Truth 下的 nDCG、Recall、延迟和成本实测决定。

#### 【权威参考与源码】

1. [Cormack, Clarke & Büttcher (2009), Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)：RRF 原始研究与 k 的经验值。
2. [Qdrant Hybrid Queries](https://qdrant.tech/documentation/search/hybrid-queries/)：原生 RRF 的文档公式、权重和默认 k=2。
3. [Qdrant Hybrid Search](https://qdrant.tech/documentation/search-tuning/hybrid-search/)：稠密和稀疏候选预取、融合与评测。
4. [Sentence Transformers: Retrieve & Re-Rank](https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html)：双编码器候选召回与 Cross-Encoder 精排的分工。
5. 妙码 AI Flow：[HybridRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)、[QdrantVectorStore](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)、[知识节点执行器](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/executors/knowledge-executor.ts)。

---

### 【4.2 Cross-Encoder Rerank 与两阶段检索】

*原讨论问题：Rerank 如何重新判断候选相关性，Cross-Encoder 与 Bi-Encoder 有什么区别*


#### 【提问与知识目标】

前六题已经建立完整的前半段检索体系：Document/Chunking → Dense Vector/HNSW 与 BM25 词项索引 → Ground Truth 和 Recall/MRR/nDCG → 多路候选的 RRF 融合。现在进一步研究：**RRF 已将多路检索结果合成一个排名，为何还要使用 Rerank？如果要让模型直接判断 Query 与 Document 是否相关，为什么不从最开始就对整个知识库使用 Cross-Encoder？**

本题从三个层次理解：

1. **机制**：Bi-Encoder 独立编码并搜索向量近邻；Cross-Encoder 联合阅读 Query 和候选正文，对每个文本对重新评分。
2. **运行**：初始 Retrieval 负责在大规模语料中寻找有限候选，Fusion 合并候选，Rerank 在候选集合内精排；随后 Context Construction 负责组织最终证据。
3. **工程支撑**：结合妙码 AI Flow 的已有检索器，讨论可选 Rerank 接口、分数来源保留、性能与相关性评测，明确项目现有能力与建议改造的边界。

#### 【为什么已经有 RRF，仍然可能需要 Rerank】

RRF 只消费各路检索器输出的**Chunk ID 与排名位置**，通过倒数排名贡献得出最终排序；不需要重新读取 Query 与 Chunk 内容。因此，如果一个错误文档在 Dense 与 BM25 中都排名靠前，它可能获得很高的融合分数，但这不代表它实际能支持用户问题的正确答案。

例子：

~~~text
用户 Query：
E-1042 故障应该如何处理？

D1：
E-1042 为数据库连接池耗尽，需排查连接泄漏并调整连接池参数。

D2：
E-1043 为数据库网络连接超时，应检查网络连通性。
~~~

D1、D2 主题接近，但 E-1042 与 E-1043 在业务上是不同故障编号。假设之前加权 RRF 的结果：

~~~text
RRF Top-5：
1. D2 — E-1043 网络超时
2. D1 — E-1042 连接池耗尽（Ground Truth 正确证据）
3. D4 — 通用故障排查流程
4. D3 — 其他数据库连接异常
5. D5 — 其他处理规范
~~~

RRF 不会拿查询中的“E-1042”与正文中的“E-1043”做模型级的联合推理。**Rerank 的目的**是让候选再次接受与**当前 Query**相关的细粒度文本匹配和语义评分，把更能回答问题的候选提升到前面。

Rerank 不特指 Cross-Encoder 模型：它是一个**重排序阶段/能力**。Cross-Encoder 是常见实现，也可以存在列表式 LLM 评判、轻量打分模型等方法。这里重点讨论最典型的 Cross-Encoder 方案。

#### 【Bi-Encoder：为什么适合第一阶段大规模召回】

Bi-Encoder（双编码器）对 Query 和 Document **分别编码**得到独立向量，再根据向量距离进行检索：

~~~text
离线知识侧：
Document C1 → Encoder → Dense Vector C1
Document C2 → Encoder → Dense Vector C2
Document C3 → Encoder → Dense Vector C3
      ...
               ↓
        Qdrant Dense Vectors
               ↓
        HNSW / ANN Index

在线 Query：
Query → Query Encoder → Query Vector
                              ↓
                        Vector Search
                              ↓
                       Candidate Top-K
~~~

两路可共享模型参数，也可以使用一组面向 Query/Document 的兼容编码器，关键是它们被训练为能映射到**可比较的向量空间**。文档向量离线生成并存储，可在多个 Query 之间复用。

假设知识库存在一百万个 Chunk。文档入库时生成和索引一百万条向量之后，用户每次提问只需编码当前 Query，再通过 ANN 或其他向量近邻搜索取一个相对较小的候选集。**用户每问一次不需要重新执行一百万个 Query-Document 联合模型推理**。

因此 Bi-Encoder 重点优化的是**大规模候选发现的效率与初始覆盖**。但由于 Query 与候选在编码阶段并未联合处理，单一向量通常压缩了大量细节，对错误编号、复杂否定、长距离条件、数值差异或需要逐条对照的匹配，不能天然保证业务正确性。HNSW 只能加速相似向量的近邻搜索，不会修复向量表示本身遗漏的事实。

#### 【Cross-Encoder：Query 和 Document 一起输入模型意味着什么】

Cross-Encoder（交叉编码器）将 Query 与**某一条候选正文**拼成一个文本对，共同输入 Transformer Encoder，输出该 Query–Document 配对的相关性 Score。

假设：

~~~text
Input Pair A：
Query：E-1042 故障应该如何处理？
Document：E-1042 为数据库连接池耗尽，应排查连接泄漏……

Cross-Encoder → Relevance Score = 2.8

Input Pair B：
Query：E-1042 故障应该如何处理？
Document：E-1043 为数据库网络连接超时，应检查连通性……

Cross-Encoder → Relevance Score = -1.2
~~~

这里的 `2.8/-1.2` 是**教学示例原始输出**，不能被当作该模型真实预测，更不是概率。不同 Reranker 可能输出未经 Sigmoid 的 Logit，也可能经 Sigmoid 或其他校准变换输出 0～1 分数；排序要遵循该模型的定义。

典型 BERT 形态：

~~~text
[CLS] Query Tokens [SEP] Document Tokens [SEP]
                         ↓
                Token Embedding
                         ↓
             Transformer Encoder
                         ↓
       同一序列中的 Self-Attention
     （Query/Document Token 可以交互）
                         ↓
             Relevance Scoring Head
                         ↓
                    Score(Query,D)
~~~

**术语准确性**：这里不是说传统 BERT Cross-Encoder 必须单独实现一个叫 `Cross-Attention` 的模块；它通常让 Query 与 Document Token 在**联合输入序列的 Self-Attention** 中交互。部分其他架构可能采用不同的注意力与评分机制，但不能将 Cross-Encoder 直接等同“跨注意力层”。

相较于独立 Embedding，联合编码能让模型在本次计算中关注具体 Query 与候选的 Token 对应关系，例如编号是否相同、提问需要的是原因还是处理步骤、候选是否只讨论近似主题、是否存在明显限定词冲突。因此 Cross-Encoder **有机会**比原有 Dense Score/RRF Rank 进行更细粒度判断，但也不是对事实真伪、逻辑或引用正确性的绝对保证。

#### 【Bi-Encoder 与 Cross-Encoder 的关键区别】

| 对比 | Bi-Encoder（典型 Dense Retrieval） | Cross-Encoder（典型 Rerank） |
|---|---|---|
| Query 和 Document 编码方式 | 分别编码，向量空间比较 | 联合输入 Query + Document 文本对 |
| 文档侧结果能否离线复用 | 可以，提前生成向量与索引 | 不能为所有未来 Query 预先缓存通用配对得分 |
| 标准输出 | Query/Document 各自的独立向量 | 针对一对 Query–Document 的相关性分数 |
| HNSW 等向量索引能否直接使用 | 可以 | 典型 Cross-Encoder 不输出适于独立检索的文档嵌入 |
| 大规模搜索 | 适合百万级语料候选召回 | 不宜与全量文档逐对推理 |
| 候选顺序 | 由向量相似度/ANN 排名确定 | 由模型对已有候选的相关性评分重新确定 |
| 主要工程代价 | 文档离线编码、索引及 Query 编码 | 每 Query 的多对文本推理、Token 长度和延迟 |
| 在 RAG 中的常见位置 | Retrieval 第一阶段 | Retrieval/Fusion 之后的第二阶段精排 |

**重要边界**：Cross-Encoder 不能替代**大规模**初始召回，是效率和索引表达的工程判断，并非数学上“完全不能搜索”。若文档集合只有几十条，直接对全部候选运行 Cross-Encoder 也可以；但当语料达百万级时，逐对推理通常不可接受。

#### 【为什么通常需要“两阶段检索”：代价和候选覆盖】

给定一百万条 Chunk、一个新 Query：

~~~text
方案 A：Bi-Encoder Retrieval
  文档向量：离线一次编码、建立索引
  Query：在线编码一次
  ANN：按距离查有限候选
  → Candidate Top-20 / Top-100

方案 B：Cross-Encoder 全库评分
  (Query, Chunk1) → 模型推理
  (Query, Chunk2) → 模型推理
  ...
  (Query, Chunk1000000) → 模型推理
  → 排序全量结果
~~~

Cross-Encoder 即使使用 Batch/GPU 优化，计算仍随每次 Query 需要处理的候选文本对数量与文本长度增长；而 Bi-Encoder 将文档编码开销移到入库阶段，并用索引避免穷举每个文本对。

典型两阶段架构：

~~~text
                      Query
                       │
            ┌──────────┴───────────┐
            ▼                      ▼
       Dense Retrieval        BM25 Retrieval
            │                      │
            └──────────┬───────────┘
                       ▼
                 RRF Fusion
              合并候选 / 去重排序
                       ▼
                 Candidate Top-20
                       ▼
              Cross-Encoder Rerank
        (Query,C1), ... , (Query,C20)
                       ▼
            Sort by Rerank Score
                       ▼
                  Final Top-5
                       ▼
              Context Construction
                       ▼
                  LLM Answer
~~~

**流程的变体**：只有 Dense 时也可直接 Dense → Rerank；只有 BM25 时可 BM25 → Rerank；Rerank 不必须位于 RRF 之后。是否需要这层依赖 Query 类型、初始排序质量及推理成本。

#### 【接着第六题的教学数据，Rerank 如何改变结果】

假设 Query 仍为“E-1042 故障应该如何处理？”，RRF Top-5 为 D2、D1、D4、D3、D5。重新将 Query 与这五条 Chunk 分别配对评分，得到**假设**的模型输出：

| 候选 | 原 RRF Rank | Cross-Encoder 的假设 Score | Rerank 后 |
|---|---:|---:|---:|
| D1：E-1042 连接池故障的处理步骤 | 2 | 3.8 | 1 |
| D2：E-1043 数据库连接超时 | 1 | 1.5 | 2 |
| D4：通用故障排查 | 3 | 0.7 | 3 |
| D3：其他连接异常 | 4 | 0.2 | 4 |
| D5：其他处理规范 | 5 | -0.8 | 5 |

得到新序列：

~~~text
RRF：   D2 → D1 → D4 → D3 → D5
Rerank：D1 → D2 → D4 → D3 → D5
~~~

这说明在给定假设打分下，Rerank 可以使正确的 D1 从第 2 上升到第 1。**但这不是所有 Cross-Encoder 的真实表现保证**，模型是否擅长编号匹配、中文规则与具体项目术语应通过正式 Ground Truth 测试。

还必须区分两个场景：

1. **D1 已在 Candidate Top-20，只是最终 Top-5 没有 D1**：适合尝试 Rerank，让模型在已有候选中挑选更准确的结果。
2. **D1 完全缺席 Candidate Top-20**：无论 Cross-Encoder 对 D1 可能评多少分，这次执行都没有机会计算它，应该先改进初始 Retrieval 或扩大可靠候选覆盖。只增加 Rerank 无法恢复缺席结果。

因此 **Initial Evidence Recall@N 决定第二阶段能够处理的证据范围**；Rerank 的目标是改善候选范围内的最终排名、Precision、MRR、nDCG，以及较小 Top-K 的正确证据覆盖。

#### 【妙码 AI Flow 项目：现有什么、缺什么】

本轮核对的实际源码：

- [`VectorRetriever`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts)：Query 经 Ollama Embedding → Qdrant Vector Search → 映射 Chunk 结果，承担 Dense 候选发现。
- [`HybridRetriever`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)：`vector/fulltext/hybrid` 模式，候选深度 `ceil(topK × 1.5)`，Fulltext 候选与向量结果由加权 RRF 融合，返回最终 `topK`。
- [`QdrantVectorStore`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)：存储和查询 Dense Point，也包含应用层文本匹配 `textSearch()`，目前并非原生 BM25。
- [`RetrievalResult` 与 `RetrieverService` 类型](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/types.ts)：目前提供 `chunkId/documentId/content/score` 等字段；并没有定义每阶段多个来源分数的专门 Trace 类型。
- [知识库搜索 API](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/app/api/knowledge/%5Bid%5D/search/route.ts) 和 [KnowledgeExecutor](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/executors/knowledge-executor.ts) 都可获得 Retriever 返回的候选结果。

**在上述实际检查过的检索模块和业务调用链中，尚未发现实现独立的 Cross-Encoder Rerank 接口、调用与配置**。仓库原有答辩手册也将“增加中文分词、BM25、Reranker”列为后续改进方向。不能把以下设计当作已经上线、跑过评测的项目现状。

#### 【推荐接入方案：可选 Rerank 阶段，避免过早重构检索底座】

第一版建议在既有 `HybridRetriever.retrieve()` 之后增加**可选的 Rerank 能力**，而不是重写 Qdrant 索引或将 Cross-Encoder 插入 Dense 查询计算内部。

~~~text
Existing HybridRetriever.retrieve()
              ↓
     初始/融合候选 Candidate Top-N
              ↓
        [可选] Reranker.rerank()
              ↓
        输出 Rerank Score
              ↓
          Sort / Final Top-K
              ↓
       Context Construction
~~~

可以新增独立接口（**设计草案，不是已实现类型**）：

~~~typescript
type CandidateForRerank = {
  chunkId: string;
  documentId: string;
  content: string;
  originalRank: number;
  retrievalScore?: number;
  fusionScore?: number;
};

type RerankResult = CandidateForRerank & {
  rerankScore: number;
};

interface Reranker {
  rerank(
    query: string,
    candidates: CandidateForRerank[]
  ): Promise<RerankResult[]>;
}
~~~

比“输入候选就覆盖 `score`”更建议的工程约定：

1. **保留候选身份、正文和原文信息**：`chunkId`/`documentId`/`knowledgeBaseId`、引用来源与必要 Metadata；Rerank 不得打破权限与版本过滤结果。
2. **保留不同阶段分数**：`denseScore`、`fulltextScore`、`fusionScore`、`rerankScore` 及初始名次，用于归因、评测和重现排序；勿混称它们是同一种概率。
3. **让 Rerank 可配置**：支持关闭、调节 Candidate Top-N 与 Final Top-K、选择模型/版本、设置超时和故障回退；回退规则不得扩大授权数据范围。
4. **控制上下文长度**：模型的最大输入 Token 数若不足以容纳完整候选，应明确截断策略或分段方案，防止关键规则/否定词恰好在被截掉的后半段。
5. **控制请求成本**：可 Batch 对多个 Query–Document 配对进行推理，限制并行度和 P95 延迟，在模型调用失败时按规定恢复到可信的 RRF 排序。
6. **在同一权限/语料/Query 版本下测试**：新模型适用中文、技术编号和业务术语与否，由固定 Ground Truth 判断；不要只凭通用基准推断项目收益。

模型部署选项可以是自建的 Cross-Encoder 推理服务，或提供 Rerank API 的托管模型；选择时需要验证实际的中文表现、输入长度、并发、成本和数据访问约束。**接口抽象可以先建立，是否真正增加服务由评测增益决定**。

#### 【质量与性能评测：证明 Rerank 提高了哪些指标】

把候选发现与候选排序分开评价：

| 实验方案 | 主要比较点 |
|---|---|
| Dense Only | 语义召回的基础质量 |
| Dense + 词项检索 + RRF | 多路覆盖与融合后的基线（必须注明当前 Fulltext 仍非 BM25） |
| 同一候选集 + Cross-Encoder Rerank | 控制输入 Candidate Top-N，判断模型是否改善排序 |
| 调整 Candidate N 与 Rerank Final K | 初始覆盖、精排质量与延迟的平衡 |

至少记录：

- **Candidate Evidence Recall@N**：初始候选是否已经包含正确证据。这是 Rerank 改善的覆盖前提；
- **Final Recall@K / MRR / nDCG@K**：Rerank 是否把正确证据提升到最终 K 的前排；本例 D1 从第二升第一，改变 MRR，但如果 K=5，初始和最终“是否包含 D1”可能并无差异；
- **按 Query 类型分组**：故障编号/精确术语、同义表达、多事实、条件否定、长 Chunk 等；
- **推理延迟和成本**：P50/P95、候选数、Token 输入量、批处理吞吐/失败率；
- **模型输出稳定性及异常回退**：Rerank Score 不等于正确概率；要在生产部署前评估不同设备、模型版本或超时时的结果变化。

**一个重要评价口径**：同一候选集合、完全没有额外取回任何新证据的纯重排，对于 `K≥N` 的集合级 Evidence Recall 无法提高，因为结果包含的文档集合没有变化；但对更小的最终 K，或者 MRR/nDCG 等排序指标，重排可以改善。不要笼统声称“Rerank 必然提高召回”。

#### 【面试标准回答】

Rerank 是初始检索之后，在已有候选集合内重新计算与 Query 的相关性并调整排序的阶段。常见实现是 Cross-Encoder：将 Query 和候选文档组成文本对共同输入 Transformer，让两段文本在联合编码过程中进行 Token 交互，再输出相关性分数。

Bi-Encoder 独立编码 Query/Document，文档向量可以离线存储，并通过 Qdrant/HNSW 等索引高效查询，因此适合第一阶段大规模召回；Cross-Encoder 对每个 Query–Document 文本对单独计算相关性，更适合有限候选的精细排序，不能像 Bi-Encoder 那样把独立文档向量预先索引用于通用向量近邻搜索。它通常相关性判断更细，但推理量随候选数及文本长度上升。

RRF 与 Rerank 的区别是：RRF 只使用多个检索通道提供的 Rank 做数学融合；Cross-Encoder Rerank 则联合阅读 Query 和每条候选正文并计算新分数。两者都无法恢复初始候选中根本不存在的正确证据，因此工程上应先验证 Candidate Recall，再通过固定 Ground Truth 判断 Rerank 是否改善最终 Top-K 的 MRR、nDCG、证据覆盖及成本。对于妙码 AI Flow，可在现有 HybridRetriever 后设计可选 Reranker，同时记录不同阶段的 Score 和候选身份，避免误把尚未实现的重排模块说成项目已有能力。

#### 【权威资料与源码】

1. [Sentence Transformers：Retrieve & Re-Rank](https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html)：先以 BM25/Bi-Encoder 获得候选，再由 Cross-Encoder 精排的两阶段结构。
2. [Sentence Transformers：Cross-Encoders](https://www.sbert.net/examples/cross_encoder/applications/README.html)：Bi-Encoder 与 Cross-Encoder 的输入、输出、预计算与代价区别。
3. [Sentence Transformers：Reranker Training](https://www.sbert.net/examples/cross_encoder/training/rerankers/README.html)：相关性分数可为 Logit 或经过变换的区间分数，并非统一概率。
4. [Sentence Transformers：Semantic Search](https://www.sbert.net/examples/sentence_transformer/applications/semantic-search/README.html)：双编码器与文档离线向量索引。
5. 项目源码：[VectorRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts)、[HybridRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)、[类型定义](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/types.ts)、[知识库搜索 API](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/app/api/knowledge/%5Bid%5D/search/route.ts)、[KnowledgeExecutor](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/executors/knowledge-executor.ts)。

---

## 【五、Context Construction 与确定性证据组织】

**通用机制衔接：** [预算内证据选择与结构恢复](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/R-RAG上下文构建证据冲突与补检完整知识体系.md) 逐步推导相应算法、数据结构、执行过程与验证边界；本章节继续保留 AI Flow 的全部具体源码、数据案例、工程问题和方案，不以通用正文替代项目分析。

候选已经排好序，仍需决定哪些真实、有效、上下文充足的证据进入模型；先研究 Token Budget、事实覆盖与引用，再区分可以由程序可靠完成的结构处理和无法直接证明的语义充分性。

### 【5.1 最终 Context 的事实覆盖、预算与来源组织】

*原讨论问题：Context Construction 如何组织最终送入 LLM 的证据*


#### 【提问与知识概述】

在 Retrieval、Fusion（RRF）及可选的 Cross-Encoder Rerank 之后，为什么不直接把排名前 K 的 Chunk 拼接成 Prompt？**因为候选排序优化的是单条证据与 Query 的相关性，Context Construction 优化的是有限 Token Budget 内“整组证据是否完整、有效、无明显冗余且可引用”。**

三个产物必须区分：

| 产物 | 它回答什么问题 | 主要评价 |
|---|---|---|
| Retrieved Candidates | 哪些片段可能相关，是否找到了正确证据 | Candidate Evidence Recall@N |
| Reranked Results | 正确证据能否被提升到较前位置 | MRR、nDCG@K |
| Final Context | 模型输入中实际有哪些可用证据 | Final Context Fact Coverage、Token Cost、来源与引用 |

候选里的某条正确事实可能在最终预算选择、截断、去重时消失，所以**候选已召回 ≠ 最终 LLM 真正获得了证据**。

#### 【一个具体案例：排名高不等于事实覆盖完整】

用户 Query：“员工申请年假需要提前多久，由谁审批，试用期是否适用？”

假定某份企业制度的人工标注 Ground Truth 包含：

- F1：提前三个工作日；
- F2：由直属主管审批；
- F3：试用期员工不适用。

此制度和后面候选 Token 数均为**教学假设**，不是项目真实生产资料。

| Rerank 名次 | 片段 | 长度 | 覆盖事实 |
|---|---|---:|---|
| 1 | C1：年假申请说明 | 500 tokens | F1 |
| 2 | C2：申请时限 FAQ | 350 tokens | F1 |
| 3 | C3：审批流程 | 400 tokens | F2 |
| 4 | C4：年假适用范围 | 250 tokens | F3 |
| 5 | C5：其他休假说明 | 300 tokens | 无 |

如果本次可用证据预算为 1050 tokens，直接从最高排名开始拼接 C1（500）+ C2（350），此时下一条 C3 放不下，结果只提供 F1，**虽然二者都很相关但 Final Context 事实覆盖只有 1/3**。

假设 C2 已经足够权威、完整，且可替代 C1，选择 C2（350）+ C3（400）+ C4（250）总计 1000 tokens，则覆盖 3/3。这说明证据组合不应只按照单条 Rerank 排名进行；还要考虑新增事实覆盖、版本可信度、冗余及 Token 成本。

关键限定：**线上程序不会天然知道人工 Ground Truth 的 F1/F2/F3 列表**。只有预先定义领域事实、利用模型分析 Query，或使用经验证的规则才能推断用户需要哪些事实，不能把离线人工标注直接当成线上可自动获得的信息。

#### 【Token Budget 的真实约束】

简化表达：

~~~text
EvidenceBudget
 = ModelContextWindow
 - SystemPromptTokens
 - ConversationHistoryTokens
 - QueryTokens
 - ReservedOutputTokens
 - FormatOverheadAndSafetyMargin
~~~

例如模型可用上下文 8192 tokens，系统提示 900、历史 1400、Query 100、生成预留 1000、格式余量 500，则证据预算为 4292 tokens。这仅是预算教学数据；模型实际窗口、输出限制和模板由部署配置决定，输入 Token 应使用目标模型兼容的 Tokenizer 计量。

**不能用单纯字符切片等价代替 Token 预算控制**：不同文本的 Token 消耗不同，而且直接在字节/字符位置截断可能删除后半句限定条件。例如：

~~~text
原文：
员工提前三个工作日申请年假。
但是试用期员工不适用这一制度。

机械截断后：
员工提前三个工作日申请年假。
~~~

被删去的适用条件会影响回答。优先按完整证据或句子/事实边界选择；如果确实截断则应明确标记，不要继续将截断证据视为无条件完整的事实支持。

#### 【Context Construction 的职责和运行链路】

~~~text
有序候选 Chunk
    ↓
① 检查合法性：权限 / 当前有效版本 / 原文来源
    ↓
② 去除精确重复、同源 Offset 重叠
    ↓
③ 依元数据补充章节路径、必要父节和明确引用条款
    ↓
④ 在 Token Budget 内选择证据并避免冗余
    ↓
⑤ 添加稳定引用 ID、来源标题、文档版本和章节
    ↓
⑥ 在最终 Prompt 构成后复核实际入模证据和 Token
    ↓
LLM
~~~

这些是逻辑职责，不是所有框架必须采用的固定物理执行顺序。权限在检索前后都可能需要验证；尤其注意**如果经过最终 Token 选择后丢掉关键证据，必须重新评价最终 Context，而非仅相信 Rerank 候选阶段的覆盖。**

- **来源**：Rerank Score 不替代访问控制或文档生效条件；旧版/失效规则应遵守可信版本与废止关系。
- **去重**：Chunk Overlap 的重复可按同一原文 Offset 合并；FAQ 与正文即使语义相似，也不能简单视为事实等价，因为可能有“通常”“除外”等限定。
- **背景**：较小 Chunk 提高检索定位精度；必要时再从同文档的父节/相关条款恢复背景，不应每次一律附加整个章节。
- **引用**：最终 Context 对每条证据分配来源 ID，保持 `evidenceId/chunkId/documentId/version` 与正文绑定；引用 ID 仍需检查是否真的支持对应断言。
- **提示注入**：从知识库检索的正文属于外部资料，不能当作高优先级指令执行。

研究 [Lost in the Middle: How Language Models Use Long Contexts](https://aclanthology.org/2024.tacl-1.9/) 在特定模型与任务下发现长上下文中间位置的证据可能更难被使用。故“在窗口内”并不保证“模型稳定用到”；但证据摆放顺序需依据具体模型与任务评测，而不是固定认定放在末尾最好。

#### 【妙码 AI Flow 当前怎么组织 Context：源码核对】

代码：[KnowledgeExecutor](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/executors/knowledge-executor.ts)、[LLMExecutor](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/executors/llm-executor.ts)、[BaseExecutor](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/base-executor.ts)、[VariableResolver](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/core/variable-resolver.ts)。

**当前实现**：

1. `KnowledgeExecutor` 调用 `retriever.retrieve()` 后，文本模式将每条候选按序号和正文用两个换行连接，形如：

   ~~~text
   [1] <第一条 Chunk 正文>

   [2] <第二条 Chunk 正文>
   ~~~

   JSON 模式序列化包括 `chunkId/content/score/chunkIndex/documentId/knowledgeBaseId` 的结果数组。文本模式并未自动加入完整版本化引用来源。
2. `BaseExecutor` 解析节点配置字符串中的上游变量；`VariableResolver` 会将节点输出替换进入下游 Prompt。因此知识节点的 `output` 能被工作流的 LLM 节点引用，但这属于变量注入机制，并不是完整的 Context 质量管理。
3. `LLMExecutor` 把系统/用户/助手 Prompt 组装为消息后调用 Ollama。`maxTokens` 映射到 `numPredict`（生成长度控制），而 `estimateTokens(content)` 是生成后按中英文字符粗估**输出文本**的 Token 计数；它不是调用前对所有输入 Context 的 Token 预算控制。

**源码结论**：在上述已核对链路中，没有独立自动执行“权限/版本/背景/去重/Token Budget/最终证据核验”的 ContextBuilder。不能因为有 `topK` 或 `maxTokens` 就宣称实现了这套能力。

#### 【建议的第一版 ContextBuilder 数据协议】

建议增加独立工程层，而非让 KnowledgeExecutor / LLMExecutor 各自夹杂复杂规则：

~~~typescript
interface ContextEvidence {
  evidenceId: string;
  chunkId: string;
  documentId: string;
  knowledgeBaseId: string;
  content: string;
  tokenCount: number;
  source?: {
    title: string;
    version?: string;
    section?: string;
  };
}

interface ContextPackage {
  text: string;
  evidence: ContextEvidence[];
  totalTokens: number;
  dropped: Array<{
    chunkId: string;
    reason: "duplicate" | "token-budget" | "invalid-source" | "permission";
  }>;
}

interface ContextBuilder {
  build(options: {
    query: string;
    candidates: RetrievalResult[];
    tokenBudget: number;
  }): Promise<ContextPackage>;
}
~~~

**以上仅是方案接口，不是已经编写的项目业务代码**。实现优先级：可信有效来源、明确重复去除、正确 Token 计数、稳定证据 ID 和调用前检查；复杂的多事实语义覆盖/冲突交给后续独立层评估。

#### 【评测：定位证据在哪个阶段消失】

假设：

~~~text
Ground Truth：{F1,F2,F3}
Retrieved Candidates：{F1,F2,F3}
Rerank Candidates：{F1,F2,F3}
Final Context：{F1,F2}    ← 预算/去重等造成 F3 丢失
~~~

可建立：

- Candidate Evidence Recall@N：初始候选是否找到正确证据；
- Final Context Fact Coverage：实际入模证据是否支持全部必要事实；
- Context Token Cost 与冗余率；
- Citation Support Accuracy、Faithfulness 和 Answer Correctness。

尤其注意 Context Precision 一般描述检索结果中相关上下文的排序表现，不是 Token 使用效率。若使用 Ragas 之类的自动评估器，必须标记具体 Judge/模型/方法；离线模型评测指标不等于一个可线上执行的确定性 ContextBuilder。

**面试标准回答**：Context Construction 是检索与生成之间的证据组织层，不能简单将 Rerank Top-K 视为最终 Prompt Context。应在可信来源、权限/时效、结构背景与 Token 预算约束下去重、选择、组织并标注可追溯证据；复杂问题要评价组合后的必要事实覆盖。项目当前是候选拼接与工作流变量注入，建议新增独立 ContextBuilder 并记录最终入模证据、Token 和丢弃原因。

---

### 【5.2 基于结构和规则的证据补齐与有界复检】

*原讨论问题：不引入模型，哪些证据完整性和背景补充检查能用代码完成*


#### 【提问】

Context Construction 提到事实对齐、条件覆盖、判断缺少背景、补充检索和证据冲突。如果不引入额外模型，能否全部用 TypeScript/脚本完成？代码需要依据什么信息作判断？

#### 【知识概述：结构检查和语义判断不是同一件事】

| 判断 | 依赖的信息 | 不用模型是否可靠 |
|---|---|---|
| 权限 / 知识库隔离 | 可信用户身份和后端授权 | 可以 |
| 来源文档当前有效版本 | 版本、生效/废止日期、可信状态 | 可以 |
| 是否含章节标题、父节位置 | `headerPath/sectionId` | 有结构数据即可 |
| Chunk 与原文位置是否一致 | 文档版本、`startOffset/endOffset`、原文 | 可核验，但 Offset 本身必须准确 |
| 相邻 Chunk 是否重叠 | 同源 Offset 与文本边界 | 可以 |
| 是否超 Token Budget | 目标模型兼容 Tokenizer | 可以 |
| 显式引用“第 X 条”“上述规定” | 正则 + 条款索引 | 可识别可定位的一部分 |
| 是否已覆盖任意 Query 的全部隐含事实 | Query 与自由文本的真实语义 | 无通用确定性保证 |
| 两段自由文本是否真实互斥 | 主体/条件/时间/逻辑蕴含 | 无通用确定性保证 |
| 审核过的固定业务字段是否缺项 | 结构化 `FactType` 和证据映射 | 可以 |
| 审核过的规则是否冲突 | 事实属性、条件重叠、时间与版本 | 可以 |

**原则**：能通过结构与可信规则证明的事实让代码处理；若仅能由模糊关键词推断，则保留 `unknown` 状态，而不是自动宣布“完整”。

#### 【无需模型的结构补齐：标题、邻接、显式引用】

假设文档：

~~~text
# 员工休假制度
## 年假申请
员工应提前三个工作日提交申请。
## 审批流程
由直属主管审批。
~~~

如果只检索到“由直属主管审批”，但入库保存了 `headerPath:["员工休假制度","审批流程"]`，就可以在输出时附带可信标题：

~~~text
来源：员工休假制度
章节：审批流程
正文：由直属主管审批。
~~~

这是一种统一格式策略，不需要模型先判定“是不是缺少背景知识”。

如果正文含：

~~~text
上述条件不适用于试用期员工。
~~~

可以通过可维护的显式关联规则检测潜在前文引用：

~~~typescript
const referencePatterns = [
  /上述(条件|规定|要求)/,
  /前述(条件|情形)/,
  /以下(情况|条件)/,
  /按照第[一二三四五六七八九十\d]+条/,
  /依照本章规定/,
];

function hasExplicitReference(text: string) {
  return referencePatterns.some(pattern => pattern.test(text));
}
~~~

命中后，如果有条款编号、`sectionId`、`parentSectionId`、可靠原文 Offset，可以定位被引用条款或有限范围的同节背景。但**出现“上述条件”并不代表最近一个 Chunk 必然正确**；邻接关系只是候选关联，跨页/跨章节引用需要更明确的指向。

#### 【固定领域的事实覆盖可用集合差集】

如果业务领域已经有审核过的数据模式：

~~~typescript
type LeaveFact =
  | "advanceDays"
  | "approverRole"
  | "probationEligibility";

const required = new Set<LeaveFact>([
  "advanceDays",
  "approverRole",
  "probationEligibility",
]);

const covered = new Set<LeaveFact>([
  "advanceDays",
  "approverRole",
]);

const missing = [...required].filter(x => !covered.has(x));
// ["probationEligibility"]
~~~

只要 `required` 是由可靠的需求识别得来，而 `covered` 是来自受审核的结构化事实记录，缺失检测就可重复、可解释。

但这段代码本身**只完成集合差集**：没有证明模型之外的系统能够自动从任意中文 Query 得到 `required`，也没有证明含“试用期”的文档一定支持 `probationEligibility`。在固定业务领域可以用严格意图模板、表单或人工维护的知识字段建立可靠映射；自由问答无法只靠几条正则准确发现全部隐含需求。

#### 【如何进行可控补充与复检】

~~~text
初始候选
  → 校验授权、版本、结构信息
  → 去重、补充显式引用、控制预算
  → 检查定义明确的 Required Facts
  → 如果有明确 Missing Facts：
       使用模板化 Query 在授权知识库中定向检索
       校验新结果的权限与时效
       合并并去重，再次检查缺项
  → 生成 Context 或返回 incomplete/unknown
~~~

**必须有终止条件**：最多例如 1～2 轮，固定超时、不重复执行同一查询、没有新增有效 Chunk 即停止、超出 Token Budget 即停止。避免把验证循环变成无界探索。

状态建议拆分为 `complete`、`incomplete`、`unknown`。**未知与缺失不同**：无可靠语义检查能力时，不能因为规则没有命中就认定全部事实已覆盖。

#### 【本题标准回答】

规则和代码可以完成来源权限、版本时效、章节定位、Offset 重叠、Token Budget、显式交叉引用以及有预定义字段的覆盖检查与补检。它们的可靠性来自**入库阶段形成的结构与业务事实数据**，不是脚本天然具有自然语言理解能力。对于任意 PDF、Markdown 和非结构化文本，能识别结构不等于能判断语义充分；即使所有结构检查通过，也不能据此证明不存在遗漏事实或冲突，应保留 `unknown` 并在离线评测中验证实际效果。

---

## 【六、证据完整性、冲突检测与智能补充检索】

**通用机制衔接：** [Evidence Verifier、冲突识别和有界补检](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/R-RAG上下文构建证据冲突与补检完整知识体系.md) 逐步推导相应算法、数据结构、执行过程与验证边界；本章节继续保留 AI Flow 的全部具体源码、数据案例、工程问题和方案，不以通用正文替代项目分析。

进一步研究“怎样判断”而不是只讨论“怎样拼接”：明确结构完整、缺少背景、事实冲突的判定依据，再区分纯规则、Evidence Verifier、有限补检 Workflow 与自主 Agent 的职责。

### 【6.1 结构完整性、背景依赖与事实冲突的判定】

*原讨论问题：究竟怎样判定结构完整、背景不足和证据冲突*


#### 【提问】

不能只说“代码检查”。需要明确：**判断结构是否完整，实际比较什么？如何决定需不需要补充？两条证据是否存在冲突，又依据哪些维度？**

#### 【结构完整性的判定依据】

建议离线记录明确的结构边界：

~~~typescript
interface ChunkStructure {
  chunkId: string;
  documentId: string;
  documentVersion: string;
  sectionId: string;
  sectionStart: number;
  sectionEnd: number;
  headerPath: string[];
  chunkStart: number;
  chunkEnd: number;
  parentSectionId?: string;
}
~~~

若结构信息准确，可以确定一个 Chunk 是否覆盖整个原文 Section：

~~~typescript
const isCompleteSection =
  chunk.chunkStart === chunk.sectionStart &&
  chunk.chunkEnd === chunk.sectionEnd;
~~~

**这一判断只代表“与章节区间相同”，不代表“回答 Query 所需背景已充分”**。

可执行的结构检查包括：文档 ID 和版本能否回源、Offset 是否落在真实原文范围、Chunk 正文与原文对应片段是否匹配、`headerPath` 是否与节标题一致、引用条款是否能被定位、同一版本的父子结构是否有效。

切分后的 `trim()` 和 Markdown 标题/段落处理可能导致记录 Offset 与原文文本的精确对应关系需要特别测试。不能不经校验就在 ContextBuilder 中按 Offset 直接取回原文。

#### 【背景完整性：判断“是否存在依赖”和“依赖是否满足”】

例如 C2：“由直属主管审批”，`headerPath` 已包含“员工休假制度 > 年假申请 > 审批流程”。可以始终追加轻量章节标题，这是确定性结构增强。

例如 C8：“上述条件不适用于试用期员工”，包含显式前文指代。如果另有条款编号或 `parentSectionId`，可优先按结构引用定位；如果指代不明，只能将相邻 Chunk 作为候选补充，状态应为“可能依赖/待核验”，不能认定前一条 Chunk 一定就是正确背景。

还有更难的情况：Query 问“哪些例外情形可以申请？”而片段只是讲一般规则，无显式代词也没有说明例外。**脚本无法仅凭“句子完整、标题完整”推出例外不存在或已经齐全**。若有预先定义的 `requiredFacts`，可针对字段检查；开放式自然语言需要额外语义判断或人工审核。

#### 【证据冲突：先检查同一主体、属性、适用范围与有效时间】

举例：

~~~text
A：试用期员工可以申请年假。
B：试用期员工不可以申请年假。
~~~

在同一时期、相同主体和适用条件下，二者可能冲突。但：

~~~text
A：2025 年制度允许试用期申请年假。
B：2026 年制度不允许试用期申请年假。
~~~

如果旧制度已废止，这是制度变更而非“当前两个有效规则冲突”。

另一例：

~~~text
A：入职满一年的员工可以申请年假。
B：试用期员工不可以申请年假。
~~~

由于适用条件可能不重叠，也不能仅按“可以/不可以”认定冲突。

可建立审核后的领域事实：

~~~typescript
interface PolicyFact {
  subject: string;
  property: string;
  value: string | number | boolean;
  conditions: Record<string, unknown>;
  effectiveFrom: string;
  effectiveTo?: string;
  documentId: string;
  chunkId: string;
}
~~~

判断框架：

~~~typescript
// 伪代码：条件重叠、时间范围与规则优先级均需领域实现。
function mayConflict(a: PolicyFact, b: PolicyFact) {
  return a.subject === b.subject
    && a.property === b.property
    && conditionsOverlap(a.conditions, b.conditions)
    && timeRangesOverlap(a, b)
    && a.value !== b.value;
}
~~~

这里 `mayConflict` 只表示潜在冲突，不代表已完成对制度层级、授权来源、例外条件、废止关系的裁决。自然语言事实未结构化时，简单关键词检测或向量相似度**不能可靠判断否定的作用范围和条件互斥性**。

#### 【多维状态，不要一个布尔值】

~~~typescript
type CheckStatus =
  | "passed"
  | "needs-expansion"
  | "conflict"
  | "unknown";

interface EvidenceCheckResult {
  structure: CheckStatus;
  background: CheckStatus;
  consistency: CheckStatus;
  reasons: string[];
  missingFields: string[];
  requiredChunkIds: string[];
}
~~~

例如：

~~~text
structure: passed
background: unknown
consistency: unknown
~~~

表示“文档结构符合已定义的规则，但语义是否充分与是否冲突尚未被可靠验证”。这比将所有未知静默转换为 `passed` 更符合工程安全边界。

#### 【妙码 AI Flow 已发现的实际数据缺口】

已核对项目源码：

1. [MarkdownSplitter](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/chunking/markdown-splitter.ts) 为 Chunk 生成 `metadata.headerPath`。
2. [document-processor.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts) 构建 `ChunkWithVector[]` 时传递 `content/index/startOffset/endOffset/documentId/knowledgeBaseId/vector`，**漏传 `metadata: chunk.metadata`**。
3. [qdrant-store.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts) 保存 `metadata: chunk.metadata || {}`，故上游漏传时 `headerPath` 在这条写入链路无法保存。
4. `QdrantVectorStore.search()` 返回 `metadata` 等字段，但没有把已存 Payload 中的 `startOffset/endOffset` 显式映射到当前搜索结果接口，因此需要扩展查询结果或增加根据 `chunkId` 获取完整结构信息的能力。
5. [KnowledgeExecutor](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/executors/knowledge-executor.ts) 的 Text 输出是名次与正文直接拼接，没有系统地注入标题路径、文档生效版本和稳定引用 ID。

**第一步不是立即新增模型，而是修复现有 Metadata 传递、验证 Offset，补齐 `sectionId/documentVersion/parentSectionId` 等来源结构，使后续确定性规则真正有可信数据可用。**

#### 【本题标准回答】

代码能根据可靠的章节/原文结构判断 Chunk 是否覆盖完整章节、是否有显式引用依赖，并可以在业务字段已结构化时比较主体、属性、条件、时间和互斥结论，发现缺失或潜在冲突。但结构完整不等于语义完整，两个文本相似不等于内容一致，两个相反结论也可能只是适用条件或版本不同。对于无法判断的自然语言情况，应保留 `unknown`，不能把规则未命中等同于完成了语义核验。

---

### 【6.2 Evidence Verifier、补检 Workflow 与 Agentic RAG】

*原讨论问题：实际工程需要 Evidence Verifier、专门模型还是 Agent*


#### 【提问与结论】

在企业通用知识库中，如果要综合多个非结构化片段，判断“是否具备用户问题要求的全部事实、是否互相矛盾、是否需要补充缺失背景”，代码无法通用保证语义判断。是否应引入 LLM、专用模型，还是让 Agent 自主编排全部步骤？

**推荐优先方案：确定性 ContextBuilder + 按需调用的 EvidenceVerifier（模型）+ 有界补检 Workflow。** 引入模型不等于必须训练新模型，更不等于需要完整 Agent 框架。

| 层次 | 负责的内容 | 技术选择 |
|---|---|---|
| 确定性基础 | 权限、版本、结构来源、精确去重、Token、引用 | TypeScript + 业务 DB / Qdrant |
| 语义验证 | 多事实要求、证据支持、语义冲突、缺失背景 | 现有 LLM / 专门 NLI 分类模型 |
| 行动控制 | 依据验证结果是否继续检索、最多几轮、何时停止 | 先固定 Workflow，复杂时再考虑 Agent |

#### 【模型实际要判断什么】

教学问题：

~~~text
2026 年试用期员工能否申请年假？
如果适用，需要提前多久？由谁审批？

C1：2026 年正式员工可申请年假，须提前三个工作日。
C2：年假申请由直属主管审批。
C3：2025 年试用期员工可以申请年假。
C4：2026 年试用期员工不适用年假制度。
~~~

先通过代码过滤时效失效/越权文档；不能把 C3 与 C4 不同直接判为“2026 年当前有效制度冲突”。模型再尝试将 Query 分解：

~~~text
F1：2026 年试用期员工有无申请资格？
F2：若适用，需提前多久？
F3：若适用，由谁审批？
~~~

**条件依赖很重要**：C1 对正式员工的三天规则不能无条件推广给试用期员工。Verifier 应判断每个要求是 `supported/missing/uncertain`，并关联实际授权、有效的 `evidenceId`。如果存在复杂范围冲突，应输出“可能冲突”，并标明证据与冲突理由，而不是自行决定政策效力。

可以借鉴 NLI（Natural Language Inference）的 `entailment/contradiction/neutral` 分类：某条证据对某个明确断言是支持、矛盾还是信息不足。但 NLI 文本对分类不等于自动完成整个多文档规则冲突判决，仍要先核对来源、时间、主体与条件。

#### 【为什么建议结构化 EvidenceVerifier，而不是自由文本总结】

建议输出 JSON（设计草案，当前仓库未实现）：

~~~typescript
interface EvidenceVerification {
  requirements: Array<{
    requirement: string;
    status: "supported" | "missing" | "uncertain";
    evidenceIds: string[];
    missingInformation?: string;
  }>;
  conflicts: Array<{
    evidenceIds: [string, string];
    reason: string;
    status: "possible" | "confirmed" | "uncertain";
  }>;
  needMoreEvidence: boolean;
  suggestedSearchQueries: string[];
}
~~~

`confirmed` 只是模型给出的分类标签，不是可直接跳过验证的形式化证明。代码必须验证：

- 使用 JSON Schema / Zod 等校验结构与字段范围；
- 返回的 `evidenceIds` 必须来自本次输入的**有效且有权限**的候选，拒绝不存在/跨租户/失效的引用；
- 缺失的事实描述与建议的 Query 不能授权模型访问额外知识库；
- 补检后重新校验新增 Chunk 的权限、时效、来源；
- 对仍然不足或冲突的证据返回 `uncertain/insufficient`，不把未知强行解释为“足够”；
- 记录 Verifier 版本、模型、判定与可审计原因，敏感正文日志遵循脱敏和保留规则。

**模型负责语义判断与提出补检建议；代码负责权限制约、执行、回退和停止。**

#### 【一个无需引入 Agent 的最小 Workflow】

~~~text
Query
  ↓
Retrieval（Dense / Fulltext/BM25）
  ↓
Fusion / [可选] Rerank
  ↓
ContextBuilder：版本权限、结构补全、去重、Token Budget
  ↓
EvidenceVerifier：是否支持各子问题、是否缺背景/存在可能冲突
  ↓
程序校验 Verifier 的结构化输出
  ├─ sufficient → 最终 Context 重新核对 → Generation
  ├─ missing → 生成受限补检请求
  │             ↓
  │          定向 Retrieval
  │             ↓
  │          重新校验与构建 Context
  │             ↓
  │          再次 EvidenceVerifier（最多 1～2 轮）
  └─ conflict / uncertain → 标明证据不足、澄清或转人工
~~~

**重要执行顺序**：如果 Verifier 验证的是预算选择之前的一批候选，但最终 ContextBuilder 只保留了一部分，则应在**最终实际进入 LLM 的 Context**上复核验证；不能说“候选集合完整，所以模型输入完整”。

设置硬停止条件：最大循环轮数、超时/Token/模型调用次数预算、同一 Query 去重、无新有效 Chunk、不可解决的证据冲突。这样即使有模型决定 `missing`，整个流程仍属于固定编排的受控 Workflow。

#### 【Workflow 与 Agentic RAG 的边界】

普通受控 Workflow：

~~~text
Retriever → Verifier（模型输出结构化 status）
                       ↓
               程序固定路由
       sufficient → 生成
       missing    → 再检索一次
       conflict   → 标记或人工确认
                       ↓
                     结束
~~~

存在模型决策节点，但不需要模型持续规划/执行任意工具。

Agentic RAG 则更侧重：

~~~text
模型检查证据缺口
    ↓
动态选择检索工具、改写 Query 或转向其他来源
    ↓
执行工具并观察新证据
    ↓
判断是否继续检索或停止
    ↓
在预算和权限约束内重复推进
~~~

这才更接近“判断 → 行动 → 观察 → 再判断”的 Agent Loop。Agent Runtime/Harness 仍需执行工具白名单、权限、Context、Trace、预算与停止规则，不应由模型自由突破这些约束。

**不是 Agent 越复杂就越好**。只有固定检索与最多几次补检无法解决的开放式、多跳、跨系统研究任务，才考虑 Agentic RAG。

#### 【需要从头训练专门模型吗】

一般不必在第一版训练。

| 方案 | 优点 | 局限 / 何时选择 |
|---|---|---|
| 现有 LLM + 固定提示和结构化输出 | 可一次判断多个事实、背景条件与可能冲突 | 调用成本、误判与延迟需量化；PoC 优先 |
| 现成 NLI Cross-Encoder 分类器 | 适合对单个断言与一条证据做支持/矛盾/中立判定 | 多文档整体覆盖和版本关系仍需编排 |
| 领域微调 Verifier | 可针对术语/限定条件优化 | 要先积累可靠标注并证明通用模型不足 |
| Agentic RAG | 多轮自主选工具、改写 Query 更灵活 | 更难调试、成本高、需严格限制权限与停止 |

**Reranker 不等于 NLI Verifier**：Reranker 主要输出 Query–Chunk 的排序相关性；NLI 输出针对明确断言的关系判断；多片段的事实完整性又需要综合每个问题要求、适用条件与来源。

#### 【分阶段落地到妙码 AI Flow】

根据已核对源码，当前有 `HybridRetriever`、工作流知识库节点和 `LLMExecutor`，但在这些已检查模块中**没有独立 ContextBuilder、EvidenceVerifier 或用于主动补检的 Agent**。要区分设计建议与项目已交付功能。

建议小步推进：

1. **先补可靠的数据基础**：修复 `metadata: chunk.metadata` 传递问题，验证 Offset 和 `headerPath`、来源版本和文档权限，定义可复用的 ContextPackage。
2. **先做纯规则 ContextBuilder**：权限、当前版本、标题/显式引用恢复、精确去重、Token Budget、引用映射；不承诺自由文本语义完整。
3. **增加可选 EvidenceVerifier**：复用现有模型接入能力，固定 JSON Schema，按需在多事实/疑似冲突/显式依赖场景激活；不用先训练新模型。
4. **增量引入有界补检**：如果结构化输出明确指出缺少事实，在可信知识库范围内执行至多 1～2 次定向搜索，最后复核模型实际使用的 Context。
5. **依据评测决定是否升级**：当固定 Workflow 无法解决多跳场景时才考虑 Agent；验证器成为成本热点且有领域标注时再考虑小模型/微调。

#### 【评测：证明模型验证不是单纯增加成本】

在同一语料版本、授权环境、Query、Ground Truth 下对照**规则 ContextBuilder**与**ContextBuilder + EvidenceVerifier + 有界补检**：

| 测试集 | 目标 |
|---|---|
| 证据完整的 Query | 避免错误要求额外补检 |
| 人工确定缺少必要事实 | 缺项识别 Precision / Recall |
| 新旧版本表面相反 | 不误报真实冲突 |
| 同主体、同时效、同条件下事实互斥 | 冲突发现 Precision / Recall |
| 显式引用/隐含背景条件 | 背景补全是否正确、是否遗漏关键限制 |
| 最终答案、引用与预算 | Final Context Fact Coverage、Faithfulness、Correctness、Citation Support、P95 延迟和成本 |

特别记录 `unknown/abstain` 的比例和**误判“证据充分”**的比例。验证器本身也可能幻觉或漏看条件，因此模型判定不能取代人工标注、源文核对和生产安全边界。

#### 【本轮标准回答】

对于企业通用非结构化知识库，ContextBuilder 应由确定性代码完成权限、版本、章节定位、文本重叠、Token Budget 和引用映射；多个自然语言片段是否覆盖用户所需的全部事实、是否存在隐含条件或语义冲突，通常需要独立语义判断，或者先建立可审核的结构化事实模型。可以优先复用现有 LLM 作为 EvidenceVerifier，输出事实要求、已支持的证据 ID、缺失信息和可能冲突，再由代码对来源和权限进行校验并在有限轮次内补检。

这是一个受控 Workflow，不需要从开始就建独立 Agent 或训练专门模型。只有确实需要模型动态规划下一次搜索、选择工具并反复观察新结果时，才考虑 Agentic RAG。最后需要通过 Ground Truth 检验新增判断能力对事实完整性、冲突识别和最终回答质量是否真正有收益，以及额外的延迟、成本是否值得。

#### 【资料与源码衔接】

1. [Lost in the Middle（ACL Anthology）](https://aclanthology.org/2024.tacl-1.9/)：长上下文位置对模型利用证据的影响。
2. [Ragas：Context Recall](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/)：参考事实与上下文证据的覆盖评测。
3. [Ragas：Context Precision](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/)：不同于 Token 成本的相关性排序评测。
4. [Sentence Transformers：Cross-Encoder 应用](https://www.sbert.net/examples/cross_encoder/applications/README.html)：文本对评分及 NLI/Rerank 的边界。
5. [LangGraph Agentic RAG](https://langchain-ai.github.io/langgraph/tutorials/rag/langgraph_agentic_rag/)：模型评估检索结果、改写 Query 与受控检索循环的工作流思想。
6. 项目源码：[MarkdownSplitter](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/chunking/markdown-splitter.ts)、[Document Processor](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts)、[Qdrant Store](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)、[KnowledgeExecutor](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/executors/knowledge-executor.ts)、[LLMExecutor](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/nodes/executors/llm-executor.ts)、[VariableResolver](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/core/variable-resolver.ts)。

---

## 【七、分阶段质量评测、失效归因与工程验收】

**通用机制衔接：** [Trace、事实覆盖与分阶段质量归因](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/R-RAG端到端质量评测与失效归因完整知识体系.md) 逐步推导相应算法、数据结构、执行过程与验证边界；本章节继续保留 AI Flow 的全部具体源码、数据案例、工程问题和方案，不以通用正文替代项目分析。

最后把检索、融合、重排和上下文组织的输出作为不同评测对象，使用 Ground Truth 检查证据在哪一层丢失，再通过源码级 Trace、对照实验和延迟成本数据验证优化。

### 【7.1 最终 Context 的事实覆盖与相关性评测】

*原讨论问题：Context Construction 是否也属于 RAG 评测*


#### 【提问与结论】

**是。Context（上下文）质量是完整 RAG 评测不可缺少的对象。**但需要先区分：

- **Context Construction（上下文构建）**是系统实际执行的环节：它从检索候选中挑选、去重、补充、压缩、截断并组织 LLM 最终收到的证据文本。
- **Context Evaluation（上下文评测）**是对检索所得材料或者最终模型输入的相关性、完整性和可用性进行评价。

不同研究和评测框架对术语的归属不完全一致。Ragas 将 `Context Precision`、`Context Recall` 放在 RAG 相关评测指标中，通常用来衡量检索到的上下文是否有用；它们**不必然**意味着工程系统里有一个独立的名为 `ContextEvaluator` 的运行组件，也**不自动**覆盖最终 Prompt 组装导致的证据损失。必须先明确一个指标的输入数据来自哪个阶段。

#### 【知识概述：检索输出与最终 Context 是不同的数据对象】

~~~text
用户 Query
  → 初始检索：返回一批候选 Chunk
      │  评测：Evidence Recall@K（正确证据有没有进入候选）
      ▼
  → Fusion / Rerank：融合、重新排序
      │  评测：MRR / nDCG（正确证据有没有排靠前）
      ▼
  → Context Construction：选择、去重、扩展、压缩、截断
      │  评测：最终证据覆盖、引用可定位、Token 成本和冗余
      ▼
  → LLM Generation：依据最终 Context 生成回答
         评测：Faithfulness（回答是否受 Context 支持）、
               Answer Correctness（事实是否正确）
~~~

注意图中“初始检索返回候选”和“LLM 最终收到 Context”**不一定相同**。例如初始召回允许 50 条，而模型只接收重排后的 5 条；或者因 Token 预算只保留部分正文。Context 也可能添加来源标题、父章节说明或多个 Chunk 的合并文本，不能始终按原始 Chunk 个数衡量其内容。

#### 【同一问题：召回成功而上下文构建失败的完整过程】

沿用前面的问题：“年假申请需要提前多久，由谁审批？”Ground Truth 仍是：

~~~text
C1：年假须提前三个工作日申请
C2：年假由直属主管审批
~~~

假设：

~~~text
初始检索 Top-5：
[C3, C1, C4, C2, C5]
→ 包含 C1 与 C2；Evidence Recall@5 = 2/2 = 100%

重排 Top-3：
[C1, C2, C3]
→ C1/C2 均在前两位；证据覆盖仍为 100%

Context Construction：
由于错误截断、错误去重或不当的 Token 预算策略，
实际只组装了 C1 的正文
→ 最终可用证据只支持“申请时限”
→ 最终必要事实覆盖 = 1/2 = 50%

LLM 收到的 Prompt：
参考资料只有“年假须提前三个工作日申请”
问题却同时询问“由谁审批”
→ 无法从收到的资料确定审批人
~~~

这个例子只表示**人为构造的故障场景**。它证明检索器已经完成任务，不代表整个 RAG 链路能够完整回答。若此时仅调高 `hnsw_ef` 或增大初始 `topK`，并不会自动修正组装阶段丢弃 C2 的问题。

| 阶段 | C1：时限 | C2：审批人 | 对两条必要事实的覆盖 |
|---|---|---|---:|
| 初始候选 Top-5 | 有 | 有 | 100% |
| 重排后 Top-3 | 有 | 有 | 100% |
| 最终送入 LLM 的 Context | 有 | 无 | 50% |

需要把**能用于回答的证据是否保留**当成实际指标，而不是把 Query 相关主题的文本数量误当作覆盖度。

#### 【Context 的几种评价维度及边界】

**第一类：相关性与排序质量。**最终组织的资料是否回答本次 Query？是否有大量“年假申请入口、病假证明”等与“时限+审批人”无关的片段？相关性通常可用二元或分级 Qrels 检验，检索排序可继续使用 Precision / nDCG 等指标。

**第二类：必要证据覆盖。**最终 Context 能否支持问题中的每个必要事实？一种教学式的覆盖公式为：

~~~text
Final Context Fact Coverage
  = （被最终 Context 支持的必要事实数）
    / （该 Query 需要的必要事实总数）
~~~

例如两个事实只保留一个，则 `1/2=50%`。**这只是清晰定义后的工程自定义检查，不应冒充所有框架通用的 Context Recall 公式。**一条较大的父章节可能同时支持多个事实，不能直接用“保留了几个 Chunk”替代“支持几个事实”。

**第三类：上下文预算与冗余。**片段即使都相关，重复段落、过长的父章节、无关 Metadata 也会占用 Token，导致重要证据被截断。应记录输入 Token 预算、实际上下文 Token 数、选择了哪些证据、因何丢弃哪些候选及是否发生截断。冗余与成本是工程观测项，不能仅凭某一条指标就推断模型答案质量。

**第四类：引用与版本有效性。**最终 Context 中的每段事实能否回溯原 Document、版本、章节位置，以及调用者是否有权访问？版本失效和越权不能通过高相似度或相关性得分抵消。

#### 【Ragas 中 Context Precision 与 Context Recall 的含义】

这里要区分**框架明确提供的指标**和**我们针对特定流水线自定义的验收指标**：

| 评价名称 | 在 Ragas 中的典型含义 | 不能误解为 |
|---|---|---|
| Context Precision | 衡量检索结果中相关 Chunk 是否优先排在前面；其计算思想结合相关项出现位置的 `Precision@k` | 普通的 `相关条数 / 检索总条数` 就完全等同该指标 |
| Context Recall | 参考答案中的必要断言是否能从所提供 Context 中找到支持；LLM-based 版本会分解参考答案的 Claims，再核对证据支持 | 任意场景下都只需对比 Chunk ID |
| Final Context Coverage（本篇的检查） | 对齐固定的必要事实标注，检查最终实际输入 LLM 的材料是否覆盖这些事实 | 所有框架都有的统一标准化指标 |

Ragas 官方 Context Recall 的基于断言计算思路是：

~~~text
Context Recall
 = 参考答案中被检索上下文支持的断言数 / 参考答案中的断言总数
~~~

如果用户问题需要两个事实，最终 Context 只支持时限、不支持审批人，则该口径下可能是 1/2；但 LLM 评判器的断言抽取与支持判定可能发生错误，需要标注抽检和明确使用的评测版本。Ragas Context Precision 更接近强调排名的相关性评测，而**不是简单记录系统是否超出 Token 上限**。

参考：[Ragas Context Precision](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/)、[Ragas Context Recall](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/)、[Ragas 指标列表](https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/)。

#### 【与答案生成评测的区别】

Context 评测判断“模型**看到了什么**”；Faithfulness（答案忠实度）判断“模型**说出的断言有没有证据支持**”；Answer Correctness（答案正确性）进一步检查“回答是否符合真实事实和问题需求”。

例如最终 Context 正确包含 C1/C2，模型却说“审批将在两小时内完成”，这个两小时的信息没有证据支持，属于生成阶段的 Faithfulness 问题。另一种情况是旧版政策被错误选入 Context，模型忠实引用旧版但结论过时，此时答案可能忠于 Context，却仍然不符合现行规则。**这两个问题需要追溯不同的失效阶段。**

#### 【项目实践：应该在哪里采集哪些数据】

从已核对的妙码 AI Flow 源码，可以确认 [`VectorRetriever`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts) 和 [`HybridRetriever`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts) 返回有序 `RetrievalResult[]`，其中包含 `chunkId`、`documentId`、`content`、`score`。这能作为**检索器输出候选集**的观察点；仅凭这些文件，尚不能确认最终 Prompt 如何组装，也不能确认系统已把“实际发送给 LLM 的 Context”完整记录。

因此以下属于**建议的可观测性设计，不是已完成的项目现状**：

~~~typescript
type RagEvaluationTrace = {
  queryId: string
  corpusVersion: string
  retrieverMode: "vector" | "fulltext" | "hybrid"
  retrievedChunkIds: string[]   // 初始召回的顺序与身份
  rerankedChunkIds?: string[]   // 实际有重排时才记录
  contextEvidenceIds: string[]  // 实际进入 LLM Context 的来源
  contextTokenCount: number
  droppedEvidence: Array<{
    id: string
    reason: "low-relevance" | "duplicate" | "token-budget" | "permission"
  }>
  promptVersion: string
}
~~~

一次质量故障可以按顺序定位：

1. **Retrieved Run 是否覆盖正确证据？**未覆盖时查解析、切分、Embedding、检索/ANN 与过滤。
2. **重排后是否保留正确证据？**候选存在但被截断时查融合、Rerank、`topK` 策略。
3. **最终 Context 中是否仍包含完整事实？**丢失时查去重、父子扩展、Token 预算与 Prompt 模板组装。
4. **生成是否正确引用这些事实？**证据完整但答案错误时查模型生成及来源引用逻辑。

项目实现上述 Trace 时，还应对敏感内容采取权限约束、采样与脱敏；测试并不要求把真实的全部私密文档原文都记录到日志中。

#### 【面试标准回答】

Context 属于 RAG 的评测对象，但 Context Construction 是运行阶段，Context Evaluation 则评估这个阶段交付给 LLM 的资料是否相关、完整、可靠。检索器输出和最终 LLM 输入通常不相同：候选在融合、重排、去重、父章节扩展或 Token 截断过程中可能丢失证据。因此初始 Evidence Recall@K 很高，不代表最终 Context 一定能支持全部答案事实。

应区分检索相关性与排序、最终 Context 的必要事实覆盖、Token 成本与冗余、来源版本和权限有效性。Ragas 的 Context Precision 通常衡量相关 Chunk 在检索列表中的排序质量，Context Recall 关注参考答案断言能否从提供的上下文找到支持；工程侧还可以单独记录最终 Context Fact Coverage、被丢弃证据及原因。

最后，Context 完整也不保证生成正确，应继续区分 Faithfulness（生成是否受证据支持）与 Answer Correctness（事实与问题是否正确）。这样才能根据质量损失位置决定该优化检索、重排、上下文构建还是生成环节。

#### 【资料依据】

1. Ragas：[Context Precision](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/)。
2. Ragas：[Context Recall](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/)。
3. Ragas：[Available Metrics](https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/)。
4. Qdrant：[Measuring Retrieval Relevance](https://qdrant.tech/documentation/search-evaluation/retrieval-relevance/) 与 [Evaluating Pipeline Output Quality](https://qdrant.tech/documentation/search-evaluation/pipeline-output-quality/)。
5. 项目源码：[VectorRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts)、[HybridRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)。

---

### 【7.2 检索全链路质量损失的定位与优化实验】

*原讨论问题：如何根据评测结果定位 RAG 检索质量的真正瓶颈*


#### 【提问与知识目标】

前三题已经解决三件事：建立 Query—Evidence Ground Truth，使用 Hit@K、Recall@K、MRR、nDCG 等指标识别质量差异，设计可靠、可复现的测试样本。新的问题是：**某个 RAG 知识库在固定评测集上的 Evidence Recall@10 只有 72%，是否应该增大 Top-K、改 Chunk Size、换 Embedding，还是调整 HNSW？**

答案是：**单一结果指标不能直接确定故障原因。应先找到质量损失发生的链路，再针对那个层次设计单变量对照实验**。本题把之前的知识构建、索引与评测连成一条“观察 → 归因 → 实验 → 复核”链路，避免把参数调优误当作质量优化本身。

在开始诊断之前，需确保标注、实际语料、权限范围、Embedding 版本、过滤条件、索引状态与测试 Query 对齐。若评测基础自身失真，优化判断也会失真。[Qdrant《What to Check Before Tuning a Qdrant Collection》](https://qdrant.tech/documentation/search-tuning/before-tuning-a-qdrant-collection/) 明确建议先确定质量目标、检查索引/过滤配置、使用标注数据评估症状，而非直接从参数表选值。

#### 【知识概述：按数据流区分六类可能的质量损失】

诊断时先区分**离线知识构建**与**在线检索生成**：

~~~text
离线：原始文档 → 解析与版本 → Chunking → Embedding → Point/索引
                 │             │             │        │
                 │             │             │        └─ 是否真正完成索引及过滤配置？
                 │             │             └─ 当前向量是否能表达正确语义？
                 │             └─ 必要事实/限制条件是否仍完整？
                 └─ 正确来源是否存在、有效、已入库？
                                ↓
在线：Query + 身份/权限/版本 → 向量 / 词项检索 → 候选集合
                                              │
                    独立对照：Exact kNN vs ANN（几何近邻误差）
                                              │
                                              ▼
                              融合 / 重排 / 最终 Top-K 截断
                                              │
                                              ▼
                            Context Construction（最终模型输入）
                                              │
                                              ▼
                                        LLM 答案输出
~~~

这是一条**因果诊断结构**，不是强制要求每个 RAG 系统都独立部署六个服务。有的系统仅使用向量检索，没有融合；有的系统将 Rerank 和 Context 选择放在一个调用中。无论实现如何，都可以通过阶段性输入输出定位证据在哪里消失。

| 观察症状 | 可能的瓶颈 | 优先检查 | 不应立即做的事 |
|---|---|---|---|
| 原始事实没有可检索记录 | 文档解析、同步/入库、版本 | 原文、文档状态、Point/Chunk 实际存储 | 直接调高 K |
| 原始事实存在但被截成不能独立理解的片段 | Chunking/Metadata | 原文位置、标题、条件、Chunk 正文 | 首先重建 HNSW |
| 正确 Chunk 已入库，Exact kNN 也排得很靠后 | 表示/检索策略与过滤条件 | 查询改写、Embedding、阈值、权限、词项检索 | 认定 ANN 图搜索是唯一问题 |
| Exact kNN 找到近邻，ANN 丢失对应近邻 | 近似检索或执行配置 | `hnsw_ef`、索引状态、过滤与搜索路径 | 更换所有原始文档 |
| 初始候选有正确证据，融合/截断后没有 | 排序、候选深度或融合 | 每路 Run、融合 Run、Rerank 结果、最终 K | 盲目增大 Chunk Size |
| 最终排序正确，LLM 输入缺少事实 | Context 组装、去重、截断 | 最终 Prompt 的证据 ID、Token 预算 | 只改 Embedding/HNSW |

**重要边界**：一个问题可能同时存在多个瓶颈；上表用于定位**有证据支持的优先排查方向**，不是“看到症状就能唯一判定故障”的规则。

#### 【一次完整的故障：入职不满一年能否申请年假】

以下是用于展示因果关系的**教学情境，不是妙码 AI Flow 的实际线上故障**：

用户 Query：“入职不满一年的员工可以申请年假吗？”

现行制度中的参考证据为：

~~~text
C8：入职不满一年的员工不适用本年假制度。
~~~

当前 Top-5 未召回 C8，表现为 Evidence Recall@5=0。接下来需要逐层排除，而不是立刻尝试五种参数。

#### 【第一层：原始数据是否存在且已正确入库】

先检查：

1. 当前知识库是否包含**现行版本**的休假制度？问题是否处于该调用者有权检索的知识范围？
2. 原始文档能否定位到“入职不满一年不适用”的条款？
3. 解析产物和实际入库的 Chunk 中是否存在这句话及其否定关系？
4. 文档处理是否成功、所选 Collection 是否正确、更新/删除是否遗留旧 Point？

反例：

~~~text
原始 PDF：包含 C8 的完整规定
    ↓ 解析遗漏了尾部条款
Chunk 集合：没有该条
    ↓
Embedding、HNSW、Top-K 再好也无法找回从未入库的事实
~~~

此时优先修复文档解析、增量处理或数据完整性。仅仅增大 `topK` 不能检索不存在的 C8。

**不要把“向量查询没有结果”直接视为未入库**：先通过可信的原文/文档索引/存储检查确认事实是否存在，避免把过滤范围或阈值造成的不可见误判为缺失。

#### 【第二层：Chunking 是否保留了事实的完整语义】

假设原文完整，但切分后的内容是：

~~~text
Chunk A：入职不满一年的员工
Chunk B：不适用本年假制度
~~~

这两个片段单独看时都不包含完整的“适用人群—限制结论”关系。系统可能检索到 A，却无法判断到底是否适用，或只检索到 B 而不知道主体。

排查的重点不是“Chunk 字符数够不够大”，而是：

- 限制条件（入职不满一年）是否和结论（不适用）建立了可检索的联系？
- 章节标题、文档级背景及对应 Offset 是否保留，后续能否取回父段落？
- 相邻或父子片段能否组合恢复完整事实？
- 更换 Chunk Size/Overlap 后，是否真的提升了多条件、例外规则的 Evidence Recall，并且没有牺牲其他查询类型？

可进行结构化切分、按标题补充背景、父子检索或合理调整边界的单项实验。**Chunk 越大越好是错误命题**：过大的片段可能包含更多噪声、提高存储/上下文成本，并影响相似度区分能力。

#### 【第三层：为什么需要先做 Exact kNN 对照】

当我们确认 C8 已正确表示、当前查询范围内可见后，应区分：

1. **当前向量空间本身不善于把 C8 排在前面**；
2. **向量空间认为 C8 很近，但 ANN 近似索引没有找到它**。

为区分二者，保持**相同 Query Vector、Embedding 版本、距离度量、语料快照、过滤条件、阈值口径与 K**，运行 Exact kNN 和 ANN 两次查询。

Qdrant 的 `SearchParams(exact=true)` 会强制精确搜索，对照 ANN Top-K 的近邻集合；文档见 [Measuring ANN Recall](https://qdrant.tech/documentation/tutorials-search-engineering/ann-recall/) 和 [Search](https://qdrant.tech/documentation/concepts/search/)。

**情况 A：Exact 也找不到 C8（业务参考证据）**：

~~~text
Ground Truth：C8

Exact Top-5 = [C3, C5, C1, C4, C9]
ANN   Top-5 = [C3, C5, C1, C4, C9]
~~~

若 Exact 和 ANN 一致，`ANN Recall@5=100%`，但 `Evidence Recall@5=0`。这是**向量相似度排序与业务相关性目标不一致**的示例，而不是图搜索近似误差。应检查文本与 Query 的语义匹配、向量模型、搜索阈值与授权范围；随后测试查询改写、精确词项匹配或 Hybrid Search 等能力。

**情况 B：Exact 找到了 C8，ANN 没有**：

~~~text
Ground Truth：C8

Exact Top-5 = [C3, C8, C1, C4, C9]
ANN   Top-5 = [C3, C5, C1, C4, C9]
~~~

两组向量 Top-5 的交集是 {C3,C1,C4,C9}，因此本例 `ANN Recall@5=4/5=80%`；Exact 的 `Evidence Recall@5=1`，ANN 的 `Evidence Recall@5=0`。此时有证据进一步检查近似索引的搜索参数、索引构建情况及过滤方式。需要注意：**总体 ANN Recall 和 Evidence Recall 不是同一个分数，单个查询上的业务命中也不总是随 ANN Recall 单调变化**。

**索引状态是前提**：Qdrant 可能对没有建立 HNSW 或满足扫描策略的 Segment 使用精确扫描，这时修改 `hnsw_ef` 并不影响该部分搜索；必须核对 Collection/Segment 的索引状态、过滤 Payload Index 和实际搜索路径，不能认为调用“向量搜索 API”就必然走 HNSW。

#### 【第四层：初始召回是否需要改变检索方式】

如果 C8 在精确向量检索中仍排名靠后，可以先依据 Query 类型提出假设。

示例：对于“入职不满一年”“不适用”这样的条件/否定表达，当前向量模型可能不能稳定区分主体和规则；对于 `E-1042`、SKU、代码标识符等，精确词项匹配可能更有价值。

可比较的实验条件包括：

~~~text
固定 Ground Truth / 语料 / 版本 / 权限
               ↓
             同一 Query
               ↓
      ┌────────┼─────────┐
      ▼        ▼         ▼
  Dense ANN  Text/BM25   Hybrid
      │        │         │
      └────────┼─────────┘
               ▼
          对比相同 K 的：
          Evidence Recall、MRR、nDCG、P95、成本
               ↓
     按 Query 类型检查改善与退化
~~~

**术语边界**：简单的子串匹配不等于 BM25，定义了 `hybrid` 模式也不等于实际已经执行了稠密+稀疏双路检索。是否采用 BM25、Query Rewrite 或混合检索，必须看真实失效的查询类型与对照结果。

#### 【第五层：融合、重排与 Top-K 截断是否丢失正确证据】

假设初始召回：

~~~text
Dense Top-20 包含 C8
Text  Top-20 也可能包含 C8
                ↓
融合（Fusion）
                ↓
Final Top-5 不包含 C8
                ↓
LLM 无从使用这条证据
~~~

这里初始检索可能已经找到正确资料，但融合得分、Rerank 排序或者最终 Top-K 截断将其排除。应该检查**每条检索通道的候选 ID/排名、融合后排序、最终截断前后 ID 集合**。

特别注意三点：

- **候选集合与排序不是同一个目标。**如果正确证据在初始候选里却不在最终 Top-5，应该研究 Fusion/Rerank/最终 K，而不是直接归责 Embedding 或 HNSW。
- **“增加初始 Top-K”不保证最终 Context 更完整。**更多候选可能只增加延迟和噪声；必须检验融合/重排是否能利用这些新候选。
- **同一 K 下的一次 Recall 差异不能唯一证明是哪一行代码导致**，还应检查相同语料、合法权限、去重、阈值及是否存在动态候选扩展。

#### 【第六层：最终 Context 是否仍然保留必要证据】

假设：

~~~text
候选 Top-20：含 C8
Rerank Top-5：含 C8
Prompt 实际 Context：不含 C8
最终答案：缺少适用人群的限制条件
~~~

此时要检查 Context Construction：是否因 Token 预算、合并去重、父章节提取、格式化错误或来源过滤导致证据丢失。

应分别保存或记录**候选排序**和**最终确实传入模型的证据 ID/事实支持关系**。最关键的结论：

> 初始 Evidence Recall 高，不证明最终 Context 完整；最终 Context 完整，也不证明 LLM 一定会生成正确答案。

若 C8 已进入最终 Context，模型仍回答“入职半年适用年假”，则故障可能在模型生成、证据理解或旧版本引用，应进入 Faithfulness 与 Answer Correctness 的评测。

#### 【分阶段指标如何用于归因：哪些差值能比较、哪些不能】

教学示例：假设固定 Ground Truth 和一批 Query，做不同方式的实验，获得如下结果：

| 阶段或方案 | 评价对象 | 示例结果 |
|---|---|---:|
| Exact kNN，Top-20 | 业务 Evidence Recall@20 | 90% |
| HNSW，Top-20 | 业务 Evidence Recall@20 | 88% |
| 稠密 + 词项候选合并，Top-20 | 业务 Evidence Recall@20 | 94% |
| 融合后 Top-5 | 业务 Evidence Recall@5 | 83% |
| 最终 Context | 必要事实覆盖比例 | 76% |

**全部为假设数字，并非项目实际评测**。还需注意：

1. `Exact kNN` 与 `ANN` 的候选集合不同，可用同一 Query、K、语料和过滤计算它们的 **ANN Recall@K**，另分别计算两套结果的业务 Evidence Recall。这两个指标不能混称。
2. `Dense` 与 `Hybrid` 是**可比较的策略分支**，并非简单的流水线“下一步”；Hybrid Recall 比 Dense 高只能说明本示例多路方案覆盖更多证据，不代表它必然更优。
3. Top-20 与 Top-5 的 Recall 本来受**截断深度**影响：如果前 20 中包含正确证据，后 5 没有，这可能只说明 K 缩小，并不自动证明 RRF 算错。需要对照排序和截断前后的结果。
4. “必要事实覆盖率”与 Chunk-ID Evidence Recall 的评价粒度不同，不能把 83%→76% 的百分点差值直接解释为“Context 额外丢失 7% 个 Chunk”。应在逐 Query 的事实标注下另算上下文阶段损失。
5. 总体平均值可能掩盖低频但高风险的失败，应按精确编号、条件/否定、多证据、过期/版本及无答案查询分类诊断。

只有在明确相同的评价对象、分母、K、语料和权限时，阶段差值才有更直接的可比意义。否则需要使用**同一查询的证据传递轨迹**解释丢失位置。

#### 【将诊断转化为可验证的优化实验】

推荐按以下顺序组织一次实验：

1. **固定 Baseline**：冻结当前 `corpusVersion`、`datasetVersion`、Query 列表、Ground Truth、Embedding 模型、过滤权限、`topK`/`threshold`、索引状态；记录候选 ID/排名、Recall、nDCG、P95 延迟与资源成本。
2. **找到失效模式**：例如多条精确编号类 Query 在 Dense Top-10 缺证据，但词项搜索能命中。
3. **提出明确假设**：例如“关键词匹配将改善编号类 Query 的候选覆盖，而不是改善普通语义问题”。
4. **只改变关键方案**：增加或切换一种实际可用的词项检索策略，其他条件固定；不要同时换 Chunking、Embedding、Top-K、权重和索引参数。
5. **观察质量与代价**：除了总体 Recall、MRR、nDCG，按 Query 类型比较改善、退化；记录 P50/P95、检索服务成本、异常及无结果率。
6. **验证稳健性**：在未用于选择参数的验证/测试查询上复核，必要时通过重复运行、置信区间或统计检验判断增益是否可能只是样本噪声。

对改变索引构建、Embedding 或 Chunking 的实验，无法严格做到其他所有条件不变（例如 Chunk ID 会变化）；此时要**固定业务事实和 Query**，对不同版本建立可审核的证据映射，清楚披露语料重建带来的混杂因素。

#### 【与妙码 AI Flow 的现有源码如何对应】

项目业务链路包含文档处理 → 切分 → Embedding → Qdrant Collection 存储 → 在线 Retriever。需要知道每个模块在干什么，才能选择采集位置：

- [`document-processor.ts`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts) 是文档入库服务，负责生成 Chunk、Embedding 后写入 Qdrant。诊断“是否有知识、是否切分完整”应先回溯该入口和对应原文/数据状态。
- [`QdrantVectorStore.search()`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts) 用 `limit: topK`、`score_threshold: threshold` 和 `knowledgeBaseId` 过滤调用 Qdrant，返回 `chunkId`、`documentId`、`content`、`score`。该结果可作**向量搜索 Run**。源码当前未在此调用中设置 `exact:true`，因此要做 Exact kNN 对照需要额外提供独立的测试调用或显式的搜索参数，而不能声称当前 API 已有一键 Exact 对照。
- [`VectorRetriever.retrieve()`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts) 把 Query 交给 Embedding 服务得到 Query Vector，再调用 `vectorStore.search`；此处可以记录**初始向量候选排序**。
- [`HybridRetriever.retrieve()`](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts) 支持 `vector/fulltext/hybrid`；在 `hybrid` 模式下，`expandedTopK = ceil(topK*1.5)`，再按加权 RRF 进行融合（常数 `k=60`，默认向量权重 `vectorWeight=0.7`），最后截取 `topK`。若 `FulltextSearchProvider` 不存在或未返回结果，则降级为向量结果，不保证真正实现双通道召回。这里可作为**融合前后对照**的测试位置。
- 同一源码中的 `textSearch()` 是从 Qdrant `scroll(limit:1000)` 获取一批片段后，在应用层进行字符串出现频次评分。它**不是 BM25**，也没有在该调用中遍历全部分页；因此不能仅因类名叫“文本搜索”就把它当成完整关键词索引能力的基线，更不能把它等同于 BM25 的倒排索引。

上述均为对**已核对源码行为**的说明；它们不意味着项目已经接入 Ground Truth、记录全部阶段 Trace、部署真正的 BM25 检索服务或实现 Reranker。是否值得新增这些能力，应由真实实验决定。

#### 【最小可观测性：怎样知道证据究竟在哪一步消失】

可以参考以下**设计草案**（非项目既有实现）：

~~~typescript
type RetrievalDiagnosticTrace = {
  queryId: string
  corpusVersion: string
  datasetVersion: string
  sourceEvidenceIds: string[]       // Ground Truth，在受限评测系统内保存
  denseCandidateIds: string[]       // Dense 初始 Run
  exactCandidateIds?: string[]      // 仅在执行了 Exact 对照时存在
  textCandidateIds?: string[]       // 实际启用第二路检索时才有
  fusedCandidateIds?: string[]      // 实际发生融合时才有
  rerankedCandidateIds?: string[]   // 实际经过 Rerank 时才有
  finalContextEvidenceIds?: string[]// 实际送给 LLM 的来源
  retrievalMs: number
  contextTokenCount?: number
  searchConfig: {
    mode: "vector" | "fulltext" | "hybrid"
    topK: number
    threshold?: number
  }
}
~~~

逐 Query 将 Ground Truth ID 映射到各阶段 ID，记录首次不再出现的位置；如果 Chunk 边界变化、父子扩展或同义证据替换，应按原子事实和源文档映射判断，不能简单用原 ID 做全部归因。生产环境还需为这些 Trace 配置权限、必要字段脱敏、采样和存储保留策略，避免记录不必要的敏感文本。

#### 【边界与进一步验证】

- **权限过滤是先决条件**：即使 Ground Truth 引用某份文档，也必须核实当前 Query 对该文档是否有合法访问权；否则不应将“不返回未授权证据”视为检索失败。
- **阈值导致的空结果**：`score_threshold` 过高可能提前过滤正确片段，此时要检查阈值与 Embedding 分数分布，不能归因于 HNSW。
- **索引构建状态**：Qdrant 未建 HNSW 或选择精确扫描时，`hnsw_ef` 的变化不一定影响查询；优化前检查真正生效的执行策略。
- **样本与查询类型**：单条 Exact/ANN 的比较是诊断证据，不足以证明总体的 ANN Recall 达标；需要代表性的 Query 集、重复性与按类型统计。
- **生成层不混淆**：如果正确证据已经进入最终 Context，但模型依然回答错误，应继续看 Faithfulness/Answer Correctness，不再把所有问题笼统记在 Retriever 名下。
- **成本约束**：在 Recall 提升很小的情况下显著增加 P95/内存/Token 成本，不一定是适合业务的改进。

#### 【面试标准回答】

RAG 检索优化应先建立以 Ground Truth 为标准的固定评测基线，再根据**质量第一次损失的位置**选择要研究的环节，而不是盲目增大 Top-K、修改 Chunk Size 或 HNSW 参数。

先检查源文档、版本、授权、解析与入库是否正确，确认参考事实确实存在且被 Chunk 完整表达；然后对同一 Query Vector、语料、距离度量与过滤范围比较 Exact kNN 和 ANN。如果 Exact 自身也找不到业务正确证据，重点研究 Embedding 表示、查询表达、阈值以及词项/混合检索；如果 Exact 能找到但 ANN 遗漏，才有依据研究 `hnsw_ef`、索引状态及过滤策略。

如果正确证据已在初始候选中，则检查融合、Rerank 和最终 Top-K 是否改变排序并丢失证据；若排序后仍保留但最终 Prompt 没有，问题发生在 Context Construction。每次针对清楚的假设做受控实验，在同一 Ground Truth 下比较 Evidence Recall、MRR、nDCG、P95 和成本，并用独立查询验证收益。**优化的是业务证据质量，不只是几何最近邻的搜索速度。**

#### 【权威资料与项目源码】

1. [Qdrant：What to Check Before Tuning a Qdrant Collection](https://qdrant.tech/documentation/search-tuning/before-tuning-a-qdrant-collection/)：按查询失效症状选择检查与调优方向，注意未建索引、过滤与评测设置。
2. [Qdrant：Measuring ANN Recall](https://qdrant.tech/documentation/tutorials-search-engineering/ann-recall/)：Exact kNN 与 ANN 对照、`hnsw_ef` 的召回/延迟取舍。
3. [Qdrant：Search](https://qdrant.tech/documentation/concepts/search/)：搜索参数中的 `exact`、`hnsw_ef`、`limit`。
4. [Qdrant：Measuring Retrieval Relevance](https://qdrant.tech/documentation/search-evaluation/retrieval-relevance/)：有标注的业务检索相关性评测。
5. 项目源码：[文档处理](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts)、[VectorRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts)、[HybridRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)、[QdrantVectorStore](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)。

---

## 【下一题讨论方向：如何评价 RAG 最终生成答案的正确性、忠实性和引用准确性】

下一题在 Retrieval → Fusion → Rerank → Context Construction → Generation 的闭环基础上区分：

- Faithfulness：答案中的断言是否有实际提供给模型的 Context 支持；
- Answer Correctness：最终结论是否符合外部 Ground Truth / Reference Answer；
- Citation Accuracy：引用的具体来源是否真的支持对应断言。

重点研究三类反例：“回答事实真实但当前证据不支持”“忠于提供的过期资料却与现行事实不符”“答案正确但引用了错误来源”。再分析如何结合确定性规则、人工标注和 LLM-as-Judge 构建可靠评测。**这里仅记录下轮提问方向，不提前写标准答案。**
