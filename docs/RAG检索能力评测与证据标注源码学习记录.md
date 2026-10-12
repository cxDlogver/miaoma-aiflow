# RAG 检索能力评测与证据标注源码学习记录

## 【文档定位与讨论规则】

本篇是《[RAG 知识库构建与向量检索源码学习记录](./RAG知识库构建与向量检索源码学习记录.md)》后续的**项目分析与面试讨论记录**，以已经掌握的文档切分、Embedding、Qdrant 向量存储、HNSW 与 Top-K 为基础，研究如何为 RAG 检索建立可验证的质量基线。采用“问题背景 → 知识概述 → 运行机制 → 数据示例 → 真实项目链路 → 验证与边界 → 标准回答”的写法。每次只归档**已讨论并确认的一个问题**；下一题先在对话中讨论，不提前把猜测、提问提纲或中间分析写成既定结论。

原理和方法应脱离项目独立成立；**妙码 AI Flow** 的业务上下文、源码与实现现状仅在相应节点作实战验证。源码的存在只能证明该功能已实现，不能自动证明检索指标达标。涉及项目的未实现部分明确标为**建议方案**，未执行的数值例子明确标为**教学示例**，不虚构实验数据。

与通用知识体系的关系：

- [RAG 与知识库工程完整知识体系](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/R-RAG与知识库工程完整知识体系.md)：离线知识供给、在线检索生成、评测反馈和横切治理的完整主线。
- [向量知识表示、存储与索引完整链路](https://github.com/cxDlogver/cx-learn-notes/blob/main/Full-Stack-AI-NOTES/X-向量知识表示存储与索引完整链路.md)：Chunking、Embedding、向量距离、HNSW、Payload Filter 和 Segment 聚合的通用机制。
- 本篇聚焦**如何定义正确证据、怎样得到检索评测基线、如何解释不同失效层**。混合检索、Rerank、答案忠实度等专项尚未完整展开，不会为了凑齐体系而假定已经掌握或实现。

## 【第一题：如何定义 RAG 检索能力，并判断知识库是否真正找到了正确证据】

### 【提问与知识目标】

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

### 【知识概述：检索能力应同时考虑相关性、覆盖性、有效性和效率】

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

### 【Ground Truth、Qrels 与评测集的输入输出】

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

### 【Hit、Recall 与证据完整性如何区分】

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

### 【项目实践：妙码 AI Flow 目前已经具备哪些基础数据】

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

### 【最小评测方法：先用现有 VectorStore 建立基线】

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

### 【诊断边界：精确向量近邻与业务参考证据不应混为一谈】

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

### 【实践边界与下一步验收】

目前可以完成**独立的基础检索相关性评测**，但尚不能用它直接断言完整 RAG 系统的答案忠实度、业务成功率或生成质量。那些能力要求额外捕获模型实际收到的上下文和最终输出。

评测集的基本质量门禁应包括：真实且多样的查询、准确的参考证据、标注粒度一致、源文档版本可追溯、用户权限匹配。对于未标注的候选，**“没有列在 Qrels 中”不必然等于人工确认不相关**：真实大语料很难穷举全部相关文档，应通过多路检索结果池化、人工复核与补标逐步提高 Ground Truth 覆盖。对精确编号、多证据、否定、过期文件、无答案查询应单独查看失败案例，避免平均分掩盖问题。

### 【面试标准回答】

RAG 检索评测首先要明确评价的不是向量距离本身，而是用户问题与所需证据之间的相关性。应先构建 Query—Evidence 的 Ground Truth/Qrels，声明评价粒度是 Document、Chunk 还是原子事实及证据集合，再在固定知识库版本、权限范围和检索配置下执行查询，形成有序结果 Run。

在单事实和多事实问题上，至少区分“是否命中任意正确证据”与“正确证据是否完整覆盖”；例如两条证据只召回一条时 Hit@K=1，Evidence Recall@K=0.5，但不一定能够回答全部问题。文档级命中不必然表示 Chunk 级命中，Chunk 更新还可能引起标注 ID 漂移。

最后要分开 ANN Recall 与业务 Evidence Recall：前者以精确向量 Top-K 为基准，衡量近似索引误差；后者以人工证据标注为基准，判断检索是否真正满足业务问题。这样才能确定问题出在知识源、切分、语义表示、索引近似、排序还是下游证据使用，而不是盲目增大 Top-K 或修改 HNSW 参数。

### 【本轮权威依据与项目源码】

1. NIST TREC：[Relevance Judgments](https://trec.nist.gov/data/reljudge_eng.html)。相关性标注与检索语料/问题的匹配原则。
2. Qdrant：[Measuring Retrieval Relevance](https://qdrant.tech/documentation/search-evaluation/retrieval-relevance/)。Gold Query Set、Qrels/Run、文档/片段标注与检索相关性评价。
3. Qdrant：[Measuring ANN Recall](https://qdrant.tech/documentation/tutorials-search-engineering/ann-recall/)。Approximate 与 Exact kNN 的区别。
4. NIST TREC：[How to TREC](https://trec.nist.gov/howto.html)。Qrels 和检索评测术语。
5. 项目源码：[VectorStore 搜索实现](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)、[知识库类型定义](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/types.ts)、[文档入库处理](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts)。

---

## 【第二题：Recall@K、Precision@K、Hit@K、MRR 与 nDCG 分别衡量什么】

### 【提问与知识目标】

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

### 【知识概述：五种指标在回答不同问题】

| 指标 | 实际判断 | 适用重点 | 无法单独证明什么 |
|---|---|---|---|
| Hit@K | 前 K 条有没有至少一条正确结果 | FAQ、单答案/至少一次命中 | 多证据问题是否找齐 |
| Recall@K | 全部正确证据中找到了多少 | 候选召回阶段，避免漏证据 | 排序是否靠前、噪声多少 |
| Precision@K | 返回的前 K 条有多少是相关的 | 候选噪声/有限上下文利用 | 有没有找齐语料中的所有证据 |
| RR / MRR | 第一条正确证据的位置是否靠前 | 单答案、用户优先使用首条 | 第二、第三条必要证据在哪里 |
| nDCG@K | 重要证据是否排在前面、整体排序是否接近理想 | 重排、融合、分级相关性 | 数据未入库或事实是否正确 |

**K 是同一运行结果的前缀截断深度，不是 HNSW 的 `hnsw_ef` 或 Embedding 维度**。初始检索可能返回 50 条候选，而最终送入 LLM 的只有 5 条，因此两阶段应分别评价 `Recall@50` 和 `Context 证据覆盖@5`，不能用前者代替后者。

### 【Hit@K：前 K 条有没有任何一条正确证据】

对单个 Query：

~~~text
Hit@K(q) = 1，前 K 条至少出现一条相关证据
Hit@K(q) = 0，否则
~~~

示例：Top-1 只有无关的 C3，故 `Hit@1=0`；Top-2 有 C1，`Hit@2=1`；Top-3 与 Top-5 依然为 1。

如果存在 100 个 Query，其中 80 个 Query 的 Top-5 至少包含一条相关证据，则 `Hit Rate@5=80/100=80%`。它直观但不能表示多证据问题找得够不够完整：对当前场景 `Hit@2=1`，尽管 C2 完全没出现。

### 【Recall@K：标注的全部正确证据被覆盖多少】

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

### 【Precision@K：前 K 条中有多少条真正相关】

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

### 【MRR：第一条正确结果排在第几名】

单个 Query 使用 **RR（Reciprocal Rank，倒数排名）**：

~~~text
RR(q) = 1 / rank_firstRelevant(q)

没有任何正确结果进入本次评测范围时，该查询的 RR 记为 0。
MRR = (所有 Query 的 RR 之和) / Query 总数
~~~

示例的首条正确证据 C1 在第 2 名，因此 `RR(q)=1/2=0.5`。如果另一条 Query 首条正确证据排第 1，`RR=1`；两条 Query 的 `MRR=(0.5+1)/2=0.75`。

若采用截断 `MRR@K`，只有 Top-K 内出现的首条正确结果才贡献分数；当前示例 `RR@1=0`、`RR@2=0.5`。单个 Query 的结果应称 RR，不要把一个查询的 0.5 错称“MRR=0.5”。

**适用边界**：MRR 适合用户只需要一条答案或只看第一条搜索结果的场景；但对于“申请时限+审批人”这样必须找齐两条事实的问题，MRR 在找到 C1 后不再关注 C2，所以不应单独作为能力目标。

### 【nDCG@K：同时考虑相关性等级与结果位置】

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

### 【同一组数据从 Top-1 到 Top-5，指标如何变化】

| 指标 | @1 | @2 | @3 | @5 |
|---|---:|---:|---:|---:|
| Hit@K | 0 | 1 | 1 | 1 |
| Evidence Recall@K | 0% | 50% | 50% | 100% |
| Precision@K | 0% | 50% | 33.3% | 40% |
| RR@K（单条 Query） | 0 | 0.5 | 0.5 | 0.5 |
| nDCG@K（上述分级标签） | 0 | 0.521 | 0.521 | 0.640 |

这里 `nDCG@2≈(3/log2(3))/3.631≈0.521`，因为理想排序前两名本应分别为 C1、C2。**Recall 随 K 增大不下降**（固定结果和标签时），但 Precision 并不单调；因此不能只看其中一个指标判断某个 Top-K 配置更优。

### 【工程实践：在什么阶段计算什么指标】

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

### 【面试标准回答】

Hit@K 表示前 K 条是否至少命中一条正确证据；Recall@K 表示所有正确证据中有多少进入了前 K 条；Precision@K 表示前 K 条中相关候选所占比例。RR 是单个 Query 的首条相关结果排名倒数，多 Query 取平均才得到 MRR；nDCG 则综合相关性等级与位置折损，衡量排序与理想排序之间的差距。

选指标应先确定系统消费结果的方式：初始候选阶段优先保证 Evidence Recall，多事实问题还应检查必要事实覆盖；用户只看第一条时可关注 MRR/Hit@1；融合与 Rerank 关注 nDCG；最终上下文还需检验证据是否确实进入模型输入，而非只报告较高的初始 Recall。精确向量搜索对照 ANN 的 Recall 与人工标注的业务 Evidence Recall 是两种不同评测，不能混用。

### 【资料依据与后续边界】

- [Qdrant：Measuring Retrieval Relevance](https://qdrant.tech/documentation/search-evaluation/retrieval-relevance/)：采用 Qrels/Run 和 ranx 评测 `Recall@K`、`MRR`、`nDCG@K`，并按系统消费场景选取 K。
- [Qdrant：Before Tuning a Collection](https://qdrant.tech/documentation/search-tuning/before-tuning-a-qdrant-collection/)：不同指标可能选出不同的“最佳参数”；应先确定优化目标。
- [妙码 AI Flow 向量检索器源码](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts) 与 [混合检索器源码](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)：现有检索链路的可观察节点和候选排序机制。

---

## 【第二题追问：Context Construction 是否也属于 RAG 评测】

### 【提问与结论】

**是。Context（上下文）质量是完整 RAG 评测不可缺少的对象。**但需要先区分：

- **Context Construction（上下文构建）**是系统实际执行的环节：它从检索候选中挑选、去重、补充、压缩、截断并组织 LLM 最终收到的证据文本。
- **Context Evaluation（上下文评测）**是对检索所得材料或者最终模型输入的相关性、完整性和可用性进行评价。

不同研究和评测框架对术语的归属不完全一致。Ragas 将 `Context Precision`、`Context Recall` 放在 RAG 相关评测指标中，通常用来衡量检索到的上下文是否有用；它们**不必然**意味着工程系统里有一个独立的名为 `ContextEvaluator` 的运行组件，也**不自动**覆盖最终 Prompt 组装导致的证据损失。必须先明确一个指标的输入数据来自哪个阶段。

### 【知识概述：检索输出与最终 Context 是不同的数据对象】

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

### 【同一问题：召回成功而上下文构建失败的完整过程】

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

### 【Context 的几种评价维度及边界】

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

### 【Ragas 中 Context Precision 与 Context Recall 的含义】

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

### 【与答案生成评测的区别】

Context 评测判断“模型**看到了什么**”；Faithfulness（答案忠实度）判断“模型**说出的断言有没有证据支持**”；Answer Correctness（答案正确性）进一步检查“回答是否符合真实事实和问题需求”。

例如最终 Context 正确包含 C1/C2，模型却说“审批将在两小时内完成”，这个两小时的信息没有证据支持，属于生成阶段的 Faithfulness 问题。另一种情况是旧版政策被错误选入 Context，模型忠实引用旧版但结论过时，此时答案可能忠于 Context，却仍然不符合现行规则。**这两个问题需要追溯不同的失效阶段。**

### 【项目实践：应该在哪里采集哪些数据】

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

### 【面试标准回答】

Context 属于 RAG 的评测对象，但 Context Construction 是运行阶段，Context Evaluation 则评估这个阶段交付给 LLM 的资料是否相关、完整、可靠。检索器输出和最终 LLM 输入通常不相同：候选在融合、重排、去重、父章节扩展或 Token 截断过程中可能丢失证据。因此初始 Evidence Recall@K 很高，不代表最终 Context 一定能支持全部答案事实。

应区分检索相关性与排序、最终 Context 的必要事实覆盖、Token 成本与冗余、来源版本和权限有效性。Ragas 的 Context Precision 通常衡量相关 Chunk 在检索列表中的排序质量，Context Recall 关注参考答案断言能否从提供的上下文找到支持；工程侧还可以单独记录最终 Context Fact Coverage、被丢弃证据及原因。

最后，Context 完整也不保证生成正确，应继续区分 Faithfulness（生成是否受证据支持）与 Answer Correctness（事实与问题是否正确）。这样才能根据质量损失位置决定该优化检索、重排、上下文构建还是生成环节。

### 【资料依据】

1. Ragas：[Context Precision](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/)。
2. Ragas：[Context Recall](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/)。
3. Ragas：[Available Metrics](https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/)。
4. Qdrant：[Measuring Retrieval Relevance](https://qdrant.tech/documentation/search-evaluation/retrieval-relevance/) 与 [Evaluating Pipeline Output Quality](https://qdrant.tech/documentation/search-evaluation/pipeline-output-quality/)。
5. 项目源码：[VectorRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts)、[HybridRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)。

---

## 【第三题：如何构建可靠的 RAG Ground Truth 评测数据集】

### 【提问与知识目标】

前两题建立了评价对象（Query、Ground Truth/Qrels、Run）和 Hit@K、Evidence Recall@K、Precision@K、MRR、nDCG 等指标。**指标计算依赖一个前提：我们能够可靠地区分哪条知识是正确证据，且测试问题足以代表系统应处理的实际需求。**

本题讨论如何从真实查询、人工标注与 LLM 合成数据构造可复用的检索评测集，重点研究证据标注完整性、测试场景覆盖、语料版本、偏差与可复现性。评测数据集不是代码里的几条 `query→expectedChunkId` 测试常量，而是能长期衡量检索方案是否变好的**标准化实验资产**。

### 【知识概述：Query 的来源不等于 Ground Truth 的正确性】

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

### 【真实查询、人工标注与 LLM 合成各自负责什么】

| 来源 | 获得方式 | 主要贡献 | 需要控制的风险 |
|---|---|---|---|
| 真实用户 Query | 脱敏的查询日志、明确的用户反馈、历史问答 | 真实措辞、问题频率、实际意图 | 高频问题偏置、隐私、没有天然正确答案、点击位置偏差 |
| 人工设计与标注 | 产品/领域专家提出问题、查阅现行知识确认事实 | 严格的证据定义、高风险与边界问题覆盖 | 标注费用、个人理解差异、漏标 |
| LLM 合成 Query | 从审核过的源文档与事实生成不同表达和难度的询问 | 低成本扩充覆盖、压力测试复杂场景 | 问句复述原文、事实幻觉、误以来源 Chunk 是唯一答案 |

推荐的职责分工不是固定的百分比分配，而是：

- **真实查询决定主分布**：尽量代表线上会出现的实际问题；按主题/意图/难度分层抽样，避免高频简单问题淹没少量重要困难问题。
- **人工审核决定参考标准**：至少对进入正式回归集的关键事实与证据对应关系进行核验；有争议的标签应由规则和复核解决。
- **LLM 负责扩展**：生成同义表达、复杂限定条件、多证据问题、无答案和难例，但正式入库前进行事实校验。合成数据和真实数据分别报告评测结果，避免总体分数被“容易的合成问题”主导。

### 【Ground Truth 的实际构建流程】

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

### 【人工标注的粒度：从 Chunk ID 扩展到必要事实】

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

### 【怎样设计具有代表性的 Query 覆盖】

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

### 【LLM 在数据集构建中的合理工作边界】

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

### 【如何在妙码 AI Flow 当前检索架构上落地】

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

### 【评测数据集与检索系统的版本应如何关联】

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

### 【实践边界与质量检查】

- **标签完整性**：未被 Pool 覆盖的结果状态是未知，不能默认为“不相关”；对新检索器发现的合理结果追加审核。
- **用户反馈偏差**：点击受名次、展示方式影响；点击率不是天然 Qrels。
- **无答案问题**：对于无可用证据的 Query，不直接套用分母为 0 的普通 Recall；单独测“是否错误地自信返回”和后续拒答能力。
- **权限与隐私**：生产查询需脱敏、限制评测数据访问，遵守来源数据授权；测试不能无权限检索敏感知识以提高 Recall。
- **统计可靠性**：除整体平均，至少按 Query 类型和来源分组；对于微小差异，在样本不足、标签不全时不应轻率宣布新方案优越。
- **避免只考自己擅长的题**：生成测试问题与被评估的模型/检索器高度同源时，需保留独立验证集和真实查询集，避免评测偏乐观。

### 【面试标准回答】

RAG 检索评测的 Ground Truth 是经过验证的 Query—Evidence 相关性标注，而不是模型自动生成的参考答案或初始检索器的 Top-K。数据集应结合真实用户查询、人工设计/审核和 LLM 合成数据：真实查询提供实际分布，人工审核保证事实与证据关系可信，LLM 用于扩充同义表达、复杂问题和边界场景。

构建时先确定任务和知识库快照，收集并分类 Query，再通过人工查找、多路检索 Pooling 收集候选证据，审核相关性、必要事实、文档生效版本与权限，形成 Qrels。对多事实问题还应保留原子事实及可替代的支持证据，避免只靠 Chunk ID 命中判断答案完整性。

评测集按语料/标注/检索配置版本管理，使用同一套已审核样本比较不同检索方案，分别统计真实查询与合成查询、普通与挑战用例。对于未标注但可能正确的结果要复核补标，而不能默认错误。这样构建的 Ground Truth 才能作为后续 Chunking、Embedding、Hybrid Search、Rerank 等技术改进的稳定对照基线。

### 【权威资料与源码】

1. [Qdrant：Measuring Retrieval Relevance](https://qdrant.tech/documentation/search-evaluation/retrieval-relevance/)：真实用户日志、人工标注、LLM 合成及评测数据质量风险。
2. [NIST TREC：Relevance Judgments](https://trec.nist.gov/data/reljudge_eng.html)：Pooling、语料与 Qrels 匹配。
3. [NIST：A Comparison of Pooled and Sampled Relevance Judgments](https://www.nist.gov/publications/comparison-pooled-and-sampled-relevance-judgments)：Pool 不完整导致的评测偏差。
4. [Ragas：Testset Generation for RAG](https://docs.ragas.io/en/latest/getstarted/rag_testset_generation/)；[RAG Test Data Generation](https://github.com/vibrantlabsai/ragas/blob/main/docs/concepts/test_data_generation/rag.md)：从知识结构生成 Single-Hop/Multi-Hop、具体/抽象测试场景。
5. [妙码 AI Flow：VectorRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts)、[HybridRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts)、[QdrantVectorStore](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)。

---

## 【下一题讨论方向：如何定位 RAG 检索质量的真正瓶颈，并选择优化方向】

以 Ground Truth、阶段性有序 Run 与固定检索基线为依据，分析“数据未入库/切分丢事实、Embedding 语义不匹配、ANN 近似遗漏、候选召回不足、融合与重排排序差、最终 Context 丢失证据”等不同症状。强调**先判断质量在哪一层损失，再选择参数或机制做对照实验**；下一题先在对话中讨论，不提前把本方向的具体方案当成既有实现。
