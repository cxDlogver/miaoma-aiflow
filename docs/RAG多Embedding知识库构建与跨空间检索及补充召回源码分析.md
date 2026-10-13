# RAG 多 Embedding 知识库构建、跨空间检索与补充召回完整分析

## 【知识目标与项目边界】

本篇以**通用运行机制 → 妙码 AI Flow 实际源码 → 失败边界与验证**的顺序，解释：不同 Embedding 模型及维度为什么需要独立向量空间、一个知识库如何异步构建 Dense+BM25 索引、工作流如何跨模型检索并融合结果，以及重建、删除、权限和失败恢复怎样共同保证用户只看到有效证据；进一步分析 PostgreSQL 过滤后候选不足时，如何复用查询、排除已检索 Point 并进行有边界的补充召回。

**事实基线**：依据 GitHub `cxDlogver/miaoma-aiflow` 的最新业务改造提交 `b4c0facca3fbc999d6ea3680466979bf1d01f362`（2026-10-13），本文叙述的是仓库中**已写入的代码机制**，不再把它误写成待执行改造计划。已有单元/集成测试代码不等于已在目标业务环境完成真实模型部署和质量评测；后文会区分源码已实现、测试覆盖、尚待验证与进一步优化。

与其他学习内容的联系：
- [RAG 知识库构建与向量检索源码学习记录](./RAG知识库构建与向量检索源码学习记录.md)：知识输入、Chunking、Embedding、索引及 HNSW 的基础主链。
- [RAG 检索能力评测与证据标注源码学习记录](./RAG检索能力评测与证据标注源码学习记录.md)：相关证据、Qrels、Recall/nDCG、Dense/BM25/RRF 评测与排序依据。
- 本篇深入该项目**多向量空间、BM25、索引版本、后台任务与发布权限**的实现，并以可见性过滤后的候选不足为例设计二次召回。二次召回属于**尚未实现的后续方案**，绝不能误当成已落地能力。既不把旧的单 Collection/字符串匹配版本当作现状，也不因实现完成而省略方案取舍和边界。


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

### 【多格式文档接入：统一解析协议与结构感知切分】

#### 为什么不能让一个文本切分器直接处理 PDF、Word 和代码

当知识库从 TXT、Markdown 扩展到 PDF、Word、HTML、CSV/JSON 和源代码时，应该统一的是**文档接入入口、解析后的数据结构与后续处理契约**，而不是用同一个字符串切分算法处理所有文件。需先区分三个过程：**Parser（按格式提取正文与结构）→ Normalizer（形成统一结构化表示）→ Chunker（按结构和长度生产检索片段）**。只有经过这些步骤才进入 Dense/BM25 编码与索引构建。

当前 [上传 API](../apps/workflow/app/api/knowledge/%5Bid%5D/documents/route.ts) 的真实路径：

~~~typescript
const allowedTypes = [
  'text/plain', 'text/markdown', 'application/json',
  'text/csv', 'text/html',
];
const content = await file.text();
if (!content.trim()) return apiError(ErrorCode.VALIDATION_ERROR, '文档内容不能为空');
const document = await enqueueDocument(knowledgeBaseId, userId, {
  name: file.name, mimeType: file.type || 'text/plain', size: file.size, content,
});
~~~

接口校验用户是否拥有知识库、文件类型和 10MB 大小上限，但这里的 `file.text()` 只是对字节做文本解码，不会解析 PDF 的页面对象、DOCX 的 Office XML 关系，也不会建立 HTML DOM 或源码 AST。PDF/DOCX 当前不在允许类型之列；简单加入 MIME 允许名单而不实现二进制解析，会把乱码写入 `Document.content`。`text/plain` 类型的代码文件或 CSV/JSON/HTML 即便能上传，也**没有专门的语法/记录结构提取器**。

[document-processor.ts](../apps/workflow/lib/services/document-processor.ts) 目前：

~~~typescript
const config = { chunkSize: index.chunkSize, chunkOverlap: index.chunkOverlap };
const splitter = /\.(md|markdown)$/i.test(document.originalName)
  ? createMarkdownSplitter(config)
  : createTextSplitter(config);
const chunks = splitter.split(document.content);
~~~

`MarkdownSplitter` 用 Markdown-It 标题 Token 识别层级，输出 `headerPath`，对超长章节再细切；`TextSplitter` 优先段落、标点和字符长度。它们是**现有切分器**，不是 PDF/Word/代码解析器。`split(string)` 只有已经提取出的文本内容，通常无法恢复 PDF 页码、合并单元格、原始代码行号等来源信息。

#### 建议的输入、解析和索引构建链路

现有 `PROCESS_DOCUMENT`、`DocumentIndex` 和 Qdrant 多空间索引可以继续使用；在 HTTP 上传与 Worker 分块之间增加按文件类型选择的 Parser 与统一内容表示即可：

~~~text
上传 / 同步文档
  ↓ 用户权限、内容类型、字节大小、完整性与安全检查
保存原始文件 + Document 元数据 + 持久处理任务
  ↓ Worker 按可信格式解析，不直接假设扩展名可信
DocumentParserRouter
  ├─ TXT / Markdown → 文本、段落、标题、代码块
  ├─ PDF          → 页面、阅读顺序、正文、表格；扫描件按需 OCR
  ├─ DOCX         → 样式标题、段落、列表、表格
  ├─ HTML         → DOM、主正文、标题/列表/链接
  ├─ JSON / CSV   → 对象键路径、记录/列名、行号
  └─ 代码文件      → AST、类/方法/函数及源码位置
  ↓
ParsedDocument：Blocks + Structure + SourceLocation + ParserVersion
  ↓
Normalizer：去噪/标准化，并保留来源结构
  ↓
ChunkerRouter：标题/段落/表格/记录/代码符号边界，超长再细分
  ↓
现有 Ollama Dense Embedding + Qdrant BM25 文本编码
  ↓
现有 Qdrant upsert + DocumentIndex READY + 在线检索与证据引用
~~~

将解析放在 Worker 内，是因为 PDF 版式抽取、DOCX 读取和 OCR 都可能比较耗时、可能失败；不能直接塞在 HTTP 请求中，也不应绕过现有租约、重试、文档删除和索引版本检查。**Parser 接口统一不等于解析器实现统一**：PDF/DOCX 可以由独立解析服务处理，代码可由 Node.js 本地语法解析器处理，最终都输出同一中间协议。

#### ParsedDocument 是结构化中间产物，不是最终 Chunk

如果一份 PDF 出现：

~~~text
第三章 员工休假制度
3.1 年假申请
员工需要提前三个工作日提交申请。
3.2 审批流程
直属主管负责审批。
~~~

直接按 500 字切分可能把“年假申请”的标题与正文拆开；即使取到了“提前三个工作日”，也可能无法说明它属于哪一章节或哪一页。先输出 `heading / paragraph` 等 Block，并为正文保存 `headerPath` 和 `page`，才可以做结构感知切分。

建议的最小中间协议（**教学设计，当前仓库尚未实现**）：

~~~typescript
type BlockType = 'heading' | 'paragraph' | 'list' | 'table' | 'code' | 'record';

interface SourceLocation {
  page?: number;                       // PDF 页码
  headerPath?: string[];               // 章节/小节
  filePath?: string;                   // 代码相对路径
  language?: string;
  symbolPath?: string;                 // OrderService.createOrder
  startLine?: number;
  endLine?: number;
  row?: number;                        // CSV 记录行
  column?: string;
  startOffset?: number;                // 仅在能映射回原文时填写
  endOffset?: number;
}

interface ParsedBlock {
  type: BlockType;
  content: string;
  location: SourceLocation;
  attributes?: Record<string, unknown>; // 表头、AST 节点类别等
}

interface ParsedDocument {
  documentId: string;
  sourceFormat: string;
  parserName: string;
  parserVersion: string;
  sourceHash: string;
  blocks: ParsedBlock[];
}
~~~

**Block 是解析单元；Chunk 是检索单元。** 一个函数可能是一个 `code` Block，但如果超过模型输入预算还要按语法子块拆分；一个短标题 Block 通常需要与其后段落组合。`ParsedBlock.content` 不等于要求原样作为 Embedding 输入。需要评估是否把标题路径、表头或代码符号名称加入索引文本，避免 Chunk 缺上下文；仅把 `headerPath` 存在 `metadata` 中，不会自动参与 Dense 编码。统一使用 Markdown 作为可读展示格式可以，但不能作为唯一结构来源：复杂表格、原始 PDF 坐标和 AST 关系可能无法无损地表达成 Markdown。

后续将 `SourceLocation` 中可核实的字段映射到现有 `TextChunk.metadata`，并让 `ChunkWithVector` 在 Qdrant Payload 中继续保存 `content/metadata/documentId/indexId/documentIndexId`。不同格式的位置含义不同：PDF 页码不等于 UTF-8 字符偏移，代码行号不是 DOCX 段落偏移；不要通过累加字符串长度伪造来源定位。

#### 各格式解析和切分的实际重点

| 格式 | 解析阶段必须识别 | 推荐 Chunk 边界与注意事项 |
| --- | --- | --- |
| TXT | 编码、换行、空白、段落 | 按段落/句子优先，长度切分兜底 |
| Markdown | 标题层级、代码围栏、列表 | 先按标题分节，超长再切；继承 `headerPath`，避免代码块中的 `#` 被当标题 |
| PDF | 阅读顺序、页码、双栏、表格、图文位置 | 保留章节/页码；扫描 PDF 才按需 OCR；不要把整页默认当一个 Chunk |
| DOCX | 标题样式、列表、表格、段落及图片等内容引用 | 保留层级与表格上下文；旧版 `.doc` 不是 DOCX，应单独转换或处理 |
| HTML | DOM、主内容、导航和样式噪声 | 保留可见正文及标题；剔除菜单、脚本、样式，避免污染检索 |
| CSV / JSON | 列名、记录 ID、嵌套键、数据类型 | 按行组/记录/对象子树；为每条记录保留表头、键路径 |
| TS/JS/Python/Java | AST、类、函数、方法、注释、起止行号 | 优先按符号及逻辑单元切分；长函数可按语法子块切分，不要随意拆断函数 |

代码示例：

~~~typescript
// 原始代码示意
class OrderService {
  createOrder() { /* ... */ }
  cancelOrder() { /* ... */ }
}

// Parser 应识别 OrderService.createOrder 等符号，附加：
// filePath / language / symbolPath / startLine / endLine
// Chunker 根据整个方法与目标长度决定是否继续切分。
~~~

面向代码仓库还可增加定义/引用关系、仓库提交 SHA 和模块路径；但 `Tree-sitter` 能产生语法树，不等于已经实现调用图、跨文件符号解析或代码语义索引。项目已有的 Dense+BM25 可复用，精确符号检索则可能需要额外的 keyword/路径检索索引。

#### 工具和部署选型如何接入，而不是重写所有解析算法

可按需要选择成熟组件，**不是必须全部引入**：

- [Docling](https://docling-project.github.io/docling/)：面向 PDF、DOCX 等办公文档的结构化提取候选；着重验证页码、表格、阅读顺序、OCR 与 `ParsedDocument` 适配。
- [Unstructured](https://docs.unstructured.io/open-source/core-functionality/partitioning)：多种文件格式的元素化 Partition 接口；可作为 Docling 的替代而非叠加的必选依赖。
- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/)：为代码文件生成语法树，识别函数、类等并给出位置；它解决代码解析，不负责 PDF/Word 解析。
- 项目已有 [MarkdownSplitter](../packages/ai-engine/src/knowledge/chunking/markdown-splitter.ts) / [TextSplitter](../packages/ai-engine/src/knowledge/chunking/text-splitter.ts)：保持已有适用场景；简单 JSON/CSV 可使用成熟结构化数据解析库，不一定需要独立解析服务。

先用固定样本评估准确性与成本。能够打开 PDF 不等于表格、标题和引用位置可用于 RAG；OCR 也不应该成为数字 PDF 的无条件必经步骤。

#### 原始文件存储、版本和任务一致性需要一起设计

当前 [Prisma Document](../apps/workflow/prisma/schema.prisma) 的 `content:String?` 主要用于保存按文本读取的内容；一旦接收二进制原件，只留解析后的 `content` 不足以支持未来切换 Parser 后重新提取。建议：

1. 在接入层保存可恢复的**原始字节/对象存储位置、内容哈希、可信格式和大小**，Parser 产物可另存或以引用形式归档。`sourceHash` 用于确定内容版本，同名文件不等于同一版本。原始文件存储与数据库事务也不是天然原子的，需设计临时对象、提交标记和失败清理。
2. `PROCESS_DOCUMENT` 任务应绑定已经验证的文件身份及目标 `DocumentIndex`，Worker 在租约下执行 `parse → normalize → chunk → embedding → upsert`；每一步失败可观察和重试，不应把部分成功的解析/Chunk 标为 READY。
3. 记录 `parserName/parserVersion` 和 `chunkerName/chunkerVersion`，按需将切分协议冻结到索引版本。Parser 升级可能改变标题、表格展开或正文顺序，从而改变 Dense/BM25 的实际输入，即使原始文件哈希不变，也可能需要重新构建文档索引。解析版本与 Ollama 权重 digest、BM25_CONFIG_ID 是不同的身份维度。
4. 只有完成与现有 `documentIndex.status=READY` 一致的持久化检查后，才能把新 Chunk 对外检索；删除、重建、超时和崩溃都继续复用现有任务租约、索引版本与 `deletedAt` 保护。
5. PDF、Office、HTML 都是不可信输入，应校验文件内容而不只依赖 `file.type`/后缀，并限制页数、解压比、CPU/内存、解析时长和外部引用访问；禁用宏和活动内容，必要时隔离 Parser。OCR 失败、表格无法读取或文本缺失应有明确状态和日志，不能静默视为完整索引。

尤其要避免把 “增加 Parser” 误写成修改现有 `EmbeddingSpace` 的语义：**不同 Dense 模型的空间隔离仍照旧，原始文档解析器和 Chunker 版本属于索引构建协议**。解析产物不同可能触发索引重建，但不意味着每种文件类型都必须独占一个 Qdrant Collection。

#### 如何验证解析能力，而不是只看上传成功

对同一份原始文档构造可以人工核对的参考文本、结构和证据问题：

- PDF/DOCX：标题与正文归属、两栏阅读顺序、表格行列、页码/章节定位、扫描 OCR 是否正确；
- Markdown/HTML：标题层级、代码围栏、可见正文提取与导航去噪；
- CSV/JSON：表头/键路径、记录 ID、行与对象边界；
- 代码文件：完整函数/类边界、长方法拆分、跨文件路径及源码行号；
- 生命周期：重复解析同一原件得到稳定结果；Parser 升级重建；中途失败/删除不产生 READY 垃圾索引；旧格式继续兼容。

在固定 Query 与 Qrels 上，比较当前纯文本分块与结构解析后分块的 `Evidence Recall@K`、`MRR/nDCG`、引用位置准确率，并记录解析耗时、失败率、内存及索引构建成本。不能凭“结构更完整”直接推断召回指标必定提高。

**阶段结论**：当前系统已具备统一 Chunk 到 Dense/BM25 索引、异步任务与活动索引的能力，尚不具备 PDF/DOCX/源码 AST 的统一解析架构。应在离线处理入口加入 `DocumentParserRouter → ParsedDocument → ChunkerRouter`，按文件格式保留必需结构和来源位置，最终继续复用现有 Embedding Space、DocumentIndex、Qdrant 及权限链路。本节为**讨论形成的改进方案，尚未修改业务源码**。


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


## 【八、二次召回：已检索候选如何排除、补齐与重新融合】

### 【问题起点：离线建索引为何不能保证在线 TopK 都有效】

这部分针对**跨存储状态不一致窗口下的候选完整性**，不是重新创建索引，也不是扩大知识库授权边界。假设用户请求最终 `TopK=5`，当前 [MultiKnowledgeRetriever.retrieve()](../packages/ai-engine/src/knowledge/retriever/multi-knowledge-retriever.ts) 为每个空间设置 `candidateTopK = min(100,max(20,topK×4))`，先从 Dense、BM25 或 Hybrid 取得候选，然后调用业务层 `filterVisibleResults()`，最后融合、截取 `TopK`。当本次候选中大量 Point 被过滤时，代码**不会再向 Qdrant 索取下一批候选**。

现有离线 [processDocument()](../apps/workflow/lib/services/document-processor.ts) 按 `upsertVectors(points) → DocumentIndex.READY` 顺序写入两套存储。Qdrant 写入成功而 PostgreSQL 标记 READY 尚未提交、失败或正在补偿时，Qdrant 可能已有尚不可见的 Point。删除采用 `deletedAt` 立即隐藏、持久任务异步清理；在实际物理删除之前，Qdrant 也可能仍有对应 Point。**只要知识库活动索引本身处于 READY，新上传文档的某个 DocumentIndex 仍可能尚未 READY。**

不能把这类 Point 和“无权限知识库的 Point”混为一谈：现有 [resolveIndexes()](../apps/workflow/lib/services/knowledge-retrieval.ts) 首先按可信主体确认可查询的知识库和 READY 活动索引，[QdrantVectorStore.filter()](../packages/ai-engine/src/knowledge/store/qdrant-store.ts) 为每对 `knowledgeBaseId/indexId` 构造过滤条件；其他知识库或旧索引不应进入本次授权候选。**剩余的问题主要是授权活动索引内的文档级 READY 与 deletedAt 信息不完全存储在 Qdrant 中**；只有 PostgreSQL 才能最终确认能否作为证据。

~~~text
离线：DocumentIndex 未 READY → Qdrant Point 可能已落库
      或：Document.deletedAt 已设置 → 清理任务尚未完成
                           ↓
在线：服务端解析授权 KB + READY 活动 Index
                           ↓
Qdrant Filter（KB/Index 精确配对）→ 相似度 Top 20
                           ↓
PostgreSQL 过滤 DocumentIndex 未 READY / 已删除
                           ↓
有效候选不足最终 TopK，当前代码仍直接返回不足数量
~~~

**教学示例**：首次从某空间取回 C1～C20，其中 18 个尚未 READY，只有 C2、C5 有效，而 C21～C25 均有效且包含答案。若只做当前一次召回和后置过滤，最多留下 2 条；但不能据此声称当前真实线上频繁出现这种情况。需要用测试与监控判断发生比例，并区分“候选被状态过滤”“语义阈值不足”“授权范围原本没有足够证据”三类情况。即使没有错误过滤，也不能保证任意 Query 都有足够相关结果。

### 【再次召回不等于重新建索引，也不意味着不再使用索引】

离线 Indexing 在文档更新时进行 Chunking、Dense Embedding、BM25 词项编码、Qdrant upsert；在线补召回仅在**已有** Dense/BM25 索引上再执行一次 Query。不要把“重建索引”“重新生成 Query 向量”“再次进行 ANN/稀疏索引搜索”“重复返回上次的 Point”当成同一件事：

| 操作 | 补充召回时是否需要 | 实现边界 |
| --- | --- | --- |
| 重切 Chunk、重建 Dense/HNSW/BM25 索引 | 不需要 | 不修改离线索引与 DocumentIndex |
| 对同一个空间重复调用 Ollama 生成 Dense Query Vector | 原则上不需要 | 当前 `HybridRetriever.dense()` 每次 `retrieve()` 都会调用 `embedText`；若要复用，需要拆分或注入预生成 Query Vector |
| Qdrant 重新发起一次搜索 | 需要 | 应继续应用已授权 KB/Index Filter |
| 已返回 Point 再次出现在查询结果中 | 可避免 | 传入 `must_not.has_id` 排除各通道已见的 Point |
| Qdrant 内部完全不再访问/计算旧候选 | 不能保证 | `has_id` 保证结果排除，不等于 HNSW 或 BM25 搜索没有任何重复计算 |
| Native BM25 Query 文本再次编码 | 目前仍可能发生 | 当前用 `{text,model:'qdrant/bm25'}` 交给 Qdrant 原生推理；未实现客户端 Sparse Query 缓存 |

因此优化目标是**减少重复 Query Embedding、重复传输和无效候选重复处理**，并提升有效候选覆盖，而不是保证下一轮搜索没有任何索引计算开销。

### 【seenPointIds 从哪里来，为什么当前链路拿不到】

Qdrant [Query API](https://qdrant.tech/documentation/search/search/) 的每个返回 Point 都有 `id` 与 `score`；`with_vector:false` 只是不返回向量本体，不会去掉 Point ID。`QdrantVectorStore.upsertVectors()` 当前已经生成确定性 UUID：对 `indexId + ':' + chunk.id` 做 SHA-256，取前 16 字节并格式化为 UUID；同一版本重试仍可定位原 Point，新旧索引版本不会因同名 Chunk 而互相覆盖。

~~~typescript
// 真实调用结构：Dense 与 BM25 的返回值都经过 response.points
const response = await client.query(collectionName, {
  query: queryVector, // BM25 通道则改为 bm25Document(query)
  using: 'dense',     // BM25 通道为 'bm25'
  filter: authorizedFilter,
  limit: 20,
  with_payload: true,
  with_vector: false,
});

// 建议：在任何业务过滤、去重、RRF 之前先记录全部实际返回的 ID。
const seenPointIds = new Set(
  response.points.map(point => String(point.id))
);
~~~

不过当前 [QdrantVectorStore.result()](../packages/ai-engine/src/knowledge/store/qdrant-store.ts) 仅从 `point.payload` 提取 `chunkId/documentId/knowledgeBaseId/indexId/documentIndexId/content/metadata`，保留 `point.score`，**没有把 `point.id` 传递到 `VectorSearchResult`**。因此应用层 `MultiKnowledgeRetriever` 目前既拿不到 Point ID，也没有 `seenPointIds`、`excludePointIds` 或补召回循环。这一能力**尚未实现**。

需要在内部结果类型上增加 `pointId`，使 `search()` 和 `textSearch()` 通过 `result()` 都向上返回原生 Point ID。`pointId` 与业务层 `chunkId` 不同：前者用于 Qdrant `has_id` 的准确过滤，后者用于证据身份和 RRF 去重，不应互相混用。内部使用的 Point ID 也无需默认暴露到公开的知识节点 JSON 输出。

**必须先记录每次 Qdrant 实际返回的全部 ID，再执行 PostgreSQL 可见性过滤**。如果只记录有效候选，那么上轮被排除的未完成/已删除 Point 在下一轮又可能被取回。反之，Qdrant 内部 HNSW 曾经访问过、但不属于 `response.points` 的 ID，常规 Query API 并不返回，也不属于本轮 `seenPointIds`。

### 【如何避免第二轮再次返回上一轮的 Point】

Qdrant 官方文档提供 `must_not + has_id` 的排除已见 ID 方式；这是在检索结果层面去重，而不是扫描全库来构建排除列表。建议在现有授权 Filter **不变**的前提下叠加排除条件。以下是**建议实现伪代码**，不是项目当前代码：

~~~typescript
// VectorSearchOptions 和 BM25SearchOptions 都可增加 excludePointIds
const authorizedFilter = this.filter(
  options.knowledgeBaseIds,
  options.indexScopes
);

const excluded = options.excludePointIds ?? [];
const filter = {
  ...authorizedFilter,
  ...(excluded.length > 0
    ? {
        must_not: [
          ...(authorizedFilter.must_not ?? []),
          { has_id: excluded },
        ],
      }
    : {}),
};

// Dense 与 BM25 仍通过同一 Filter 结构限制 KB/Index，
// 二者分别使用 using:'dense' 和 using:'bm25'。
const response = await client.query(this.collectionName, {
  query: bm25Document(options.query),
  using: 'bm25',
  filter,
  limit: options.topK,
  with_payload: true,
  with_vector: false,
});
~~~

`should: [{must:[KB=A,Index=a]}, {must:[KB=B,Index=b]}]` 要与新增的 `must_not` **同时**生效。不可为了“补足五条”而放宽权限、扫描其他库或把 KB ID 和 Index ID 作为两个独立集合交叉匹配。

为什么不直接用 `offset=20`？Qdrant 的 ANN 是近似检索，多次查询的排序可能变化；`offset` 可能重复或跳过 Point，且为了跳过前面的结果仍有检索成本。`has_id` 适合顺序补充、逐轮排除重复返回；但排除集合增长会增加 Filter 大小和查询开销，因此必须设置批次数和数量预算。`scroll`/`next_page_offset` 更适合遍历 Point，不是相关性 TopK 的替代方法。参见：[Qdrant Search — Exclude Seen IDs](https://qdrant.tech/documentation/search/search/) 与 [Qdrant FAQ — Search Pagination](https://qdrant.tech/documentation/faq/)。

### 【为什么 Dense/BM25 要分别维护 seenPointIds】

`HybridRetriever` 目前同时执行 Dense、BM25，并通过 [fuseRankedLists()](../packages/ai-engine/src/knowledge/retriever/rank-fusion.ts) 将各路原始名次转换为加权 RRF。假设同一个 Chunk 在 Dense 中排第 1，在 BM25 中排第 3，说明它获得两种检索方法的支持；如果 Dense 见过该 Point 就禁止 BM25 返回，会破坏双路融合的证据和排名。正确的“去重”分两个范围：

1. **同一个 `Collection + 索引范围 + 检索通道` 内的重复返回**：使用该通道 `seenPointIds` 排除，补召回时不再重复返回同一 Point。
2. **同一证据在 Dense 与 BM25 两路均被命中**：允许两个通道各自返回、记录名次和来源；待 `fuseRankedLists` 根据 `knowledgeBaseId/indexId/documentId/chunkId` 的证据键融合成一条。

跨空间时各组访问不同 Collection，所以 `seenPointIds` 也按空间/Collection 隔离，不应在不同向量空间共用一份排除集合。一个可行的单次 Query 状态结构：

~~~typescript
// 建议的数据契约，现有仓库尚无此类型
interface ChannelState {
  seenPointIds: Set<string>;
  rawCandidates: RetrievalResult[]; // 原始候选、渠道排名与分数
  exhausted: boolean;
}
interface SpaceSearchState {
  embeddingSpaceId: string;
  collectionName: string;
  activeIndexIds: string[];
  queryVector?: number[];     // 同空间复用，不在每轮 embedText
  dense: ChannelState;
  bm25: ChannelState;
}
~~~

这个状态由一次请求的服务端检索器维护即可，首先不需要存储在 Redis 或数据库。用户再次发起完全不同的 Query 时重新构建 Run 状态；若授权 KB/Index、模型 digest、BM25 协议在单次运行中发生变化，应停止并显式失败，不应复用旧范围候选或查询缓存。

### 【第二轮如何与上一轮结果合并，避免 RRF 排名被重置】

当前 `fuseRankedLists()` 使用 `list.results.forEach((result, rank) => ... weight/(60+rank+1))`。如果把第二轮局部 Top5 单独送进 RRF，第二轮的第一条又会被当作全局“第 1 名”，得到与第一轮第一名相同的加权贡献，这是错误的排名语义。

推荐先维护**各通道的累计原始候选序列**，每次新结果在尾部按顺序追加，且要按 Point ID 去重；RRF 从完整序列重新计算或使用显式的连续 `sourceRank`。当中间发生业务可见性过滤时，应该明确定义名次是按“原始全部候选”的位置，还是“有效候选”的位置，并固定在测试中，不能某一批使用原始名次、下一批又按有效候选从 1 开始。由于多次近似查询的排序可能变化，按顺序拼接只能维持一致的**召回顺序近似**，不能声称恢复了某次全库精确 ANN 排名。

~~~text
同一 Retrieval Run（最终 TopK=5）
    ↓
解析授权范围，分组；每个空间只生成一次 Dense Query Embedding
    ↓
第一轮：Dense/BM25 各自按索引召回，记录 rawCandidates + seenPointIds
    ↓
PostgreSQL 校验 READY DocumentIndex 与未删除状态
    ↓
按通道累计原始排名 → 空间内 RRF → 跨空间 RRF → 全局有效 TopK
    ├── 有效候选足够 → 返回
    └── 不足，且查询预算未耗尽
            ↓
      对尚需扩充的空间/通道携带本通道 seenPointIds
            ↓
      Qdrant must_not.has_id 只返回该通道未返回的 Point
            ↓
      更新 seenPointIds，追加 rawCandidates（不重置名次）
            ↓
      再次做可见性检查与两层融合
            ↓
      直到足够 / 返回为空 / 达到最大轮次 / 超时
~~~

补召回需要独立的停止预算，例如最大轮次、每通道候选总量、排除 ID 最大个数、总耗时；第一轮正常命中足够有效证据时不发生额外请求。**允许最后返回少于 TopK**：当语料确实没有足够有效相关证据、Dense 阈值排除了弱匹配，或补召回达到预算时，不应放松相似度阈值、授权或文档可见性来“凑够数量”。不能以数量满足代替 Evidence Recall/Precision 的质量验收。

### 【BM25 与 Dense 的再次查询，分别会复用什么】

Dense 分支的第一次查询为 `Ollama.embedText(query) → Qdrant query(using:'dense')`，再次召回可复用第一次 Query Vector，避免同一个空间多次网络请求到 Ollama；不同 Space 的模型和维度不同，仍分别生成。现有 [HybridRetriever](../packages/ai-engine/src/knowledge/retriever/hybrid-retriever.ts) 每次调用 `dense()` 都会从 `embeddingService.embedText()` 开始，所以需要扩展其接口接受预生成向量或把 Query Embedding 前置到空间执行器。

BM25 分支的 `textSearch()` 执行 `bm25Document(query) → Qdrant query(using:'bm25')`，由 Qdrant 服务端依据统一 Tokenizer/`k`/`b`/`avg_len` 协议生成 Sparse Query。**当前没有独立的客户端 Sparse Query 缓存机制**；重复调用 `textSearch()` 仍可能发生 Qdrant 端重新分词和加权。`seenPointIds` 能去除重复返回的 Point，但不会自动让这部分服务端文本编码与索引搜索变成零开销。

### 【落地所需最小修改与验证】

仅作为**后续改进方向**，本次整理未更改业务代码：

| 层次 | 修改点 | 为什么必须 |
| --- | --- | --- |
| `knowledge/types.ts` | 内部结果加 `pointId`；Dense/BM25 查询选项加 `excludePointIds` | 能追踪原生 ID，也能表达本通道排除条件 |
| `qdrant-store.ts` | `result()` 保留 `point.id`；`filter()` 组合授权 KB/Index + `must_not.has_id` | 不改变安全边界、避免重复返回 |
| `hybrid-retriever.ts` | 把每通道候选及排名保留在 Run 状态；Dense 可注入预先编码的 Query Vector | 不重复 Embedding，不丢失 BM25/Dense 两路的独立名次 |
| `multi-knowledge-retriever.ts` | 在过滤结果不足时按预算补召回；复核授权/活动索引，累计候选并全局融合 | 解决候选被后置过滤占位的问题 |
| `rank-fusion.ts` | 支持跨批次累计渠道排名，而不是每轮从 rank=1 开始 | 保持 RRF 结果可解释 |

必须覆盖的最小测试情形：**首次 Top20 中只有 2 个 READY，后续还有 5 个有效**；第一次过滤掉的 Point 不会再次返回；Dense 和 BM25 两通道命中同一 Point 仍会在 RRF 中合并；同一空间两个知识库与不同空间两个 Collection 的 seen 集合不会串用；正常候选足够时只调用一次 Qdrant；Query Vector 只计算一次/空间；删除或撤权发生在补召回期间会拒绝过期索引；多轮只按预算停止且不会为凑 TopK 放宽权限或阈值。集成测试应真实调用 Qdrant `has_id`，单元 Mock 只能验证状态机与参数拼装。

**知识归纳**：当前项目已实现按授权 KB/Index 检索和 PostgreSQL 后置可见性校验；**尚未实现**二次召回。本次讨论的正确补充方案是：**离线索引保持不变；在线同一次 Run 缓存 Query Vector；在 Dense/BM25 各通道从每批 `response.points[].id` 构建已见集合；后续在原授权 Filter 上叠加 `must_not.has_id`；累计原始候选和渠道排名后再统一融合、过滤与裁剪。** 这样避免重复**返回**已经查出的 Point，但不能承诺底层 ANN/BM25 计算完全无重复。


## 【九、当前实现的选择、未完成部分与验证方法】

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
5. **跨系统一致性**：PostgreSQL 与 Qdrant 不具备单个原子事务，依靠工作任务、版本状态、最终授权过滤维持“未准备好的数据不对外可见”；过滤后的 TopK 候选不足则引出上一章尚未实现的二次召回设计。应通过故障注入检验极端并发下的补偿和清理。
6. **检索资源消耗**：空间数量增加会放大 Query Embedding 与 Qdrant 请求；当前限制并发数和候选数，但需要基于真实负载评估缓存、限流、按需路由。超时由 `Promise.race` 实现，不代表底层外部调用已被真正取消。

## 【十、从源码到面试回答：为什么这样设计、怎样验证】

**问题一：一次查询多个不同维度知识库，必须生成几份向量？** 不按知识库数量算，而按本次授权目标中的兼容 Embedding Space 数量算。A/B 同空间、C 另一空间，则 Dense Query Embedding 两次。BM25 为独立的词项检索路径，`fulltext` 模式不需要 Dense Query；三个知识库依然分别由空间和索引范围过滤。

**问题二：为何不同模型同为 1024 维仍要隔离？** 向量维度只决定张量形状，不定义坐标语义。此项目使用模型 digest、模型名、维度、距离、编码版本及 BM25 协议生成空间指纹，防止同维异模型混存。

**问题三：为何引入 DocumentIndex 而非只存 Document.status？** 同一文档可能经历多个知识库索引版本，只有 `DocumentIndex(documentId, knowledgeBaseIndexId)` 才能准确说明哪一份向量已构建完成；Qdrant 返回旧 Point 时也能够依该状态拒绝不可用证据。

**问题四：为什么 BM25 也叫 Sparse Vector？** 这是 Qdrant 为词项及权重提供的检索表示，不是 Dense Embedding；当前通过原生 `qdrant/bm25` 把 Query/Document 文本交给推理接口并生成稀疏索引。它擅长词项匹配，和 Dense 的语义召回互补。

**问题五：多个空间的分数如何统一？** 不直接相加 Cosine 和 BM25，也不能跨不同模型直接比 Cosine。当前按候选排名做空间内加权 RRF 和空间间等权 RRF，保留来源原始分数；最终 TopK 统一裁剪，效果仍需 Qrels 评测。

**问题六：如何保证异步入库和删除可靠？** 上传原子创建任务，worker 认领后带租约执行，Point 身份按版本稳定生成，索引 READY 后才可检索；删除先设置 `deletedAt` 即时隐藏，再用持久清理任务删除历史 Point。它是可恢复的最终一致性流程，不是跨 PostgreSQL/Qdrant 的分布式原子事务。

**问题七：为何二次召回需要维护 seenPointIds，却仍然不能保证 Qdrant 不重复计算？** 现有 Qdrant Query API 能返回每个命中 Point 的 `id`，但应用适配器目前丢弃了它。建议按每个 Collection 和 Dense/BM25 通道维护已见集合，在 PostgreSQL 有效性过滤之前保存全部结果 ID，二次查询保留授权的 KB/Index Filter 并加入 `must_not.has_id`，防止重复返回。Dense Query Embedding 可按空间复用，BM25 原生编码仍可能再次执行；RRF 必须累计各通道原始候选排名，而不是把每批头部重新当第 1 名。这属于设计建议，并非现有已上线功能。

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
- [Qdrant Search（返回 Point ID 与 Exclude Seen IDs）](https://qdrant.tech/documentation/search/search/)、[Qdrant FAQ（offset 与近似搜索分页局限）](https://qdrant.tech/documentation/faq/)

