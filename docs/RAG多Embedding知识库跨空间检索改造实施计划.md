# RAG 多 Embedding 知识库跨空间检索改造实施计划

> 2026-10-13 修订：方案经源码和固定版本验证后已实施。代码、数据库迁移及原生 BM25/任务生命周期测试已完成；业务环境迁移、真实 Ollama 模型联调和检索质量评测仍需在部署环境执行。运行步骤见 [部署与验证记录](./RAG多Embedding改造部署与验证记录.md)。
>
> 相关设计：[多模型隔离与跨模型检索分析](./RAG多Embedding模型知识库隔离与跨模型检索设计分析.md)。基础链路：[知识库构建与向量检索学习记录](./RAG知识库构建与向量检索源码学习记录.md)。

## 一、审查结论与已确认边界

原计划的主线合理：按 Embedding Space 隔离存储，各空间独立召回，在空间内融合 Dense/BM25，再在空间之间合并排名。原计划仍缺少索引版本过滤、持久任务、公开 WebApp 权限以及固定 BM25 编码协议，直接照原文实现会留下数据混写和权限漏洞。

以下决策已由用户确认：

1. **不兼容旧索引。** 迁移后旧知识库进入 NEEDS_REBUILD，从数据库保留的文档正文重新切分和编码。没有旧查询路径、旧索引回滚或默认空间兼容映射。重建期间停止该库的上传和检索；删除及时生效。原来的 knowledge_chunks 不被重新解释或自动清空。
2. **发布调用只允许访问“快照声明且当前有权”的知识库。** 快照冻结节点配置和静态知识库 ID，不冻结知识库正文。运行时核验当前激活的发布版本、应用拥有者及知识库当前归属；新增到同一知识库并完成索引的文档可被后续调用检索。API Key 和公开 WebApp 使用相同范围。编辑器测试使用登录用户范围。
3. **采用原生 Qdrant BM25。** 服务端和 JS SDK 固定为 1.16.2，使用服务端 qdrant/bm25 推理生成 Sparse Vector。未引入独立编码服务，也不保留正文扫描作为降级路径。

本次不引入统一 Reranker、跨模型向量对齐训练、同一 Chunk 的多套 Dense 表示或没有评测依据的性能目标。

## 二、数据与协议契约

| 实体                        | 职责与不变量                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| EmbeddingSpace              | 不可变空间身份；模型、权重 digest、维度、Cosine、Query/Document 编码版本和 BM25 配置共同参与 SHA-256 指纹 |
| KnowledgeBaseIndex          | 一个知识库的一次索引版本；冻结空间和切分参数；BUILDING、READY、FAILED、RETIRED                            |
| DocumentIndex               | 文档在一个索引版本中的处理结果；同文档/索引唯一，READY 后才可成为证据                                     |
| KnowledgeIndexJob           | PostgreSQL 持久任务；保存处理或清理目标、状态、尝试次数、可执行时间和租约；不随文档物理删除丢失           |
| KnowledgeBase.activeIndexId | 当前目标索引；重建开始即指向新 BUILDING 版本，检索要求该索引 READY                                        |
| deletedAt                   | 文档和知识库删除标记；先隐藏结果，再由持久清理任务删除向量和数据库实体                                    |

每个 Collection 按空间指纹定位为 `knowledge_v2_<fingerprint>`，包含命名 Dense Vector **dense/Cosine** 和 **bm25/IDF** Sparse Vector。命名 Dense 用于明确两种向量的查询目标，不表示一个 Point 保存多个 Dense 模型。

Point 保存 knowledgeBaseId、documentId、indexId、documentIndexId、chunkId、正文、切片序号及 metadata。Point ID 从 **indexId + chunkId** 生成确定性 UUID，避免同空间重建覆盖旧版本。

检索过滤必须是每组 **(knowledgeBaseId = A AND indexId = A的活动版本)** 的 OR，不能把知识库集合和索引集合分别做任意匹配。四个身份字段均创建 keyword Payload Index。

### 编码协议

- Dense：Ollama POST /api/embed；Query 和 Document 都使用 ollama-raw-v1，truncate=false。请求前后核验已冻结的模型 digest；维度必须与空间一致，拒绝非有限数、全零、缺项或批次数量不匹配。不会截断向量、补零或根据查询长度修改维度。
- BM25：qdrant-bm25-multilingual-v1-k1.2-b0.75-avg256；tokenizer=multilingual，language=none，k=1.2、b=0.75、avg_len=256。文档和查询使用同一份配置。
- avg_len=256 是本版本固定协议参数，不是实时计算的平均文档长度。更改分词器或参数必须形成新的空间和索引版本。
- Qdrant 1.16.2 的 IDF 使用所在 Collection/Shard 的统计范围，知识库过滤不会重新计算库内 IDF。需要严格按库局部 IDF 时，应另行设计 Collection 划分或升级后的 corpus 策略，不能声称本次已实现。
- 原生分词会处理标点；对 E1042、C++、[a.*] 的测试证明词项召回可运行，不等于精确字符串匹配或所有编号都保留为一个完整 Token。

固定版本依据：[Qdrant v1.16.2 BM25 源码](https://github.com/qdrant/qdrant/blob/v1.16.2/src/common/inference/bm25.rs)、[JS SDK v1.16.2 类型](https://github.com/qdrant/qdrant-js/blob/v1.16.2/packages/js-client-rest/src/openapi/generated_schema.ts)。Ollama 请求协议见 [官方 Embed API](https://docs.ollama.com/api/embed)。

## 三、离线构建、重建和删除

### 新建及上传

创建知识库允许配置已安装的 Ollama 模型和实际维度。先读取模型 digest、执行维度探测并校验 Qdrant Schema，再创建空 READY 索引。

上传在一个数据库事务中创建 Document、DocumentIndex 和 PROCESS_DOCUMENT 任务。HTTP 返回不再启动不可恢复的后台 Promise。worker 读取任务冻结的索引，切分原始正文，以 16 个 Chunk 为一批编码，再写入同一 Point 的 Dense 和 BM25。

只有向量写入成功并再次确认文档未删除、知识库未删除且活动索引未变化，才把 DocumentIndex 标为 READY。统计从未删除的文档重新聚合，重复执行同一任务不会重复累计切片数。

### 重建

1. 用户修改模型、维度或切分参数，或者显式请求重建。
2. 探测目标空间并校验当前配置未在探测期间变化。
3. 在知识库行锁下拒绝仍有 RUNNING 任务的重建；取消待处理旧构建任务，旧索引标记 RETIRED。
4. 创建 BUILDING 新索引，切换 activeIndexId，为所有存活文档排队新 DocumentIndex 和处理任务。
5. 重建期间上传与检索失败并说明索引未就绪；允许文档或知识库删除。
6. 存活文档覆盖全部达到 READY 后激活新索引。空知识库直接 READY。
7. 持久 DELETE_INDEX 任务清理已退役版本。失败索引由自动重试或人工重试恢复，不能退回旧查询路径。

### 删除与恢复

先设置 deletedAt、取消待执行的处理任务，并持久保存历史 Collection 清单。检索在输出前检查 READY DocumentIndex 和存活实体，删除标记立即生效。

worker 按冻结的集合和文档/知识库/索引身份删除向量，成功后才物理删除相应实体。采用按知识库的 PostgreSQL session advisory lock、5 分钟租约、10 秒心跳和租约 token 条件更新，防止不同 worker 并发操作同一知识库。

session 连接断开可能释放 advisory lock，因此清理任务还要等待仍有有效租约的处理任务，避免未结束的向量写入在清理后重新落库。数据库提交前再次核验任务归属，旧 worker 不能覆盖新任务状态。

任务失败按退避时间重新排队，最多 5 次后 FAILED；管理接口可以重试仍有效的失败处理任务和清理任务。只重试清理任务或没有失败任务时，不把 READY 知识库误标为 INDEXING。进程中断遗留的 RUNNING 任务在租约过期后恢复。

## 四、在线检索与权限

```text
认证后的业务入口
    → 绑定用户 / 当前发布版本的检索服务
    → 授权并解析每个知识库的 READY 活动索引
    → 按不可变 Embedding Space 分组
    → 每空间 Dense / BM25 / Hybrid
    → 过滤删除或未就绪的 DocumentIndex
    → 重验授权和活动索引
    → 跨空间 RRF、稳定去重、全局 TopK
    → 再验文档可见性，输出证据与来源
```

KnowledgeExecutor 保留知识库多选、查询变量和既有 text/json 输出，只调用服务端注入的 KnowledgeRetrievalService。节点 JSON 和普通 inputs 不能提供授权主体。缺少可信服务时明确失败，不创建默认模型或默认 Collection。

入口覆盖：

| 调用入口                | 可信范围                                           |
| ----------------------- | -------------------------------------------------- |
| 单知识库搜索 API        | 当前登录用户拥有的存活知识库                       |
| 编辑器工作流运行        | 当前登录用户范围                                   |
| API Key 同步与 SSE 执行 | 激活发布快照声明且当前归属应用拥有者的库           |
| 公开 WebApp 运行        | 与 API Key 发布调用相同                            |
| 发布动作                | 拒绝变量化知识库 ID，校验当前归属和 READY 活动索引 |

发布后的节点仍可解析查询变量，知识库 ID 必须来自静态发布快照；传入未声明 ID、库转移、取消发布或活动版本变更都会拒绝执行。

## 五、召回与结果语义

- vector 只调用 Dense；同空间多库只生成一次 Query Vector。
- fulltext 只查询原生 bm25 Sparse Index，完全不创建 Dense Encoder。
- hybrid 并行调用两路，BM25 不可用时明确失败，空 BM25 结果仍采用 RRF 分数语义。
- 各空间默认最多 3 路并发，单空间查询限时 30 秒；任一必需空间失败则整体失败。
- 每空间候选数为 min(100, max(20, topK × 4))；Hybrid 两路适当扩充候选后融合。
- 空间内加权 RRF 和空间间等权 RRF 都固定 k=60；最终 TopK 在跨空间合并和可见性过滤后截取。
- 去重身份包含 knowledgeBaseId、indexId、documentId、chunkId。融合分数相同按该身份稳定排序。
- threshold 只应用于 Dense 分支，不能过滤 BM25 或 RRF 分数。不同模型仍共享用户设定的 Dense 阈值，尚未实施模型分数校准。
- scoreType 区分 cosine、bm25、rrf；sources 保存召回路线、原始分数、名次、索引和空间身份，metadata 和正文保持。
- 多空间 RRF 是排名合并策略，不是跨模型相关性标定；没有据此承诺质量提升。统一 Reranker 待真实问题集评测后引入。

## 六、实现文件与任务状态

| 模块       | 已实施内容                                                                  | 主要文件                                                                                          |
| ---------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 数据结构   | 空间、索引、文档索引、持久任务、删除标记、NEEDS_REBUILD；三应用 Schema 同步 | apps/workflow/prisma/schema.prisma、两项新迁移、scripts/sync-prisma-schemas.mjs                   |
| 编码与存储 | digest 核验、向量校验、命名向量、原生 BM25、精确索引过滤和删除              | packages/ai-engine/src/knowledge/embeddings/、bm25.ts、store/qdrant-store.ts                      |
| 构建与任务 | 原子排队、重建、幂等处理、租约恢复、可重试清理                              | apps/workflow/lib/services/knowledge-index-service.ts、document-processor.ts、knowledge-worker.ts |
| 在线编排   | 授权解析、空间分组、三种模式、两层融合、来源字段                            | knowledge/retriever/multi-knowledge-retriever.ts、hybrid-retriever.ts、rank-fusion.ts             |
| 入口接入   | 单库搜索、编辑器、API Key 两种执行、公开 WebApp、发布校验                   | 各应用 knowledge-retrieval.ts、各运行/发布入口                                                    |
| 界面       | 创建/修改模型、重建/重试、状态反馈、分数含义、Chunk 分页                    | apps/workflow/components/knowledge/                                                               |
| 回归验证   | 分组、授权、错误策略、旧节点配置、真实 BM25、真实数据库任务生命周期         | `packages/ai-engine/src/knowledge/__tests__/`、`tests/integration/`                                   |

Chunk 查看只读取当前 READY 索引及文档版本，使用 Qdrant scroll cursor 分页；检索路径不再扫描正文或限定在前 1000 个 Point。

## 七、验收与发布边界

已执行的单元和真实基础服务测试详见 [部署与验证记录](./RAG多Embedding改造部署与验证记录.md)。原生 Qdrant 测试不以 Mock Sparse JSON 代替，数据库测试执行了真实迁移、事务、任务和向量清理。

**代码交付验收**：空间身份隔离、原生 BM25、分组路由、两层融合、权限绑定、持久任务恢复、删除即时隐藏和旧节点输出兼容均可复核。旧索引兼容与回滚已按确认范围移除。

**上线验收仍需执行**：

1. 在目标环境部署固定版本 Qdrant，应用规范迁移并启动常驻 worker。
2. 用实际安装的 1024/768 模型完成文档构建、单库和多库查询。
3. 通过登录后的单库 API、编辑器、API Key 同步/SSE 和公开 WebApp 做 HTTP/浏览器联调。
4. 固定问题和证据标注，对比 Dense、BM25、Hybrid 的 Evidence Recall@K、MRR/nDCG 和耗时；没有测量前不填写性能或质量数字。
5. 原有知识库逐库重建，校验覆盖后恢复使用；对无法提取正文的历史文档重新上传。

本次只对隔离的测试数据库执行迁移，没有修改用户业务数据库或清空业务 Qdrant 集合。部署操作必须遵循上述新索引重建规则。
