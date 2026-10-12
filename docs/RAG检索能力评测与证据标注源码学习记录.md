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

## 【下一题讨论方向：Recall@K、Precision@K、Hit@K、MRR 与 nDCG 的评价目标与计算机制】

先用相同的 Ground Truth 和有序检索结果逐个计算各指标，解释“有没有找到正确证据、找齐没有、噪声多不多、正确证据排得够不够靠前”的不同含义；然后说明单事实、多事实、分级相关性以及 Top-K 不足时该选择哪些指标。**本节只记录下一次讨论方向，不提前写入尚未讨论的标准答案。**
