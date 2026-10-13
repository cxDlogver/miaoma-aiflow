# RAG 知识库构建与向量检索源码学习记录

## 【第一节：为什么需要 RAG——企业知识库问答的架构判断】

### 【题目与学习目标】

企业拥有约 10 万份内部文档，持续更新，需要支持员工根据制度、技术资料进行自然语言问答。为什么选择 RAG，而不是直接把文档交给大语言模型？如果只有 20 份文档，设计是否改变？

本节要求能够：
1. 解释企业私有知识、动态更新、证据引用、访问权限与 RAG 的关系。
2. 区分 RAG、普通 LLM 问答、长上下文、微调、确定性 Workflow 与 Agent。
3. 给出从文档入库到查询生成的最小工程链路，并说明如何验证效果与安全边界。

### 【知识概述】

RAG（Retrieval-Augmented Generation，检索增强生成）的核心是：**在生成答案前，从外部知识源检索与当前问题相关的证据，并把证据纳入模型上下文。**

普通模型无法保证掌握企业私有、实时变化的知识，也不能仅凭语言生成保证答案可追溯。RAG 将知识从模型参数中解耦，使知识库可以独立维护、更新和授权，并为回答提供可核查的来源。外部知识既可以来自企业内部文档，也可以来自 Web、数据库等数据源；但“接入 Web”并不是 RAG 的必要条件。

RAG 的价值不等于保证正确：检索可能漏召回、错误召回，模型可能误读证据、错误引用，知识库也可能存在过期或相互冲突的内容。因此必须分别验证检索质量、生成质量和引用可信度。

### 【完整运行链路】

~~~text
离线知识构建（文档更新时执行）
原始文档
  → 解析与清洗（保留结构、来源、权限和版本信息）
  → Chunking（分块）
  → Embedding（按需向量化）
  → 索引与存储（原文、元数据、全文索引、向量索引）

在线问答（用户请求时执行）
问题 + 用户身份
  → 查询理解／改写（按需）
  → 检索与可信权限过滤
  → 候选片段召回（关键词／全文／向量／混合）
  → 重排与证据选择（按需）
  → 上下文构建（保留来源与版本）
  → LLM 生成答案
  → 引用和答案质量检查
  → 返回答案与证据
~~~

Embedding 和向量数据库并非 RAG 定义上的必要组件。少量资料可使用关键词或全文检索，复杂语义查询才更需要向量检索、混合检索与重排。离线构建与在线检索解耦，有助于减少重复文档处理和支持增量更新。

### 【与其他方案的设计边界】

| 方案 | 工作方式 | 适用条件 | 局限 |
| --- | --- | --- | --- |
| 直接 Prompt | 每次把资料放进上下文 | 少量、稳定、Token 总量可控 | 重复输入、上下文上限、更新与权限管理复杂 |
| 长上下文 | 单次提供较大范围资料 | 资料可容纳且需要跨文档综合分析 | 成本、延迟、长文本定位效果不稳定 |
| RAG | 先检索相关证据再生成 | 大规模、频繁更新、需要引用与权限过滤 | 索引维护、召回误差、链路复杂度 |
| 微调 | 训练模型行为或任务适配能力 | 特定风格、格式、任务模式 | 不宜单独承担频繁变化的事实知识维护 |

这些方案可组合使用，例如 RAG + 长上下文；选择依据不应仅是“20 份还是 10 万份”，还包括总 Token、更新频率、查询分布、准确性、权限、延迟、成本与运维复杂度。

### 【与 Agent 和 Workflow 的关系】

**RAG 是知识获取和证据增强机制，不等于 Agent。** 为模型接入企业知识，可以增强领域问答能力，但不会自动使系统具备自主规划、动态工具选择或执行反馈循环。

妙码 AI Flow 的现有主链路是确定性 DAG Workflow：

~~~text
Start（接收问题）
  → Knowledge（检索知识库）
  → LLM（基于证据生成）
  → End（返回结果）
~~~

如果需求增加“自主判断是否需要检索、证据不足时重新改写查询、动态调用不同工具”等决策，才需要进一步讨论 Agent Loop。不能因为使用了 LLM 或 RAG 就把确定性工作流称为自治 Agent。

### 【项目实例：妙码 AI Flow】

项目独立仓库：[miaoma-aiflow](https://github.com/cxDlogver/miaoma-aiflow)。

已核实的项目手册：[企业知识库 RAG 全链路使用与答辩手册](https://github.com/cxDlogver/miaoma-aiflow/blob/main/docs/妙码AI-Flow企业知识库RAG全链路使用与答辩手册.md)。

手册记录的主链路为：

~~~text
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
~~~

工程位置：管理端在 apps/workflow，公开运行端在 apps/webapp，发布 API 在 apps/api-server；工作流内核、节点执行器、RAG、Qdrant、Ollama 相关代码集中在 packages/ai-engine。上述依据为已读取的项目 README 与全链路手册，**尚未在本节逐个核实具体实现函数**，后续深入时必须进入源码定位。

手册还说明：此前端到端联调采用确定性的 Ollama 协议桩，验证了上传、切分、Embedding HTTP 协议、Qdrant 入库、检索、节点执行、SSE 与发布链路；**不能据此声称真实模型的语义效果、吞吐、幻觉率已经通过生产验收**。RRF 分数也不能直接当作答案正确率或相似度百分比。

### 【最小可复现代码：先验证检索—上下文接口】

以下是教学示例，不是妙码 AI Flow 已有实现。使用 Node.js 22+，将代码保存为 rag-demo.mjs，执行 node rag-demo.mjs。无需安装依赖、API Key、向量数据库；只验证权限过滤、关键词召回与上下文构建，不验证真实 LLM 生成。

~~~javascript
const documents = [
  {
    id: "permission-01",
    content: "敏感数据查看需要先申请权限，审批通过后才能访问。",
    allowedUsers: ["alice"],
  },
  {
    id: "permission-02",
    content: "权限审批失败后，可检查申请理由并重新提交。",
    allowedUsers: ["alice", "bob"],
  },
];

function retrieve(question, userId) {
  const terms = [...new Set(question.match(/权限|审批|失败|申请|访问/g) ?? [])];
  return documents
    .filter(doc => doc.allowedUsers.includes(userId))
    .map(doc => ({
      ...doc,
      score: terms.filter(term => doc.content.includes(term)).length,
    }))
    .filter(doc => doc.score > 0)
    .sort((a, b) => b.score - a.score);
}

function buildPrompt(question, results) {
  const evidence = results
    .map(doc => \`[\${doc.id}] \${doc.content}\`)
    .join("\n");
  return \`仅依据以下证据回答；证据不足时说明无法确定，并引用来源编号。\n证据：\n\${evidence}\n问题：\${question}\`;
}

const question = "权限审批失败后怎么办？";
const results = retrieve(question, "bob");
console.log(results.map(doc => doc.id));
console.log(buildPrompt(question, results));
~~~

预期第一行结果为 ["permission-02"]，Prompt 仅包含 permission-02 的内容。将用户改成 alice，应能同时访问两份匹配文档。将用户改成无授权身份，应返回空结果。注意：此处关键词规则只是教学替身，不能作为真实中文语义检索方案；真实服务端必须使用可信身份并在数据访问层执行权限过滤，不能信任客户端任意传入的 userId。

### 【验收与评价指标】

1. **检索正确性**：固定问题集、文档集和预期证据，检查 Recall@K、命中率、相关性；记录查询版本和索引版本。
2. **生成正确性**：检查答案正确性、对证据的忠实性、引用是否真实支持结论；无证据时能否拒绝编造。
3. **权限安全**：普通员工查询敏感问题时，检索结果、Prompt、缓存与引用访问均不得包含无权限资料；验证撤权后的行为。
4. **更新一致性**：新增、修改、删除文档后，索引、缓存、权限和引用应按明确的一致性策略更新。
5. **性能成本**：分别测量检索耗时、重排耗时、模型输入 Token、生成延迟、端到端 P95 与成本；不能直接假定 RAG 一定更快。

### 【本轮用户作答与针对性纠错】

**作答要点（保留原意）**：RAG 使通用模型或 Agent 获取企业内部和 Web 领域资料，利用权威知识减少混淆；通过检索减少向模型输入大量文档的负担；文档少时可直接输入，但随着知识增长、持续更新与不同用户的阅读权限要求，仍应考虑 RAG。

**纠错与补充**：
- “领域专业 Agent”应改为“模型或 Agent 获得领域知识增强”；RAG 本身不构成 Agent。
- “减少混淆”应表述为“通过证据降低无依据生成的风险”，并验证检索与引用；不能承诺消除幻觉。
- “提升检索效率”应区分减少送入模型的 Token 与实际端到端延迟，后者不一定降低。
- “20 份文档直接交给模型”有条件成立：还要考虑总 Token、更新频率、权限、引用和成本。
- 权限应在检索与数据访问层强制执行，不能把所有文档交给模型后再用 Prompt 要求保密。

### 【面试标准回答】

RAG 即检索增强生成，核心是先从外部知识源检索与当前问题相关的证据，再把证据作为上下文交给大语言模型生成答案。它主要解决企业私有知识难以直接被模型掌握、知识持续更新、回答需要来源依据等问题。

相比每次把所有文档放入 Prompt，RAG 通常将知识处理拆成离线索引构建与在线检索生成：离线完成解析、分块、向量化和索引维护；在线根据问题和权限检索相关片段，组织证据并生成答案。这样能够控制模型输入规模、支持知识独立更新，并为答案提供引用来源和可信权限过滤的入口。

但是否采用 RAG 取决于知识规模、总 Token、更新频率、查询特点、权限、成本和质量要求。少量稳定资料可优先考虑直接输入或长上下文；大型动态知识库更适合检索增强。RAG 不等于 Agent，也不能自动消除幻觉，需要独立验证召回、生成、引用、安全和性能指标。

### 【自然衔接的下一题】

**为什么不能把整篇文档直接转换为一个向量，而需要进行 Chunking？** 下一节进入文档解析、分块、Embedding 与索引构建，结合妙码 AI Flow 的具体源码和最小实验，分析切分策略如何影响召回效果。


---

## 【第一节追问：RAG 的知识源、存储形式与检索方式是否有限定】

### 【提问】

RAG 是否重点强调文档的存储格式和索引方式？知识可以保存为原始文档、结构化数据或向量，检索也可以采用相似性、向量等不同方式。RAG 所检索的外部资料一定必须是文本或文档吗？图片、代码、源码等能否作为知识源？

### 【回答要点】

**结论**：RAG 的核心是**检索外部证据以增强生成**，不是要求知识必须存为文档、必须向量化或必须采用向量数据库。应把以下几个层次分开讨论：

1. **知识源（Source）**：原始资料来自哪里，可能是 PDF、Markdown、网页、业务数据库、JSON、源码仓库、图片、音频或视频。
2. **知识表示与处理（Representation）**：如何从资料中提取可检索的信息，例如文本抽取、文档分块、代码符号和 AST、图像特征、语音转写、元数据及 Embedding。
3. **持久化存储（Storage）**：原始 PDF 或图片可以放在对象存储，业务数据放在关系数据库，文本及元数据放在文档存储，向量放在向量数据库或支持向量的数据库；同一知识可同时拥有多种表示。
4. **索引（Index）**：为了提高检索效率建立的数据结构，例如全文倒排索引、B-tree、向量近似最近邻索引、代码符号索引、图关系索引；索引不等于原始知识。
5. **检索策略（Retrieval）**：根据问题使用 SQL 精确过滤、BM25 关键词匹配、向量语义相似性、代码符号定位、多模态检索或混合检索，并可能加入重排与权限过滤。
6. **证据构建与生成（Augmentation + Generation）**：把检索结果转换为模型可消费的上下文，保留来源、位置、版本、权限信息，再让模型生成答案；没有生成步骤的单纯查询通常不称为 RAG。

### 【知识源并不限于文档】

| 知识源 | 可能的原始数据 | 常见的可检索表示 | 典型检索方式 |
| --- | --- | --- | --- |
| 文本文档 | PDF、Word、Markdown、网页 | 段落、Chunk、标题层级、元数据 | 全文、BM25、向量、混合 |
| 结构化数据 | SQL 表、业务记录、JSON | 行列字段、关系、筛选条件 | SQL、字段过滤、聚合 |
| 源代码 | 文件、函数、类、仓库 | 符号表、AST、调用关系、代码片段 | 文件名、符号、关键词、语义、图遍历 |
| 图片 | 商品图、设计稿、图表 | 图像特征、OCR 文本、描述、图像向量 | 视觉向量、图文跨模态检索 |
| 音视频 | 会议录音、课程视频 | 转写文本、时间戳、关键帧、音频特征 | 文本检索、时间定位、多模态检索 |

注意：图片不必一律先转成文本才能参与检索；多模态模型可以利用图像特征进行检索，并在生成阶段直接消费图像或其提取信息，取决于模型与系统能力。

### 【数据格式、存储和索引不是同一回事】

一份 PDF 的处理可能是：

~~~text
PDF 原始文件（对象存储，保留可下载原件）
  ├─ 解析文本与段落（文档／关系数据库）
  ├─ 来源、权限、版本等元数据（业务数据库）
  ├─ 倒排索引（支持关键词、短语和 BM25 检索）
  └─ Embedding 向量 + ANN 索引（支持语义近邻搜索）
                    ↓
             按需组合检索与重排
                    ↓
             证据片段与来源引用
                    ↓
                 LLM 生成
~~~

因此，“文档是 PDF”与“它通过向量索引检索”不冲突；原始格式、内部表示、持久化位置和索引结构可以分别设计。

### 【相似性检索与向量检索的概念边界】

“相似性”描述**匹配目标或评分性质**，不特指某一种索引结构；“向量检索”是基于向量表示和距离／相似度计算的一类实现。向量索引（例如 HNSW）通常用于加速近邻搜索，既可能进行精确搜索，也可能采用近似最近邻搜索。

- **BM25／全文检索**：根据词项、频率、文档长度等计算文本相关性，常由倒排索引支持。
- **向量检索**：根据 Embedding 及余弦相似度、内积或距离寻找近邻。
- **SQL／结构化检索**：通过条件、连接和聚合查询精确数据。
- **代码检索**：结合文件路径、函数名、符号表、AST、调用关系及语义检索。
- **混合检索**：融合多个检索通道的候选或排序，例如向量检索 + 全文检索 + RRF。

不应把“相似性索引”与“向量索引”简单理解成并列互斥的两种类型。

### 【代码知识库实例：检索不必以向量为中心】

用户问：“WebSocket 断线重连逻辑在哪里？”

一个合理的代码 RAG 方案是：

~~~text
用户问题
  → 提取关键词：WebSocket、reconnect、onclose、retry
  → 文件名／符号／全文检索定位候选代码
  → 沿函数调用关系或依赖关系补充上下文
  → 可选：向量语义检索补充未命中候选
  → 读取源码与相关测试
  → 生成机制说明，引用仓库路径与行号
~~~

这种方式可避免只凭语义相似度找到很多概念性注释，却遗漏实际实现。若代码持续变更，还需要管理分支、提交版本、索引刷新与引用行号的有效性。

### 【RAG、工具增强与 Agent 的关系】

- **RAG**：检索外部证据并增强模型生成。重点是“取回什么证据、如何使用证据”。
- **工具增强生成**：通过 SQL、搜索 API、计算器等工具提供模型需要的信息或计算结果。检索型工具返回的外部证据可以构成广义的检索增强；并非所有工具调用都是 RAG，例如只执行计算或写入操作。
- **Workflow**：预先确定执行顺序，如“SQL 查询 → LLM 总结”或“Knowledge → LLM”。
- **Agent**：根据目标和观察结果动态决定是否检索、选择何种工具、是否继续检索或执行其他动作。

是否是 Agent 由决策与执行机制决定，而非由“是否使用向量数据库”决定。

### 【与妙码 AI Flow 的项目联系】

项目选择了“企业文档 → Markdown 结构化切分 → Ollama Embedding → Qdrant → 向量 + 全文混合检索 → RRF → LLM”的路线，这是针对文本知识库的一种工程实现，**不是 RAG 的定义边界**。

项目资料：[妙码 AI Flow 全链路手册](https://github.com/cxDlogver/miaoma-aiflow/blob/main/docs/妙码AI-Flow企业知识库RAG全链路使用与答辩手册.md)。当前追问主要是通用机制辨析，不声称项目已经实现源码符号检索、图片多模态检索或 SQL 语义查询。

如果后续扩展为代码知识库，可独立增加代码解析器、符号索引和代码检索器；如果扩展为业务数据库问答，则可增加带权限约束的结构化查询能力；不需要强迫所有数据进入同一种向量索引。

### 【工程设计与验证】

设计时应先问：
1. 用户实际问什么？需要精确事实、语义相关内容、代码定义还是跨模态证据？
2. 知识是什么类型？原始资料能否被可靠解析？是否需要保留原始文件、结构和版本？
3. 哪种索引能高效找到答案？是否需要多路召回与融合？
4. 检索结果如何变成模型可消费的证据？能否追溯到文件、行号、记录 ID 或图像区域？
5. 权限过滤应在哪个可信层执行？索引更新、删除、缓存失效如何保证？
6. 如何使用固定查询集测量 Recall@K、准确性、引用正确性、延迟和成本？

可用三个最小实验验证方案取舍：
- **精确术语查询**：函数名或业务编号，比较关键词检索与向量检索。
- **语义改写查询**：问题措辞与资料用词不一致，比较全文与语义检索。
- **权限／更新查询**：同一问题由不同用户查询，或修改资料后再次查询，验证隔离和一致性。

### 【面试标准回答】

RAG 的本质是先从外部知识源获取与当前问题相关的证据，再利用这些证据增强模型生成。它不要求知识必须是文本，也不要求使用向量数据库。外部知识可以是文档、数据库记录、源代码、图片和音视频。

工程上应区分知识源、数据表示、持久化存储、索引、检索策略和生成六个层次。同一份资料可以保留原始文件，同时建立全文、向量或结构化索引；具体选择取决于数据类型和查询特点。例如企业文档适合全文与向量混合检索，代码知识库还需要符号及调用关系，结构化业务数据则往往需要 SQL 查询。

RAG 也不等于 Agent：RAG 负责证据获取与生成增强，Agent 负责动态决策和任务推进。系统可以使用确定性 RAG 工作流，也可以把检索能力作为 Agent 的工具。最终应以检索质量、答案忠实性、权限、延迟与成本验证方案，而不是以是否使用向量数据库判断架构先进程度。

### 【下一节衔接】

为什么许多 RAG 系统会采用 Embedding 和向量检索？它们相对关键词／全文检索解决了什么问题，又带来哪些局限？随后进入 Chunking、Embedding、索引结构与混合检索的源码和可复现实验。


## 【第一节追问：RAG 与 LLM Wiki 为什么是不同层面的知识体系】

### 【问题：系统是在回答问题，还是在持续整理知识】

假设企业已有 JWT、Refresh Token Rotation、WebSocket 鉴权、断线续传等多份资料。用户问“如何设计可恢复的 WebSocket 连接认证？”时，**RAG** 可以检索原始资料，选取与当前 Query 有关的证据，在本次调用中由 LLM 综合回答。后来加入一份新资料，再次提问仍从检索结果中当场推导结论。

如果希望资料每次增加时，就主动更新《WebSocket 鉴权》《Token 生命周期》《连接状态与恢复机制》等知识页面，补充引用、识别冲突、建立双向关联，让后来提问能复用已有的跨文档分析，那么讨论的是 **LLM Wiki**。其价值不是换一种检索排序算法，而是使跨来源综合后的知识成为可以持续维护、复用的**持久产物**。

**RAG（Retrieval-Augmented Generation，检索增强生成）**定义的是“当前 Query → 获取外部证据 → 增强模型生成”的机制。RAG 离线可以包含解析、Chunking、Embedding、全文或向量索引构建，但不要求将所有资料预先综合为 Wiki 页面。**LLM Wiki** 则是利用 LLM/Agent 维护互相关联的知识页面的知识管理范式，并非特定软件或另一种向量检索算法。Andrej Karpathy 于 2026-04-04 在 [《LLM Wiki》原始提案](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 中系统描述了该模式。

两者不应硬性互斥：RAG 也能持续更新索引、摘要和知识图谱，LLM Wiki 也能使用 BM25/Dense 甚至完整 RAG 链路来检索已有 Wiki 页面。区分的是**主要职责与产物**，不是“一个使用 LLM、另一个不用”。

### 【两条典型运行链路的区别】

~~~text
RAG：知识供给（离线）
原始文档 → 解析 → Chunking → 全文/BM25/Dense 索引
                                   ↓
RAG：当前请求（在线）
用户 Query + 身份 → 可信授权范围 → 召回证据 → Rerank（按需）
                  → 构造 Context → LLM 生成与引用 → 返回结果
                         结果：本次回答及证据，不要求写回归纳结论
~~~

~~~text
LLM Wiki：知识接入与维护（持续进行）
新增原始资料 → Ingest：阅读新资料并检查已有主题/概念
               → 新建或更新相关 Wiki 页面、引用、概念关系
               → 更新内容索引和维护日志
                                ↓
用户问题 → Query：定位 Wiki 相关页面并复用已有知识
                → 必要时回查原始依据 → 回答及来源
                → 有长期价值的新分析，经确认写回 Wiki
                                ↓
定期 Lint：检查旧知识、矛盾、失效链接、孤立页面、证据缺口
~~~

RAG 的“离线索引”主要使资料**可检索**；LLM Wiki 的 “Ingest” 不止添加一个新页面，还可能更新多篇既有文章及其关联。比如新资料提出另一种 Token Rotation 绝对过期策略，Wiki 维护器应回访已存在的 Token 生命周期页面，标清策略的前提、版本与相互冲突的证据，而不是无提示覆盖旧结论。

### 【LLM Wiki 的 Raw、Wiki、Schema 三层架构】

Karpathy 原始提案把知识组织分为三层：

| 层次 | 存储和职责 | 与其他层次的边界 |
| --- | --- | --- |
| **Raw Sources** | 原始文章、论文、代码、访谈记录、会议纪要等 | 作为事实来源；LLM 不应直接篡改原始依据 |
| **Wiki** | 持续维护的专题、概念、实体、对比、综合结论、交叉引用 | 归纳知识可由模型编辑，但必须保留证据与版本 |
| **Schema** | `AGENTS.md`、`CLAUDE.md` 等维护规范、页面约定、任务流程 | 约束 Ingest、Query、Lint、命名、来源追溯和审查，而不是事实内容本身 |

这是一种职责划分，而非要求每个项目都按 `raw/`、`wiki/` 目录命名。实际实现还要考虑版本管理、权限和多用户知识隔离。

**三类操作**形成知识积累的运行循环：

1. **Ingest（新来源接入）**：定位来源内容；识别新实体、概念及其与旧知识的关联；增加摘要或修改已有 Wiki 页面；注明矛盾和权威资料；同步 `index.md` 与 `log.md`。
2. **Query（读取与推理）**：从目录、双向链接或搜索索引找到相关 Wiki 页面，复用已经形成的跨文档结论；当结论必须精确引用时回查 Raw。重要的新知识经审查可写回 Wiki，普通临时问题不必自动沉淀。
3. **Lint（质量巡检）**：核查过时断言、不同页面冲突、失效链接、孤立文章、无来源的结论，以及还未覆盖的知识主题。Lint 应产生有依据的修正，不是只要发现冲突就使用“较新文字”覆盖旧内容。

其中 `index.md` 是当前知识**内容目录**，`log.md` 是**时间顺序的变更记录**。两者不是检索数据本身，也不能替代原始来源和内容审查。Karpathy 提出：规模适中时先用目录导航即可；资料变多后再加入 Markdown 搜索或 BM25/Vector 检索，不必在开始时引入整套向量数据库。

### 【RAG 与 LLM Wiki 的边界对比】

| 比较维度 | RAG 的常见设计 | LLM Wiki 的常见设计 |
| --- | --- | --- |
| 主要目标 | 找到这次问题需要的可信证据 | 长期整理、更新、关联并复用知识 |
| 主要处理时机 | 文档变更时更新索引，用户提问时召回 | 原始资料接入、重要讨论产生、定期巡检时更新页面 |
| 基本组织单元 | 原文、Chunk、Payload、各类检索索引 | 主题、实体、概念、综合说明、页面关联 |
| 查询方式 | 关键词、BM25、Dense、Hybrid 与证据筛选 | 目录/链接导航，可叠加搜索、BM25 或 RAG |
| 默认长期产物 | 可维护的来源与检索索引 | 有版本、有引用的综合知识页面与维护历史 |
| 主要风险 | 漏召回、错召回、引用错位、权限越界 | LLM 提炼失真、来源错误、更新漏改、冲突传播 |
| 适合场景 | 企业制度问答、精确事实与来源查证 | 研究学习、长期项目记录、跨资料知识关联 |

**不要从表中推出 Wiki 一定比 RAG 更准确、更便宜。** Wiki 在接入时支付更高的归纳与更新成本，可能降低重复综合成本，也可能因错误总结造成“持久化幻觉”。RAG 每次检索原文通常更方便追溯当前证据，但跨多份资料的稳定综合结论可能被重复推导。不同问题和更新频率决定组合方式。

LLM Wiki 与**知识图谱**也不是同一概念。Wiki 可通过页面链接形成知识网络；知识图谱进一步要求定义实体、关系及其可查询语义。只有 Markdown 链接并不代表已经建立统一、可推理的结构化关系数据库。

### 【用 WebSocket 鉴权资料验证两种组织方式】

已存在《JWT》《Refresh Token Rotation》两篇文档，后来增加《WebSocket 鉴权与断线恢复》：

**RAG 情形**：新的文件经 Parser/Chunking 变成可检索内容，更新全文/向量索引。用户询问“Access Token 过期后 WebSocket 如何安全恢复”，在线检索命中这三份文档中相关片段，由 LLM 根据它们生成答案，保留文件及段落引用。跨文档关系可以在这一次推理中建立，不意味着这些关系已经被单独存成专题文档。

**LLM Wiki 情形**：Ingest 新资料时，LLM 先定位现有 Token、认证、连接状态专题，补充“握手时鉴权/连接后首消息鉴权”“过期重验”“断线重连和补偿”之间的关系，在相关页面间建立引用。如果不同资料关于 Refresh Token 的绝对/相对过期说法冲突，应标记**适用场景与来源**。下次提问时先读已有《可恢复连接机制》，需要精确确认具体限制时再回查原始文档。

这解释了 Wiki 为何适合**跨问题、跨会话的知识积累**，而不仅是对 Chunk 的一次性总结。

### 【妙码 AI Flow 的源码现状与可组合的架构】

本项目当前有真实 RAG 链路：[文档处理](../apps/workflow/lib/services/document-processor.ts) 对可读文本切分并建立 Dense+BM25 Point；[MultiKnowledgeRetriever](../packages/ai-engine/src/knowledge/retriever/multi-knowledge-retriever.ts) 根据当前授权的 READY 索引，按 Embedding Space 进行检索与融合；[KnowledgeExecutor](../packages/ai-engine/src/nodes/executors/knowledge-executor.ts) 将证据交给工作流后续节点使用。该架构解决**资料入库、索引版本、授权检索与生成增强**，并未实现 LLM Wiki 的跨页面 Ingest/Query/Lint 维护流程。

如果今后需要 Wiki，推荐优先在**知识供给层之后增加可选的知识组织层**，不是推翻当前 Qdrant 与 Embedding Space：

~~~text
原始资料 → Parser/Chunker → 原文 Chunk → 已有 Dense/BM25 索引 ───┐
              └→ LLM Wiki Ingest → 专题、概念、引用、版本页面   │
                              ↓ Wiki 页面检索（按需）           │
可信主体 + 用户 Query → 定位相关 Wiki 页面 → 回查原始证据 ──────┤
                                                             ↓
                                 LLM 综合回答并标明来源
~~~

精确制度条款、频繁变化的业务数据及高度细粒度的原文查询，仍优先从原始来源验证；长期稳定、经常需要跨文档比较的技术知识可投入 Wiki 维护。不能要求所有新文件都必须经 LLM 总结后才允许进入 RAG，否则会增加接入延迟与总结失真风险。

跨来源知识整合引入新权限边界：例如一个 Wiki 页面同时总结用户有权访问的 A 文件与无权访问的 B 文件，**读取 Wiki 页面可能泄露 B**，即使用户无法直接检索 B 的 Qdrant Point。需要在 Wiki 生成、来源变更、索引发布和查询阶段设计来源级 ACL、审查与撤权传播。源文件删除/更新后，不能只清理原文 Point，还应追踪受影响的 Wiki 页面、引用和缓存。

**以上为组合架构的方案推演，不是项目已实现的 Wiki 功能。** 和该项目直接相关的源码机制、跨模型空间隔离以及候选召回详见[多 Embedding 知识库构建与跨空间检索源码分析](./RAG多Embedding知识库构建与跨空间检索及补充召回源码分析.md)。

### 【设计取舍、评测与标准回答】

对于几十份简单的事实文档，可以先使用 RAG、全文搜索甚至索引目录，不必为了“先进”创建 Wiki。如果资料不断增加、经常对同一批知识做跨来源综合、长期持续迭代专业解释，LLM Wiki 才更有必要。小规模 Wiki 可以直接阅读 `index.md` 和相关页面，大规模再为 Wiki 页面增加 BM25/Dense 检索。

评测时可固定原始材料、新增更新材料及跨文档 Qrels，比较“原文 RAG”“直接读取 Wiki”“Wiki 导航 + RAG 回查”三组：
- 证据召回覆盖、引用正确率、答案忠实性及跨文档推理质量；
- 源资料更新后 Wiki 的正确修订率、冲突发现率、错误知识残留、旧链接修复；
- 解析/接入 Token 成本、维护人工审查成本、在线延迟、权限与撤权一致性。

面试回答可以概括为：**RAG 是基于当前问题的检索增强生成机制；LLM Wiki 是让 LLM 维护持久知识页面、跨来源关联与持续更新的知识组织范式。两者可以组合，让 Wiki 复用长期综合知识，让 RAG 回查原始证据。真正的工程问题不是二选一，而是如何维护来源、权限、版本和知识正确性。**

**原始权威资料**：[Andrej Karpathy, *LLM Wiki*, 2026-04-04](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)（`The core idea`、`Architecture`、`Operations`、`Indexing and logging`）。这里仅借用其知识管理范式，不将提案中的任意可选目录或工具当作工业标准。



---

## 【第二节：Chunking——为什么 RAG 需要对文档进行切分？】

### 【当前讨论的问题及边界】

**为什么 RAG 通常不直接检索整篇文档，而是先将文档切分成多个 Chunk？**

本轮只讨论 Chunking 的必要性、检索粒度、与生成上下文的关系，以及文本切分工具和妙码 AI Flow 中的实际调用位置。暂不深入 chunkSize/overlap 的具体调参、Embedding 训练、向量相似度与 ANN 索引，避免一次展开多个独立问题。

### 【业务背景：知识存储与知识检索的目标不同】

企业有一份 200 页的《员工管理手册》，包含入职、考勤、年假、薪酬等章节。用户问“员工申请年假需要满足什么条件？”，实际需要的是年假申请条件所在段落，而非整份手册。

- **知识存储**要求保留完整资料和来源。
- **知识检索**要求定位能回答当前问题的局部证据。
- **Chunking** 将长文档组织成适合独立检索、又尽量保留必要上下文的知识单元。

Chunking 不是 RAG 定义上的必选步骤：短文档、已有合适记录粒度的结构化数据或其他索引方案，未必需要再次切分。

### 【为什么不直接对整篇文档做一次 Embedding】

假设一篇文档同时包含入职、考勤、休假和薪酬。将整篇文档编码为一个固定维度向量，会将多个主题共同压缩到同一表示中。用户仅查询“年假申请条件”时，该综合表示未必充分突出局部主题，且即使找到文档，仍需进一步定位具体证据。

改为对“入职管理”“考勤制度”“年假申请条件”“年假审批流程”“薪酬福利”等片段分别编码，可让检索直接返回局部内容，提高检索粒度。**向量是任务相关的表示，不是原文事实的无损编码**，不能保证长文档所有局部事实都能被一个向量准确检索。

另一个独立约束是模型最大输入 Token 长度。超长文档可能被拒绝或截断；即使模型支持较长输入，也不代表多主题混合编码最适合局部检索。切分需要兼顾语义边界与模型输入限制。

### 【检索单元与生成上下文不是一回事】

- **Retrieval Unit（检索单元）**：索引、匹配、召回时使用的知识粒度，通常是 Chunk。
- **Generation Context（生成上下文）**：最终送入 LLM 的证据集合，可以由多个 Chunk、相邻片段或父级文档片段组成。

例如用户问“年假申请条件和审批人是谁”，检索可能先命中“年假申请条件”Chunk，但回答还需要“审批权限”Chunk。系统可在检索后补充第二块，再构建完整证据上下文。

~~~text
原始文档
  → 按结构／规则切分为检索单元
  → 建立索引
  → 用户问题召回相关 Chunk
  → 必要时补充相邻或相关片段
  → 构建证据上下文
  → LLM 回答
~~~

**检索需要尽量精确，生成需要证据充分**。二者可以分离设计，不必单纯靠增大 Chunk 来补全所有上下文。

### 【工程实现：常用切分工具和 API】

常见方案是使用 LangChain 的 `RecursiveCharacterTextSplitter`，先按自然边界尝试分割，再在超长时使用更细的分隔符。下面是独立教学示例，不是妙码 AI Flow 项目源码：

~~~typescript
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const document = `
第三章：休假制度

3.1 年假申请条件
员工工作满一年后，可以按照规定申请年度带薪休假。

3.2 年假申请流程
员工需要提前三个工作日提交申请，并由直属主管审批。

3.3 病假规定
员工申请病假时，应按制度提交相应证明材料。
`;

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 100,
  chunkOverlap: 20,
  separators: ["\\n\\n", "\\n", "。", "，", ""],
});

const chunks = await splitter.createDocuments([document]);

for (const [index, chunk] of chunks.entries()) {
  console.log(index, chunk.pageContent);
}
~~~

关键 API 与参数含义：

- `RecursiveCharacterTextSplitter`：构建递归字符切分器，按分隔符优先级尝试保持自然边界。
- `chunkSize`：目标最大长度；默认长度计算通常是字符数，而非模型 Token 数。实际块不保证恰好达到此长度。
- `chunkOverlap`：尝试保留相邻片段的部分上下文；实际重叠量受分割与合并算法影响，不保证每对相邻块都精确重复配置值。
- `separators`：优先尝试的分隔符列表。
- `createDocuments`：将输入文本转换为切分后的 Document 对象列表；示例通过 `pageContent` 读取内容。

工具负责切分，不负责生成 Embedding 或写入向量数据库；处理顺序一般是“文档解析 → 文本切分 → 向量生成 → 索引存储”。

### 【妙码 AI Flow 实例：先交代链路，再读代码】

**业务入口与职责**：知识库管理功能接收文档；文档处理服务组织文档状态、切分、Embedding 与入库；AI 引擎中的切分器实现具体的文本分段规则。当前只观察切分部分，不把后续 Embedding/Qdrant 展开为独立主题。

已核实源码：

1. [文档处理服务 apps/workflow/lib/services/document-processor.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts)：组织文档处理链路，根据文件扩展名选择 Markdown 或普通文本切分器。
2. [普通文本切分器 packages/ai-engine/src/knowledge/chunking/text-splitter.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/chunking/text-splitter.ts)：按配置长度、重叠和分隔符优先级产生 Chunk。
3. [Chunk 类型 packages/ai-engine/src/knowledge/types.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/types.ts)：定义切分结果的数据字段。

文档处理服务中的关键逻辑（保留真实调用关系）：

~~~typescript
const splitter =
  fileName.endsWith(".md") ||
  fileName.endsWith(".markdown")
    ? createMarkdownSplitter({ chunkSize, chunkOverlap })
    : createTextSplitter({ chunkSize, chunkOverlap });

const chunks = splitter.split(content);
~~~

逐个解释：

- `fileName` 是正在处理的文件名称；此处依据扩展名选择策略，不意味着已完整解析所有 Markdown 语义。
- `content` 是上游准备好的待切分文本；`split(content)` 负责将其变成多个 Chunk。
- `chunkSize` 与 `chunkOverlap` 是传入切分器的配置。
- `chunks` 是切分结果数组，后续文档处理流程再将其内容交给 Embedding 服务生成向量。

普通文本切分器优先尝试段落空行、换行、中文和英文句末标点、分号及空格等自然边界，属于**规则驱动切分**，不是 LLM 语义主题识别。

Chunk 的核心结构可表示为：

~~~typescript
{
  content: "员工申请年假需要提前三个工作日",
  index: 2,
  startOffset: 150,
  endOffset: 169
}
~~~

以上具体内容与数字仅为结构示例，不是项目实际运行结果。字段分别表示文本内容、Chunk 序号、在输入文本中的起始和结束位置。字符偏移不等于 Token 位置，也不一定等于原始 PDF 字节位置。

### 【本轮结论与掌握标准】

1. **机制**：切分是为了建立合适的检索粒度，使多主题长文档中的局部知识可以被独立检索，同时满足输入长度限制。
2. **设计**：检索粒度与生成上下文可以不同；先精确召回，再按需补充证据。
3. **实现**：理解解析、切分、Embedding、存储的职责分离；能使用常见 Text Splitter 的主要 API 并解释参数。
4. **源码**：能从知识库业务流程讲清楚文档处理服务如何选择切分器、调用 `split`，以及 Chunk 如何传给后续阶段。
5. **边界**：切分不是 RAG 的定义要求；小 Chunk 不一定更好，过大和过小各有问题，需要通过检索测试决定。

### 【下一轮讨论】

**Chunk 应该切多大？`chunkSize` 和 `chunkOverlap` 怎样影响上下文完整性、召回质量和重复内容，如何通过实验选择参数？**

下一轮只围绕这一个设计问题展开，不提前扩展到 Embedding 训练、向量距离或 ANN 索引。


---

## 【第二节续：Chunk 大小与重叠参数如何选择】

### 【问题与示例】

年假制度同时描述申请条件、提前申请时间与审批人。若切分太小，用户问“条件和审批人”时可能只召回其中一部分；若切分太大，年假、病假、考勤等无关内容可能混在同一块。

**核心取舍**：小块更容易定位局部证据，却可能丢失上下文；大块更可能保留完整语义，却可能降低定位精度并增加无关上下文。

### 【两个配置的含义】

- `chunkSize`：Chunk 的目标最大长度，计数单位由切分器决定；常见字符切分器默认按字符计数，并不等于 Token 数。
- `chunkOverlap`：相邻块之间尝试保留的重复上下文，缓解边界截断，但不能保证任意跨段落关系都被保留。

固定窗口示意（仅为教学算法，非 LangChain 真实输出）：

~~~typescript
function splitFixed(text: string, size: number, overlap: number) {
  if (size <= 0 || overlap < 0 || overlap >= size) {
    throw new Error("Invalid chunk settings");
  }
  const result: string[] = [];
  for (let start = 0; start < text.length; start += size - overlap) {
    result.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return result;
}
~~~

减小 `chunkSize` 通常增加块数、使内容更局部；增大 `chunkOverlap` 会产生更多重复文本和可能更高的向量化、存储与检索成本。实际递归切分器受分隔符和合并逻辑影响，不保证每对相邻 Chunk 的重叠长度严格等于设置值。

### 【如何用实验而不是拍脑袋确定参数】

可从多个候选配置开始对比，例如字符长度 `200/20`、`500/50`、`1000/100`（前者为大小、后者为重叠）。这些是**实验候选，不是推荐的通用最优值**。

固定同一批文档与问题，记录：

1. 正确证据是否进入 Top-K（如 Recall@K）。
2. 证据是否完整覆盖问题所需条件和关系。
3. 检索结果是否有过多重复片段与无关主题。
4. Chunk 数量、Embedding 成本、索引规模、查询延迟及最终生成质量。

根据文档类型（Markdown、PDF 表格、代码等）、查询特点和评测结果调整参数；不以单一经验数值代替验证。

### 【本轮结论】

分块大小与重叠不是越大越好；应平衡定位精度、语义完整性、重复成本，并结合真实问题集验证。

## 【第二节续：为什么需要结构化切分】

### 【问题与业务背景】

**为什么两个长度相同的 Chunk 仍可能具有不同的检索效果？**

以 Markdown 员工制度为例：

~~~markdown
# 员工管理手册
## 第一章：休假管理
### 1.1 年假申请条件
员工连续工作满一年后，可以申请年度带薪休假。
### 1.2 年假审批流程
员工提前三个工作日提交申请，由直属主管审批。
## 第二章：考勤管理
### 2.1 迟到处理
员工迟到超过三次，需要提交情况说明。
~~~

按固定字符窗口切分，可能将“带薪休假”截断为两段、让“直属主管审批”失去“年假审批流程”标题、或将年假审批和考勤管理混入同一个 Chunk。因此**长度只决定切多大，不决定在哪里切**。

### 【三种常见策略及适用边界】

**1. 固定长度切分**

~~~typescript
function splitByLength(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += chunkSize) {
    chunks.push(text.slice(start, start + chunkSize));
  }
  return chunks;
}
~~~

简单、成本低、长度易控制，但不识别句子、段落或标题。适合结构不重要的简单文本流；对于章节清晰的知识文档通常不是优先方案。此处示例没有 overlap。

**2. 递归字符切分**

优先尝试段落空行、换行，再尝试句号、标点、空格，最后必要时使用更细的字符边界。尽量保留自然语言结构，但通常不知道 Markdown 标题的父子层级。

~~~typescript
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 500,
  chunkOverlap: 50,
  separators: ["\\n\\n", "\\n", "。", "！", "？", " ", ""],
});

const chunks = await splitter.createDocuments([text]);
~~~

`separators` 的优先级影响分块边界；`createDocuments` 返回 Document 列表。默认字符长度计算与模型 Token 计数不同。

**3. Markdown 标题结构切分**

利用 `#`、`##`、`###` 标题关系，将正文归属到文档、章节、小节；可保存标题路径作为元数据。但一个章节可能过长，单纯按标题切分不一定满足 Embedding 输入长度要求。

### 【常见落地方案：先识别结构，再限制长度】

~~~text
Markdown 文档
  → 按标题识别章节及层级
  → 得到带标题元数据的章节 Document
  → 对过长章节继续递归切分
  → 得到符合长度约束的 Chunk
  → 保留标题路径、来源、版本等元数据
  → Embedding 与索引
~~~

LangChain 教学示例（不等于妙码 AI Flow 的既有实现）：

~~~typescript
import {
  MarkdownHeaderTextSplitter,
  RecursiveCharacterTextSplitter,
} from "@langchain/textsplitters";

const headerSplitter = new MarkdownHeaderTextSplitter({
  headersToSplitOn: [
    ["#", "document"],
    ["##", "chapter"],
    ["###", "section"],
  ],
});
const sections = await headerSplitter.splitText(markdownContent);

const lengthSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 500,
  chunkOverlap: 50,
});
const chunks = await lengthSplitter.splitDocuments(sections);
~~~

第一阶段返回章节级 Document 及标题层级 Metadata；第二阶段将过长内容细分并尽可能继承元数据。典型结果形状：

~~~typescript
{
  pageContent: "员工连续工作满一年后，可以申请年假。",
  metadata: {
    document: "员工管理手册",
    chapter: "第一章：休假管理",
    section: "1.1 年假申请条件",
  },
}
~~~

**关键边界：元数据不自动等于向量输入。** 如果只将 `pageContent` 传给 Embedding 模型，标题路径不一定参与语义编码；若需要标题帮助检索，可将“文档／章节／小节／正文”组织为待向量化文本，但应通过评测判断是否值得重复注入。

### 【妙码 AI Flow 的已知链路与待核实边界】

知识库上传后，文档处理服务负责组织切分、向量化和入库。对于 `.md`、`.markdown` 文件，调用 `createMarkdownSplitter`；其他普通文本调用 `createTextSplitter`，随后通过 `split(content)` 得到 Chunk。

源码入口：[apps/workflow/lib/services/document-processor.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts)。

~~~typescript
const splitter =
  fileName.endsWith(".md") ||
  fileName.endsWith(".markdown")
    ? createMarkdownSplitter({ chunkSize, chunkOverlap })
    : createTextSplitter({ chunkSize, chunkOverlap });

const chunks = splitter.split(content);
~~~

这证明项目根据文档类型选择切分器，但**仅凭名称不能证明 Markdown 切分器使用了 AST、标题层级元数据继承、LangChain 的两阶段方案或语义识别**。下一轮需要进一步读取具体实现，并沿输入、处理、输出及下游使用核实。

**多格式输入的进一步工程分析：**上述示例只涉及已得到 `string` 的文档，无法解决 PDF/DOCX 的二进制解析、HTML/CSV/JSON 结构保存和代码文件的 AST/符号切分。最新项目仍以 `file.text()` 接收文本，尚无统一多格式 Parser。有关 **ParserRouter → ParsedDocument → ChunkerRouter** 的分层、PDF/Word/代码源码实例、原文件版本与重建、Dense/BM25 复用及验收边界，参见[多 Embedding 知识库构建与跨空间检索及补充召回源码分析——多格式文档接入](./RAG多Embedding知识库构建与跨空间检索及补充召回源码分析.md#多格式文档接入统一解析协议与结构感知切分)。该架构是后续设计，不是已落地源码。

### 【本轮结论与面试掌握标准】

- 固定长度切分解决“多大”；递归字符切分改善“在哪里切”；Markdown 结构切分解决“内容属于哪一章”。
- 三者不是互斥关系，实际可组合“结构识别 + 长度约束”。
- 能使用 LangChain 的 `RecursiveCharacterTextSplitter`、`MarkdownHeaderTextSplitter`，说明参数、输入输出和元数据的作用。
- 能解释标题只存在于 Metadata 时，为什么可能无法直接影响 Embedding 语义匹配。
- 不把通用方案冒充项目源码事实。

### 【下一轮讨论】

**妙码 AI Flow 的 MarkdownSplitter 实际怎样切分文档？是否识别标题层级、怎样处理超长章节、输出哪些元数据？** 从源码入口开始，逐步追踪真实实现，不假定读者了解项目结构。

## 【第二节续：妙码 AI Flow MarkdownSplitter 的真实实现】

### 【提问与知识目标】

妙码 AI Flow 的 MarkdownSplitter 是否真正理解 Markdown 文档结构？如何处理标题层级、超长小节、重叠、全局序号和 Metadata？需要区分“按 Markdown 标题进行正则匹配”与“使用 Markdown AST 完整解析”的边界。

### 【源码定位和完整调用链】

- 切分器源码：[packages/ai-engine/src/knowledge/chunking/markdown-splitter.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/chunking/markdown-splitter.ts)
- 测试：[packages/ai-engine/src/knowledge/__tests__/markdown-splitter.test.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/__tests__/markdown-splitter.test.ts)
- 业务入口：[apps/workflow/lib/services/document-processor.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts)
- 类型定义：[packages/ai-engine/src/knowledge/types.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/types.ts)

~~~text
文档上传／进入处理任务
  → processDocument({content, fileName, chunkSize, chunkOverlap, ...})
  → 根据 .md/.markdown 后缀选择 createMarkdownSplitter()
  → splitter.split(content)
      → splitByHeaders()：识别标题和分节
      → splitSection()：过长分节再按长度切分
      → 形成连续全局 index，附加 metadata.headerPath
  → TextChunk[]
~~~

其中 TextChunk 的基本结构为：

~~~typescript
interface TextChunk {
  content: string;
  index: number;
  startOffset: number;
  endOffset: number;
  metadata?: Record<string, unknown>;
}
~~~

### 【第一阶段：按标题分节】

当前实现使用正则表达式识别一至六级 ATX 标题：

~~~typescript
const headerRegex = /^(#{1,6})\s+(.+)$/gm;
~~~

每次匹配能得到标题级别、标题文本和匹配起点。随后维护标题栈，根据标题级别更新当前路径，再把标题至下一标题之间的内容作为一个 Section。例如：

~~~markdown
# 员工管理手册
## 休假管理
### 年假审批流程
由直属主管审批。
~~~

理论上的 Section 元数据表现为：

~~~typescript
{
  content: "### 年假审批流程\n由直属主管审批。",
  headerPath: ["员工管理手册", "休假管理", "年假审批流程"]
}
~~~

这个示例中的 content 用于说明章节边界和归属关系；具体空白字符以源码的 trim 处理为准。标题前存在正文时，源码还会创建一个没有标题路径的前言 Section；无标题时，整篇文档作为单个 Section。

**实现边界：**它并非完整 Markdown AST 解析器。正则式无法可靠区分代码围栏内部以 `# ` 开头的文本与真正的标题；当前标题栈依据数组长度进行回退，对跳级标题（例如一级标题直接跳到三级标题）的层级归属也需要额外验证。

### 【第二阶段：超长 Section 继续切分】

每个 Section 被传入 `splitSection(content, startOffset, chunkSize, chunkOverlap)`。

- Section 不超过 `chunkSize`：直接形成一个 Chunk。
- 超过长度：从当前起点建立最多 `chunkSize` 的窗口，在窗口后半段寻找合适分隔符。
- 优先顺序包括空行、换行、中文句末标点、英文句末标点和空格；找不到时按最大窗口长度切断。
- 下一个窗口的起点根据 `endOffset - chunkOverlap` 调整，并有避免停滞的保护。

该实现是“**标题识别 + 字符窗口与分隔符优化**”，不应描述为调用了 LangChain 的 `MarkdownHeaderTextSplitter` 或 Markdown AST 解析器，也不能称为真正的语义切分。

外层循环为每个 Chunk 设置连续全局 index，并把当前 Section 的 `headerPath` 放入 `metadata`。

需要关注的工程细节：

1. `chunkSize` 和 `chunkOverlap` 在这一实现中按 JavaScript 字符串位置工作，不等于 Token 数。
2. `content.trim()` 可能让内容和 `startOffset/endOffset` 的字符范围不能严格一一对齐，涉及原文精确高亮时应建立测试。
3. 重叠只用于同一 Section 的子块切分，不代表不同 Markdown Section 必然互相重叠。
4. 同一标题路径表示上下文归属，但不会自动进入 Embedding 模型，也不会自动实现按标题检索。

### 【面试标准回答】

项目使用两阶段 Markdown 切分：先用标题正则提取 Section 和标题路径，再对超长 Section 进行带分隔符优先级的字符窗口切分，并保留 `headerPath`、offset、index 等信息。它优于完全无结构的固定窗口，但不是完整 Markdown AST 或语义切分；跳级标题、代码围栏与 Offset 精确性需要专项测试。切分器生成 Metadata 不代表后续索引与检索已经使用它，需要继续追踪数据链路。

---

## 【第二节续：headerPath 在 Embedding、向量存储和检索中如何传递】

### 【提问：结构信息在哪里产生，又在哪里丢失】

切分器保留了标题路径，为什么查询时仍可能丢失章节上下文？需要分别检查**切分输出、向量输入、入库转换、Payload 和检索结果**，不能仅凭 `metadata` 字段存在就断言整条链路已具备标题增强。

### 【逐层追踪源码】

**1. 切分输出。**`MarkdownSplitter` 返回的 Chunk 含有：

~~~typescript
{
  content: "由直属主管审批。",
  metadata: {
    headerPath: ["员工管理手册", "休假管理", "年假审批流程"]
  }
}
~~~

**2. 向量化输入。**在 `document-processor.ts`：

~~~typescript
const chunkTexts = chunks.map(c => c.content);
const embeddings = await embeddingService.embedTexts(chunkTexts);
~~~

实际传入 Embedding 的是 Chunk 的 `content`，不是元数据。要注意一些 Chunk 正文可能包含当前小节标题，但祖先标题不会因为存在于 `headerPath` 中就自动参与编码。

**3. 入库对象的重新组装。**业务处理层构造 `ChunkWithVector[]` 时提供 `id/content/index/startOffset/endOffset/documentId/knowledgeBaseId/vector`，没有提供 `metadata: chunk.metadata`。因此**在这条已核实的业务入库路径中，切分器生成的 headerPath 没有传到 Qdrant**。

**4. Qdrant Payload。**`QdrantVectorStore.upsertVectors()` 本身支持：

~~~typescript
payload: {
  content: chunk.content,
  documentId: chunk.documentId,
  knowledgeBaseId: chunk.knowledgeBaseId,
  metadata: chunk.metadata || {}
}
~~~

但是上游已经遗漏 Metadata，因此最终通常写入空对象。检索接口虽然读取 `point.payload?.metadata`，也无法恢复原本未存储的信息。

**5. 检索返回。**`VectorRetriever.retrieve()` 会传递返回结果的 `metadata`，但前提是向量存储确实保存了这些信息。

源码：
- [document-processor.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts)
- [qdrant-store.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)
- [vector-retriever.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts)

### 【结构信息的三种不同用途】

| 目标 | 应该如何做 | 仅在 Chunk Metadata 中保存是否足够 |
|---|---|---|
| 来源展示和章节定位 | 入库和检索时完整传递 `headerPath` | 不够，必须贯通后续链路 |
| 让标题影响语义召回 | 将需要的标题内容放入待 Embedding 文本 | 不够 |
| 按标题过滤、排序或加权 | 设计 Payload 字段、过滤或重排逻辑 | 不够 |

**最小修复（建议，不是仓库既有实现）：**在构建待入库 Chunk 时增加：

~~~typescript
const vectorChunks = chunks.map((chunk, idx) => ({
  id: `${documentId}_${idx}`,
  content: chunk.content,
  index: chunk.index,
  startOffset: chunk.startOffset,
  endOffset: chunk.endOffset,
  documentId,
  knowledgeBaseId,
  vector: embeddings[idx],
  metadata: chunk.metadata, // 保留原有结构信息
}));
~~~

这一修改只解决 Metadata 传递，不直接改变现有向量；既有数据仍需补录或重新处理。是否增加标题增强 Embedding，应作为独立设计与评测决策。

### 【面试标准回答】

RAG 中 Metadata 要经历切分、应用层对象转换、向量 Payload 构建和检索结果回传；其中任何一步遗漏都会导致信息丢失。当前妙码 AI Flow 已在切分器生成 `headerPath`，但 `document-processor.ts` 没有在构建 `ChunkWithVector` 时传递 Metadata，属于可定位的工程链路缺口。修复路径是补齐字段传递，再按需要设计 Embedding 标题增强和结构化过滤，不能将这三项混成一种能力。

---

## 【第三节：Embedding 文本表示与模型调用】

### 【提问和业务背景】

“员工连续工作满一年后可以申请年度带薪休假”与“入职多久才能休年假”措辞不同，如何找到相关内容？仅编码“由直属主管审批”时为什么可能无法区分年假审批与报销审批？应该对正文编码，还是把标题拼进文本？`embedQuery()` 和 `embedDocuments()` 有何区别？

### 【三个不同数据对象】

1. **原始正文（content）**：保存事实原文，用于结果展示、引用和传入 LLM 的证据。
2. **结构元数据（metadata）**：保存 `headerPath`、`documentId`、`knowledgeBaseId`、来源、版本和访问范围等。
3. **向量化文本（embeddingText）**：为语义编码重新组织的信息，可以包含正文与部分有意义的标题上下文，不必等同于原文。

示例：

~~~typescript
const chunk = {
  content: "由直属主管审批。",
  metadata: {
    headerPath: ["员工管理手册", "年假审批流程"],
    documentId: "doc-001"
  }
};

// 可选的增强输入（示意）
const embeddingText =
  "章节：员工管理手册 / 年假审批流程\n正文：由直属主管审批。";
~~~

只对正文进行编码时，Embedding 模型只能依据正文的语义与其中已有标题编码。作为独立字段保存的 `headerPath` 不会自动影响向量。添加标题可改善缺乏主题信息的短片段，但不保证提升所有检索问题，尤其可能因为标题重复、章节泛化或噪声而降低效果。

### 【最小可复现 API：独立构造待编码文本】

~~~typescript
type KnowledgeChunk = {
  content: string;
  metadata?: {
    headerPath?: string[];
    documentId?: string;
  };
};

function buildEmbeddingText(chunk: KnowledgeChunk): string {
  const headers = chunk.metadata?.headerPath ?? [];
  if (headers.length === 0) return chunk.content;

  return [
    `章节：${headers.join(" / ")}`,
    `正文：${chunk.content}`
  ].join("\n");
}

const embeddingTexts = chunks.map(buildEmbeddingText);
const embeddings = await embeddingService.embedTexts(embeddingTexts);
~~~

以上是**建议实现**，并非当前项目源码。若原始 Chunk 已带有当前小节标题，应避免重复拼入相同标题；可以只补充缺失的祖先层级。

不要把所有 Metadata 都无差别加入 Embedding 输入：

| 数据类型 | 示例 | 主要作用 |
|---|---|---|
| 语义上下文 | 文档名、章节标题 | 可选择参与 Embedding |
| 来源定位 | documentId、chunkIndex、offset | 用于引用与定位 |
| 权限与业务范围 | tenantId、knowledgeBaseId | 用于服务端可信过滤 |
| 版本信息 | 更新日期、版本号 | 用于版本管理与筛选 |

尤其不能把知识库或租户 ID 写进向量文本就当作完成权限隔离。权限必须在可信后端与查询过滤链路中落实。

### 【Embedding 本身的机制与职责】

~~~text
输入文本
  → Tokenizer：将文本转换为 Token ID
  → Embedding 模型：进行上下文编码／特征聚合
  → 固定维度的数字向量（如 [0.12, -0.38, ...]）
~~~

Embedding 向量用于表示相关性，不是原文的无损压缩，不应直接用向量还原事实。真实模型输出的维度及输入约定由模型决定。

RAG 通常分为：

~~~text
离线／异步入库：文档 → Chunk → 文档 Embedding → Qdrant
在线查询：用户 Query → 查询 Embedding → 向量检索 → 证据 Chunk
~~~

文档新增或更新时重新处理受影响的 Chunk；不是用户每提问一次就重新编码整个知识库。

### 【LangChain API：embedQuery 和 embedDocuments】

~~~typescript
import { OllamaEmbeddings } from "@langchain/ollama";

const embeddings = new OllamaEmbeddings({
  model: "mxbai-embed-large:latest",
  baseUrl: "http://localhost:11434"
});

// 单条查询字符串 → number[]
const queryVector = await embeddings.embedQuery("入职多久才能休年假？");

// 文档字符串数组 → number[][]
const documentVectors = await embeddings.embedDocuments([
  "员工连续工作满一年后可以申请年假。",
  "员工迟到三次需要提交说明。"
]);
~~~

| API | 输入 | 输出 | 典型用途 |
|---|---|---|---|
| `embedQuery(text)` | 单条 string | `Promise<number[]>` | 查询侧 |
| `embedDocuments(texts)` | string[] | `Promise<number[][]>` | 入库侧 |

两者不仅是数量的区别。部分模型会对查询和文档采用不同的指令前缀、任务形式或编码路径，因此不能认为在所有模型中 `embedQuery(text)` 必然等同于 `embedDocuments([text])[0]`。应遵循具体模型和适配器约定。

### 【妙码 AI Flow 的实际适配层】

源码：[packages/ai-engine/src/knowledge/embeddings/ollama-embeddings.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/embeddings/ollama-embeddings.ts)

项目通过 `OllamaEmbeddings({model, baseUrl})` 创建客户端，封装：

- `embedText(text)`：校验非空、trim 后调用 `this.embeddings.embedQuery()`。
- `embedTexts(texts)`：trim、过滤空串后调用 `this.embeddings.embedDocuments()`。
- `getDimensions()`：读取配置中的维度，**不是从模型输出中动态探测**。

业务调用链：

~~~text
processDocument
  → chunks.map(c => c.content)
  → embeddingService.embedTexts()
  → OllamaEmbeddings.embedDocuments()
  → 与 Chunk 按下标关联并写入 Qdrant

VectorRetriever.retrieve
  → embeddingService.embedText(query)
  → OllamaEmbeddings.embedQuery()
  → vectorStore.search()
~~~

需要排查的边界：当 `embedTexts()` 过滤了空文本，但上游仍按原 Chunk 数组索引配对向量时，有可能错配或缺失。可在调用前验证输入非空、输出数量与向量维度，并保留与原 Chunk 的对应关系。维度应核对真实模型输出与 Collection `size`。

### 【为什么查询与文档需要兼容模型】

向量相似性比较的前提是两端处于兼容的表示空间。文档用模型 A，查询随意换成模型 B，即使两个模型输出维度相同，坐标空间也未必对齐。通常应使用同一模型，或经过专门训练的兼容双编码器，并分别遵循查询侧、文档侧约定。模型或文本构造策略发生改变时，通常需要重建受影响的文档向量索引。

### 【如何评测标题增强是否有效】

准备固定文档集和真实问题集，对比“仅正文”与“标题 + 正文”的不同建库策略，观察 Recall@K、正确证据排序、重复与无关片段、索引体积、生成答案正确率等。可以优先关注正文短且依赖上级标题理解的片段。不把标题增强视为无条件提升准确率的技巧。

### 【面试标准回答】

Embedding 模型将文本编码为可比较的向量，用于在表述不同的句子之间进行语义召回。入库通常通过 `embedDocuments()` 编码文档 Chunk，查询通过 `embedQuery()` 编码用户问题。原文、Metadata 和待编码文本应分离管理；标题是否参与编码取决于是否改善主题表达，并通过真实查询评测验证。要保证模型及查询／文档编码约定兼容，同时检查批量输入对应关系、维度和索引版本。

---

## 【第三节续：向量相似度——Cosine、Dot 与 Euclidean】

### 【提问：如何判断哪一个 Chunk 更相关】

假设查询向量为 `q=(1,1)`，候选文档向量为 `A=(2,2)`、`B=(1,0)`、`C=(-1,1)`，比较三种常见度量。

### 【三种度量的定义和区别】

**1. 余弦相似度（Cosine）**主要比较方向：

~~~text
cos(q,v) = (q·v) / (||q|| × ||v||)
~~~

在示例中，`cos(q,A)=1`、`cos(q,B)≈0.707`、`cos(q,C)=0`。值越大通常表示方向越接近，默认范围为 [-1,1]（非零向量）。

**2. 点积（Dot Product）**受方向和模长共同影响：

~~~text
dot(q,v) = Σ(q_i × v_i)
~~~

在示例中，`dot(q,A)=4`、`dot(q,B)=1`、`dot(q,C)=0`。对于单位 L2 归一化向量，点积等于余弦相似度；未经归一化时，不能忽略模长的影响。

**3. 欧氏距离（Euclidean）**比较向量终点的直线距离：

~~~text
distance(q,v) = sqrt(Σ(q_i - v_i)^2)
~~~

在示例中，`distance(q,A)=√2≈1.414`、`distance(q,B)=1`、`distance(q,C)=2`。欧氏距离越小越接近，因此示例中 Euclidean 首先选 B，Cosine 首先选 A。

两端向量都归一化时，有 `||q-v||² = 2 - 2cos(q,v)`，三种度量经过相应处理可给出一致排序。具体应以 Embedding 模型建议的度量及数据库实现为准，不能认为一种度量必然更准确。

### 【Qdrant 为什么在建 Collection 时指定距离度量】

Qdrant 不仅存储数组，还需要为向量索引和检索指定比较规则。项目的 Collection 创建代码使用：

~~~typescript
await this.client.createCollection(this.collectionName, {
  vectors: {
    size: dimensions,
    distance: "Cosine"
  }
});
~~~

- `size`：每条向量应该具有的维度。
- `distance`：指定向量之间比较的规则。
- `Cosine`：本项目采用的距离度量。Qdrant 会对 Cosine 模式向量进行归一化并据此计算相似性。

因此数据库创建时指定的维度与距离度量不是随意的 UI 参数，而属于索引结构和查询语义的一部分。更换模型、维度或距离策略时，要考虑重新建索引以及重编码数据。

### 【VectorStore 真实检索参数】

~~~typescript
const response = await this.client.search(this.collectionName, {
  vector,
  limit: topK,
  score_threshold: threshold,
  filter: {
    must: [
      {
        key: "knowledgeBaseId",
        match: { any: knowledgeBaseIds }
      }
    ]
  },
  with_payload: true,
  with_vector: false
});
~~~

- `vector` 是用户 Query 生成的向量。
- `topK` 限制最多返回的候选数。
- `score_threshold` 过滤低于当前评分要求的候选，其语义取决于选定距离度量，不能在不同度量间直接照搬数值。
- `with_payload: true` 使返回结果包含正文、文档 ID 等数据。
- `with_vector: false` 避免返回完整向量，减少传输。

源码：[qdrant-store.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)。项目 `VectorRetriever` 默认使用阈值 `0.5`，这是业务默认配置，不是所有模型可通用的最佳阈值。

### 【面试标准回答】

向量距离用于判断查询与文档的相对相关程度。Cosine 注重方向，Dot 同时受模长影响，Euclidean 衡量直线距离；单位归一化向量时它们可产生一致的排序。Qdrant Collection 必须设置向量维度和距离度量来确定索引与检索行为。具体阈值与 Top-K 需要结合模型、文档和真实问题集评测，不能只凭固定经验参数。

---

## 【第三节续：Qdrant Collection、Payload 和 filter.must 的职责】

### 【提问】

以下项目源码中的 `collectionName` 与 `filter.must[].key = "knowledgeBaseId"` 分别是什么？为什么一个 Collection 可以保存多个知识库的数据？它们分别约束检索的哪一层？

~~~typescript
const vectorStore = createQdrantVectorStore({
  collectionName: "knowledge_chunks"
});

const response = await client.search("knowledge_chunks", {
  vector: queryVector,
  filter: {
    must: [
      {
        key: "knowledgeBaseId",
        match: { any: ["kb-001", "kb-002"] }
      }
    ]
  },
  limit: 5
});
~~~

### 【Collection、Point、Vector 和 Payload 是什么】

**Collection** 是 Qdrant 的向量集合，类似关系型数据库的表，但不是完全相同的概念。一个 Collection 有自己的向量维度、距离度量及索引等配置。

**Point** 是集合内的一条向量记录，通常由 Point ID、向量和 Payload 组成。

**Vector** 是 Embedding 输出的数值数组，用于相似性检索。

**Payload** 是与该 Point 关联的结构化字段，可存放原始正文、文档 ID、知识库 ID、元数据等，便于过滤和返回证据。

~~~text
Qdrant
  └─ Collection: knowledge_chunks
       ├─ Point 001
       │    ├─ Vector: [...]
       │    └─ Payload: {knowledgeBaseId:"kb-001", documentId:"doc-001", ...}
       ├─ Point 002
       │    └─ Payload: {knowledgeBaseId:"kb-001", documentId:"doc-001", ...}
       └─ Point 003
            └─ Payload: {knowledgeBaseId:"kb-002", documentId:"doc-009", ...}
~~~

项目采取**多个业务知识库共享 `knowledge_chunks` Collection** 的方式，业务知识库与 Qdrant Collection 并非一对一对应。

### 【collectionName 的作用】

`collectionName` 指定向哪个 Qdrant Collection 执行创建、写入、删除或查询，例如 `knowledge_chunks`。它决定搜索的集合边界。

源码中通过 `createQdrantVectorStore({collectionName: "knowledge_chunks"})` 建立适配器，再调用 `ensureCollection(dimensions)`。Collection 不存在时创建并设置 Cosine/维度；已存在则直接返回。因此在模型维度变更时，不能假设 `ensureCollection` 会自动修改旧 Collection 的配置。

### 【filter.must、key、match.any 的作用】

~~~typescript
filter: {
  must: [
    {
      key: "knowledgeBaseId",
      match: { any: ["kb-001", "kb-002"] }
    }
  ]
}
~~~

各字段含义：

| 字段 | 含义 |
|---|---|
| `filter` | 在 Collection 内添加结构化过滤条件 |
| `must` | 所有列出的条件都必须成立，逻辑关系类似 AND |
| `key` | 在 Point 的 Payload 中检查哪个字段 |
| `match` | 字段匹配规则 |
| `any` | 字段值符合列表中任意一个值，类似 IN / OR |

逻辑上可以类比：

~~~sql
SELECT *
FROM knowledge_chunks
WHERE knowledgeBaseId IN ('kb-001', 'kb-002')
ORDER BY vector_similarity DESC
LIMIT 5;
~~~

**以上仅为 SQL 类比，不是 Qdrant 执行 SQL。**并且过滤并不意味着数据库必须先扫描所有结果再逐条丢弃；Qdrant 能结合过滤条件、Payload 索引和向量索引选择检索方案。

### 【为什么 Collection 和 Filter 要同时存在】

~~~text
第一层：collectionName = "knowledge_chunks"
  → 决定从哪一组向量数据检索

第二层：filter.must + knowledgeBaseId
  → 决定该集合内哪些业务知识库的 Point 有资格参与检索

第三层：向量相似度、topK、score_threshold
  → 在符合条件的数据中寻找并筛选最相关的候选

第四层：with_payload = true
  → 取回正文、文档标识、Metadata 等证据数据
~~~

例如用户只选中 `kb-001`，即使另一知识库 `kb-003` 中存在更相似的内容，也不应返回 `kb-003` 的记录。

项目还为 `knowledgeBaseId` 和 `documentId` 建立 `keyword` Payload 索引：

~~~typescript
await this.client.createPayloadIndex(this.collectionName, {
  field_name: "knowledgeBaseId",
  field_schema: "keyword"
});
~~~

这是为基于业务标识的过滤提供索引支持。是否生效及性能表现还受数据规模、索引状况和查询条件影响。

### 【业务范围过滤与权限边界】

`knowledgeBaseId` 是业务数据归属字段，不能把它天然等同于可信权限校验。若客户端可以自由构造 `knowledgeBaseIds`，只凭 Qdrant 过滤并不能阻止越权访问；服务端必须先验证当前调用者有权访问哪些知识库，再用已经授权的 ID 构造过滤条件。对于多租户场景，还要考虑租户维度和文档粒度权限，不能仅靠语义相似度保证隔离。

在项目 `VectorRetriever` 和 `QdrantVectorStore.search` 中，空知识库 ID 列表会触发校验错误，不应把空 `any` 当成无约束全库查询。

### 【面试标准回答】

`collectionName` 决定 Qdrant 检索的向量集合，是存储与索引层面的选择；`filter.must` 通过 Point 的 Payload 属性进一步限定业务数据范围。一个 Collection 可以承载多个知识库，依靠 `knowledgeBaseId` 区分和过滤。当前项目共用 `knowledge_chunks` Collection，并给 `knowledgeBaseId` 建立 keyword Payload 索引。检索时先确定 Collection，再应用授权范围内的过滤条件，最后按向量相似度与 Top-K 返回内容。权限范围仍须由可信服务端计算与校验。

---

## 【第四节：ANN 与 HNSW 的分层建图和候选搜索机制】

### 【题目与学习目标】

1. 当知识库包含大量 Embedding 向量时，为什么需要 ANN，而不总是穷举所有向量？
2. HNSW 多层图是怎样构建的？节点被划分到哪一层、每层节点数量、各层邻接边，分别依据什么规则？
3. `M`、`ef_construct`、`hnsw_ef` 与最终返回的 `Top-K` 是什么关系？`ef` 是否表示“访问的节点数”“并行探索的路径数”或“图层数”？
4. 搜索如何在多个候选分支之间选择下一步？什么时候扩展邻居、淘汰候选、停止搜索？
5. 妙码 AI Flow 的 Qdrant 调用链实际配置了什么，哪些属于 Qdrant 内部默认行为而非项目手动实现？

本节依照“问题 → 算法机制 → Qdrant 源码 → 业务参数 → 工程取舍 → 面试回答”的逻辑展开。理论示例和业务项目代码分别标注，避免把演示算法误认为源码已经实现的功能。

### 【从精确最近邻到 ANN：为什么需要向量索引】

上一节已经讨论文档与 Query 都通过 Embedding 转为向量，并由 Cosine、Dot 或 Euclidean 判断相似性。假设共有 N 个文档向量，每个向量 d 维。最直接的精确搜索是针对每个向量计算相似度，再选 Top-K，距离计算部分通常为 O(Nd)。

~~~typescript
// 教学示例：假设所有向量已做 L2 归一化，点积可作余弦相似度排序。
type Point = { id: string; vector: number[] };

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, x, i) => sum + x * b[i], 0);
}

function exactTopK(query: number[], points: Point[], k: number) {
  return points
    .map(p => ({ id: p.id, score: dot(query, p.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
~~~

精确搜索的优势是可得到该候选集上的真实相似度 Top-K，缺点是大规模、频繁查询时需要较大的向量读取与计算开销。不过，当候选量很小或硬件加速合适时，精确搜索仍可能更划算，不应一律认为 ANN 必然更快。

**ANN（Approximate Nearest Neighbor，近似最近邻）**通过索引和有限搜索寻找“尽量接近真实 Top-K”的结果，用较小延迟换取可能存在的召回损失。它的“近似”指相对于精确向量最近邻的结果近似，而不是直接保证业务答案正确。

例如精确 Top-5 为 A、B、C、D、E，ANN 返回 A、B、C、D、F，则 ANN Recall@5 = 4/5 = 80%。这与 RAG 的证据 Recall@5 不同：后者衡量真正能回答问题的证据是否被召回。即使 ANN Recall 为 100%，Embedding 表示不佳时仍可能召回错误证据。

### 【HNSW 的整体结构：分层图加优先搜索】

HNSW（Hierarchical Navigable Small World，分层可导航小世界图）不是每次查询都计算全部向量，而是预先维护多层邻接图：

~~~text
建图阶段
  → 新节点随机抽取自己的最高层级 L
  → 它加入第 0 层到第 L 层
  → 在其所在的每一层寻找候选邻居
  → 通过距离与邻居多样性启发式建立连接
  → 更新受影响的邻居连接

查询阶段
  → 从较高层的入口节点导航
  → 逐层下降、靠近 Query 所在区域
  → 在底层保留多个搜索候选并沿邻接边继续探索
  → 搜索停止后返回最相近的 Top-K
~~~

要明确区分两件事：

- **节点在哪些层：主要由随机层级抽样决定**，不是先对文本做语义分类，也不是让“更重要的文档”进入上层。
- **节点在同层连接谁：由向量相似度与邻居选择机制决定**，不是完全随机连接。

从经典 HNSW 概念来看，第 0 层包含全部已被索引的节点，高层只包含其中的子集；一个节点出现在最高层 L 时也出现在 L-1、L-2、…、L0。层数越高，节点一般越少。

假设六个节点在一次抽样中获得以下层级（仅作演示）：

| 节点 | 抽取的最高层 | 实际参与的层 |
|---|---:|---|
| A | 0 | L0 |
| B | 2 | L0、L1、L2 |
| C | 0 | L0 |
| D | 1 | L0、L1 |
| E | 0 | L0 |
| F | 1 | L0、L1 |

则：

~~~text
L2：B
L1：B、D、F
L0：A、B、C、D、E、F
~~~

B 出现在三层是同一个向量节点拥有多层邻接关系，而不是同一篇知识被重复切成三个 Chunk。

### 【每一层的节点数由什么决定】

经典 HNSW 为节点独立抽样最高层级，使用指数衰减的随机分布。可写成：

~~~text
U ~ Uniform(0, 1)
level_factor = 1 / ln(M)
L = floor(-ln(U) × level_factor)
~~~

对经典 floor 版本：

~~~text
P(L >= l) = M^(-l)
~~~

如果 M=16，经典公式下期望有：L0 为全部节点；L1 约 1/16；L2 约 1/256；L3 约 1/4096。

**这只是概率期望，不是“每层预设固定节点数”。**每个节点独立抽样，实际数量有随机波动；真实 Qdrant 索引还可能分布在不同 Segment 中，不能将整个 Collection 的节点数机械套入某一个 Segment 的单张图。

**Qdrant 源码与经典公式存在实现差异。**在当前检索的 Qdrant 源码 `graph_layers_builder.rs` 中：

~~~rust
level_factor: 1.0 / (max(hnsw_m.m, 2) as f64).ln()

pub fn get_random_layer<R>(&self, rng: &mut R) -> usize
where
    R: Rng + ?Sized,
{
    let distribution = Uniform::new(0.0, 1.0).unwrap();
    let sample: f64 = rng.sample(distribution);
    Self::level_from_sample(sample, self.level_factor)
}

fn level_from_sample(sample: f64, level_factor: f64) -> usize {
    let sample = sample.max(f64::MIN_POSITIVE);
    (-sample.ln() * level_factor).round() as usize
}
~~~

它采用 `round()`，而非经典表达中的 `floor()`。因此精确推算当前实现的各层期望节点数时，要以源码的舍入规则为准。设 M=16、共有 10000 个节点，理论上：

| 层 | 经典 floor 抽样期望（约） | 上述 Qdrant round 抽样期望（约） |
|---|---:|---:|
| L0 | 10000 | 10000 |
| L1 | 625 | 2500 |
| L2 | 39 | 156 |
| L3 | 2.4 | 9.8 |
| L4 | 0.15 | 0.61 |

这是基于该实现表达式的分布计算，不是线上系统的实测统计。该差异不能扩大解释为“所有 HNSW 产品都这样实现”。

源码：[GraphLayersBuilder：随机层级和连接构建](https://github.com/qdrant/qdrant/blob/master/lib/segment/src/index/hnsw_index/graph_layers_builder.rs)。

### 【同一层的连接如何建立：为什么不只选最近的 M 个】

设新节点 X 随机获得 L2，系统先在现有上层图找到靠近 X 的入口，再在 X 参与的每层寻找可连接的邻居。

基本步骤：

1. **导航入口**：从已存在的上层入口沿更近的邻居移动，找到新节点所在层附近的入口。
2. **搜索候选**：当前层执行近邻搜索，`ef_construct` 控制建图时考虑的候选范围。
3. **选择连接**：综合距离与邻居多样性选择边，控制每层连接数量。
4. **更新邻接关系**：为新节点及相关已有节点插入／修剪连接；随后向下一层执行。

为什么只连最近的 M 个不够？如果最近节点 A、B、C 均聚集在 X 的同一方向，而 D 稍远但连接另一片区域，单纯选最近节点可能造成局部连接冗余，降低图的可导航性。邻居选择启发式可能保留有助于方向多样性和跨区域导航的节点。它不保证“越远的节点越应该连接”，而是在距离和图连接质量之间取舍。

Qdrant 构建代码中：

~~~rust
let nearest = self.search_on_level(
    &[level_entry],
    curr_level,
    self.ef_construct,
    points_scorer,
    &AtomicBool::new(false),
)?;
~~~

之后通过 `link_with_heuristic()` 等逻辑筛选邻居及更新连接。`ef_construct` 控制**建图阶段候选搜索的宽度**，不是用户查询时最终返回量。

还需区分连接容量：当前 Qdrant `HnswM` 类型将普通层的容量表示为 `m`、第 0 层的容量表示为 `m0`，`HnswM::new2(m)` 采用 `m0 = 2 * m`。这属于“连接上限／目标规模”而非保证每个节点恰好拥有这么多邻居。

源码：[HnswM 连接数量定义](https://github.com/qdrant/qdrant/blob/master/lib/segment/src/index/hnsw_index/mod.rs)。

### 【HNSW 查询：高层导航与底层候选搜索】

查询不是从图里随机挑选一个节点开始扫描全部向量。典型流程是：

~~~text
用户问题 → Embedding 生成 Query Vector
  → 选择已有图的上层入口
  → 从高层开始寻找距离 Query 更近的邻居（典型为贪心导航）
  → 当该层不能进一步改善时下降一层
  → 在底层执行更充分的候选队列搜索
  → 收敛／满足终止条件
  → 输出 Top-K
~~~

上层搜索通常使用较小的搜索宽度快速定位，底层维护多个候选，以降低陷入局部邻域而错过近邻的风险。

**“多路径探索”不是预先指定 N 条独立路径并按顺序跑完。**它是不断从优先队列取出目前最值得扩展的节点，检查其邻居，从而动态改变后续探索的分支。

### 【Top-K、ef、M、ef_construct 的完整区别】

| 参数 | 所在阶段 | 含义 | 不能误解成 |
|---|---|---|---|
| `M` / Qdrant `m` | 建图 | 节点邻接连接的数量规模，也影响随机层级分布 | 每一层节点数或每次探索的总节点数 |
| `ef_construct` | 建图 | 插入节点时搜索候选邻居的广度 | 最终返回量或查询时的 `hnsw_ef` |
| `hnsw_ef`（查询的 `ef`） | 检索 | 搜索中动态维护的当前最佳候选集合容量 | 搜索层数、固定路径数、全程访问节点数 |
| `Top-K` / `limit` | 检索结果 | 最终最多返回的结果数 | HNSW 底层的候选广度 |

例子：

~~~typescript
const result = await client.query("knowledge_chunks", {
  query: queryVector,
  filter: {
    must: [
      {
        key: "knowledgeBaseId",
        match: { any: ["kb-001"] },
      },
    ],
  },
  limit: 5, // Top-K：返回最多 5 条
  params: {
    hnsw_ef: 100, // 候选广度：不是访问 100 个节点或并行 100 条路径
  },
});
~~~

这是 Qdrant 客户端的教学配置例子，**并非妙码 AI Flow 已存在的 hnsw_ef 设置**。最终返回结果数量也受筛选阈值、过滤条件和实际匹配数量影响。

当调用方希望返回很多条结果时，有效搜索宽度必须能容纳所需结果；但不能认为设置 `ef=100` 意味着算法只计算或访问 100 个向量。

### 【ef 具体控制哪个队列：结合 Qdrant SearchContext 源码】

Qdrant 的 `search_context.rs` 中：

~~~rust
pub struct SearchContext {
    /// Overall nearest points found so far
    pub nearest: FixedLengthPriorityQueue<ScoredPointOffset>,
    /// Current candidates to process
    pub candidates: BinaryHeap<ScoredPointOffset>,
}

impl SearchContext {
    pub fn new(ef: usize) -> Self {
        SearchContext {
            nearest: FixedLengthPriorityQueue::new(ef),
            candidates: BinaryHeap::new(),
        }
    }
}
~~~

这两个数据结构不是同一回事：

1. `nearest`：维护**到目前为止找到的最优候选**，长度上限由 `ef` 控制。这里的得分是“越高越相似”的内部评分。
2. `candidates`：保存**待扩展邻居的候选节点**，优先取相似度高的进行下一步搜索。在这里是普通 `BinaryHeap`，不能把它描述为容量严格等于 `ef` 的队列。
3. **已访问集合**：记录哪些节点已被访问，避免无效重复探索；它同样不是 `ef` 个“路径名额”。

进一步看关键代码：

~~~rust
pub fn process_candidate(&mut self, score_point: ScoredPointOffset) {
    let was_added = match self.nearest.push(score_point) {
        None => true,
        Some(removed) => removed.idx != score_point.idx,
    };

    if was_added {
        self.candidates.push(score_point);
    }
}
~~~

当新发现的节点能进入当前最佳集合时，也会加入待探索队列。注意：**加入待探索队列的历史节点后来可能被更优秀的新候选挤出 nearest**，不应该因此认为候选队列始终与 nearest 包含完全相同的元素。

源码：[SearchContext：候选集合与队列](https://github.com/qdrant/qdrant/blob/master/lib/segment/src/index/hnsw_index/search_context.rs)。

### 【具体数字演示：ef=3、Top-K=2】

为了直观说明，只展示“当前最佳集合”的变化；不宣称这是某次 Qdrant 实际查询的完整队列轨迹。

- 设置 `ef=3`：最多保留三个当前最佳候选。
- 设置 `Top-K=2`：最终最多返回两个结果。
- 相似度得分越高越相关。

| 步骤 | 当前发现／发生的事情 | 最佳候选集合（最多 3） | 下一步意图 |
|---|---|---|---|
| 1 | 入口 A 得分 0.60，发现 B=0.72、C=0.58 | B 0.72、A 0.60、C 0.58 | 优先展开高分候选 B |
| 2 | 展开 B 后发现 D=0.84、E=0.66 | D 0.84、B 0.72、E 0.66 | 按分数继续扩展 D |
| 3 | 展开 D 后发现 F=0.90 | F 0.90、D 0.84、B 0.72 | 淘汰较差候选，检查未处理队列 |
| 4 | 假设剩余最优待处理候选仅 0.66，已低于最佳集合最低 0.72 | F 0.90、D 0.84、B 0.72 | 达到停止条件；最终取 F、D |

这一简化过程**累计发现 A、B、C、D、E、F 六个节点**，即使 `ef` 只有 3。因此 `ef` 不是“全程最多查看 3 个节点”，也不是“最多走 3 条路径”。

真实实现还会遇到邻居评分批处理、堆中历史候选、重复访问控制、过滤条件和多层导航，需要以源码为准。

### 【下一条路径怎样选，什么时候停止】

Qdrant `graph_layers.rs` 里底层层内搜索的核心结构（省略部分异常处理与重复节点逻辑）：

~~~rust
while let Some(candidate) = search_context.candidates.pop() {
    if candidate.score < search_context.lower_bound() {
        break;
    }

    points_ids.clear();
    self.for_each_link(candidate.idx, level, |link| {
        if !visited_list.check(link) {
            points_ids.push(link);
        }
    });

    points_scorer
        .score_points(&mut points_ids, limit)
        .for_each(|score_point| {
            search_context.process_candidate(score_point);
            visited_list.check_and_update_visited(score_point.idx);
        });
}
~~~

理解这段代码需要区分三个判断：

**1. 下一步去哪：优先队列决定。**`candidates.pop()` 取出当前评分较高、值得进一步扩展的节点，而非按预定路线顺序访问。

**2. 能否加入最佳集合：与最差候选比较。**`nearest` 未满时可以保留新候选；已满时只有足够优秀的新候选才进入集合，并可能替换最差结果。

**3. 什么时候结束：待扩展中最优候选已无法优于当前最差结果。**`lower_bound()` 返回 `nearest` 中最差节点的得分；若弹出的最优待处理候选得分已经低于它，算法可以按该近似搜索规则停止。例：最佳集合得分为 0.90/0.84/0.72，待处理最优仅 0.66，则满足终止条件。

这个停止规则是**图搜索的近似决策**，不能据此断言“全部未访问节点的得分必然更低”。一个未被探索的图分支里仍可能有真正更近的节点，因此 HNSW 可能丢失精确最近邻。

需要注意 Qdrant 使用的是“越高越好”的 `score` 比较：`candidate.score < lower_bound()` 表示候选较差；如果教学例子改用欧氏距离“越小越好”，比较方向要对应调整。

源码：[GraphLayers：search_on_level 与 search_entry](https://github.com/qdrant/qdrant/blob/master/lib/segment/src/index/hnsw_index/graph_layers.rs)。

### 【到底探索多少条分支：哪些因素动态决定】

**并没有“固定探索路径数”这样一个独立的标准参数。**实际被访问的节点及分支取决于：

1. **图结构：**由 `M`、连接启发式和建图质量决定当前节点有哪些邻居、哪些远端区域能够被连接到。
2. **查询向量与邻居得分：**决定哪些节点更可能进入候选集合、哪个节点优先展开。
3. **`ef` 宽度：**决定最优候选集合能保留多少节点，影响“候选是否已不足以继续改善”这一停止条件。
4. **访问记录：**已处理节点不会反复执行无用的同类访问。
5. **过滤与运行时条件：**Payload 过滤、Segment 状态、索引是否已经建立、搜索实现分支等，也会影响搜索范围与是否使用 HNSW。

因此：

~~~text
M：图里有哪些路可走
ef_construct：建图时如何充分搜索并选择邻居
hnsw_ef：查询时可保留多少较优候选，间接决定探索充分程度
Top-K：搜索结束后实际需要返回多少条
~~~

对某个节点而言，邻接度为 16 不意味着要为其启动 16 条完整独立路径；查询沿优先队列动态扩展。`hnsw_ef=100` 也不保证只发生 100 次相似度计算。

### 【妙码 AI Flow 中的实际接口与边界】

源码：[项目 QdrantVectorStore](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts) 和 [项目 VectorRetriever](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/retriever/vector-retriever.ts)。

项目创建 Collection 时：

~~~typescript
await this.client.createCollection(this.collectionName, {
  vectors: {
    size: dimensions,
    distance: "Cosine"
  },
  optimizers_config: {
    indexing_threshold: 10000
  }
});
~~~

检索时：

~~~typescript
const response = await this.client.search(this.collectionName, {
  vector,
  limit: topK,
  score_threshold: threshold,
  filter: {
    must: [
      {
        key: "knowledgeBaseId",
        match: { any: knowledgeBaseIds }
      }
    ]
  },
  with_payload: true,
  with_vector: false
});
~~~

已核实的事实：

- `topK` 映射到最终 Qdrant 查询的 `limit`。
- 通过 `knowledgeBaseId` Payload Filter 限定搜索的业务知识库范围。
- Collection 距离度量为 Cosine，设置了 `indexing_threshold`。它**不是 `hnsw_ef`，也不是“有一万个节点时才建图”的节点数阈值**。
- **源码中没有显式配置 `m`、`ef_construct` 或 `hnsw_ef`**，因此不能虚构项目中设置了具体 HNSW 参数。
- 查询可能依据过滤规模与索引状态选择不同执行方式；不能从调用了 Qdrant 就推断每次必然经过 HNSW。
- `score_threshold` 进一步筛选结果；即使 `limit=5`，也不保证总能返回 5 条。

### 【如何设计对照实验】

将同一批 Query、相同 Filter 与相同模型用于两种检索：

- **精确检索**：作为向量空间真实 Top-K 的参照。
- **近似检索**：按候选 `hnsw_ef` 设置，例如 32/64/128/256，比较与精确 Top-K 的一致程度。

记录：ANN Recall@K、查询 P50/P95 延迟、距离计算工作量（若有监控）、资源消耗与过滤后的检索表现。另对 RAG 单独评测业务证据 Recall@K 和答案正确性；两类召回率不可混用。

如果增加 `ef` 后延迟增加而正确证据并未改善，可能是 Embedding/Chunking 的问题，而不一定是 HNSW 没搜索充分。在小规模候选或无可用图索引时，修改 `hnsw_ef` 甚至可能没有可观察效果。

### 【本节常见误区纠正】

| 常见误解 | 正确理解 |
|---|---|
| `ef=100` 就是只访问 100 个节点 | 它是当前最佳候选集合容量，不限定全程访问节点总数 |
| `ef=100` 就是并行探索 100 条路径 | 搜索通过优先队列动态探索分支，不存在固定“100 条路径”的定义 |
| `Top-K` 和 `ef` 都是控制候选数量，可相互替代 | Top-K 负责最终返回数；ef 负责近似搜索的候选广度 |
| 上层节点是更重要、更有代表性的文档 | 标准 HNSW 主要使用随机层级抽样，邻接边另按距离和启发式构建 |
| 每层节点数都是固定的 M 个 | M 主要是连接规模参数，层节点数由随机抽样决定 |
| 每个节点会恰好拥有 M 条边 | M 是连接规模约束，实际连接数与层、图结构及修剪过程有关 |
| `ef_construct` 与 `hnsw_ef` 完全一样 | 前者建图时使用；后者查询时使用 |
| 搜索停止意味着证明没有更近节点 | 属于近似图搜索的终止条件，仍可能漏掉未到达的最近邻 |

### 【面试标准回答】

HNSW 通过分层图将大规模向量组织为可导航的邻接关系，以避免每次查询都遍历全部向量。新节点首先按概率分布随机抽取最高层，并出现在从 L0 到该层的所有图层；每层的连接再依据向量相似度、候选搜索和邻居多样性启发式建立。上层节点少，用于快速导航；底层节点全，用于更精细搜索。

其中 `M` 控制图的邻接规模，`ef_construct` 控制建图时搜寻邻居的候选广度，`hnsw_ef` 控制查询时维护的当前最佳候选集合容量，`Top-K` 控制最后返回的结果数量。查询不是预先设定探索多少条路径，而是通过待探索优先队列不断展开更相关的节点，并根据当前候选集合的最差分数判断是否停止。提高 `ef` 往往改善 ANN 召回，但会增加查询开销；它不等于访问节点数、路径数或层数。

项目目前通过 Qdrant 管理索引与过滤，并未自行实现 HNSW 或手动设置核心 HNSW 参数。要判断优化效果，应将近似检索与精确检索对照，并区分“索引是否找到真实最近邻”和“语义检索是否找到业务正确证据”。

### 【源码与进一步核对】

1. [Qdrant GraphLayersBuilder：层级随机抽样、建图搜索与连接](https://github.com/qdrant/qdrant/blob/master/lib/segment/src/index/hnsw_index/graph_layers_builder.rs)
2. [Qdrant HnswM：每层邻接容量定义](https://github.com/qdrant/qdrant/blob/master/lib/segment/src/index/hnsw_index/mod.rs)
3. [Qdrant SearchContext：nearest 与 candidates](https://github.com/qdrant/qdrant/blob/master/lib/segment/src/index/hnsw_index/search_context.rs)
4. [Qdrant GraphLayers：search_on_level 和终止条件](https://github.com/qdrant/qdrant/blob/master/lib/segment/src/index/hnsw_index/graph_layers.rs)
5. [妙码 AI Flow QdrantVectorStore：Collection、Payload 索引、搜索参数](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)

---

## 【第五节：Qdrant 向量索引与 Payload 索引的存储及维护】

### 【问题与知识概述】

本节的核心问题是：向量索引与 Payload 索引分别保存什么、分别服务什么查询？Collection、Shard、Segment、Point 之间是什么关系？数据新增、修改、删除时为什么不需要应用层自行维护整张 HNSW 图？

在 RAG 中，向量相似性解决“哪条文本与问题更相关”；Payload 过滤解决“哪条文本属于允许检索的业务范围”。例如查询“年假由谁审批”时，语义最相似的财务知识库文本仍不应越过已授权的 `knowledgeBaseId` 范围。

Qdrant 中一条 Point 的典型结构为：

~~~typescript
{
  id: "point-001",
  vector: [0.12, -0.38, 0.57], // 演示数值
  payload: {
    content: "员工提前三个工作日提交年假申请。",
    knowledgeBaseId: "kb-hr",
    documentId: "doc-001",
    chunkIndex: 0
  }
}
~~~

- **Point ID**：定位记录；以相同 ID Upsert 可覆盖同一 Point。
- **Vector**：Embedding 输出的数值表示，用来衡量相似性。
- **Payload**：业务属性、文档来源和正文，可用于过滤、展示与引用。
- **Collection**：同一组向量参数和记录的逻辑集合，内部有 Shard 和 Segment。

| 项目 | 向量索引（Vector Index） | Payload 索引（Payload Index） |
|---|---|---|
| 解决什么 | 与 Query 向量距离最近的 Point 在哪里 | 哪些 Point 满足字段过滤条件 |
| 索引依据 | 向量距离、邻接图（常见稠密向量 HNSW） | Payload 字段和值 |
| 典型操作 | Cosine、Dot 等相似度排序 | keyword 精确匹配、range、text 等 |
| 相关参数 | M、ef_construct、hnsw_ef、Top-K | field_name、field_schema、filter |
| 检索策略 | HNSW 或在合适规模下精确扫描 | 字段索引匹配、估计候选数、辅助过滤感知搜索 |

**索引与存储不是同一个概念。**将 `content` 或 `knowledgeBaseId` 放入 Payload，不代表 Qdrant 自动针对它建立了独立的检索索引；需要为常用过滤字段创建 Payload 索引。

### 【项目真实调用链：Collection 与 Payload 索引何时创建】

源码：[妙码 AI Flow：QdrantVectorStore](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)、[document-processor.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/lib/services/document-processor.ts)。

~~~text
文档上传／读取
    ↓
Chunking → Embedding → ChunkWithVector[]
    ↓
createQdrantVectorStore({ collectionName: "knowledge_chunks" })
    ↓
ensureCollection(dimensions)
    ├─ Collection 不存在：createCollection + createPayloadIndex
    └─ Collection 已存在：直接返回
    ↓
upsertVectors(vectorChunks)
    ↓
Qdrant 负责数据与索引维护
~~~

项目实际创建：

~~~typescript
await this.client.createCollection(this.collectionName, {
  vectors: {
    size: dimensions,
    distance: "Cosine",
  },
  optimizers_config: {
    indexing_threshold: 10000,
  },
});

await this.client.createPayloadIndex(this.collectionName, {
  field_name: "knowledgeBaseId",
  field_schema: "keyword",
});
await this.client.createPayloadIndex(this.collectionName, {
  field_name: "documentId",
  field_schema: "keyword",
});
~~~

其中：

1. `size` 指定向量维度，`distance: "Cosine"` 指定距离度量。
2. `indexing_threshold` 影响 Qdrant Indexing Optimizer 何时为达到一定向量数据规模的 Segment 建图；这里的 10000 **不是一万个 Point 的计数阈值**，对应按 KB 衡量的向量数据规模阈值。
3. `knowledgeBaseId` 用于按知识库筛选与删除，`documentId` 用于按文档删除；二者被显式创建为 Keyword Payload 索引。
4. **创建空 Collection 不等于立即已经生成 HNSW 图**，索引是否建立取决于 Segment 数据规模与后台优化状态。
5. 项目 `ensureCollection()` 首先执行 `getCollections()`，若名称已经存在就直接返回，**不会补建缺失的 Payload 索引，也不检查维度和距离配置是否一致**。这是需要补齐的工程边界。
6. 为了后续 Filterable HNSW 图能够结合过滤字段建立增强连接，应优先在大量向量入库及构建 HNSW 图之前创建需要的 Payload 索引。

官方说明：[Qdrant Indexing](https://qdrant.tech/documentation/manage-data/indexing/)、[Filtering in Vector Search](https://qdrant.tech/documentation/search-patterns/vector-search-filtering/)。

### 【新增 Point：WAL、Segment、Payload Index 与 HNSW】

项目组装 Point：

~~~typescript
const points = chunks.map(chunk => ({
  id: this.stringToUuid(chunk.id),
  vector: chunk.vector,
  payload: {
    chunkId: chunk.id,
    content: chunk.content,
    chunkIndex: chunk.index,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    documentId: chunk.documentId,
    knowledgeBaseId: chunk.knowledgeBaseId,
    metadata: chunk.metadata || {},
  },
}));

// 每批最多 100 个 Point
await this.client.upsert(this.collectionName, {
  points: batch,
  wait: true,
});
~~~

从 Qdrant 内部机制看：

~~~text
Upsert Point
  → Write-Ahead Log（WAL，写前日志）：保证更新可恢复
  → 更新 Segment 中 Point 有效状态、Vector 和 Payload
  → 维护相关 Payload 字段索引
  → 根据 Segment 状态和 Optimizer 条件管理 HNSW 索引
  → 查询时可读取有效 Point
~~~

`wait: true` 表示等待该数据更新操作应用完成，**不表示所有后台 HNSW 构建、Segment 合并与索引优化都已完成**。在小 Segment 或尚未建图时可以使用精确扫描；如启用 `indexed_only` 或特定实验性优化选项，可见性规则可能发生变化，不应把普通查询行为扩大到所有配置。

### 【修改 Point：原向量、Payload 与索引怎样变化】

修改文档正文后可重新计算 Embedding，并对相同 Point ID 执行 Upsert：

~~~typescript
await client.upsert("knowledge_chunks", {
  points: [{
    id: "point-001",
    vector: newVector,
    payload: {
      content: "年假应提前三个工作日申请",
      knowledgeBaseId: "kb-hr",
      documentId: "doc-001",
    },
  }],
  wait: true,
});
~~~

相同 ID 的 Upsert 不是再创建一条有效的业务记录，而是更新对应 Point 的有效状态。Qdrant 负责旧版本处理及必要的后台图维护，业务代码无需直接操作 HNSW 边。如果仅修改 Payload 字段，可考虑专门的 Payload 更新 API；若文本语义变化则应更新向量，避免正文与旧向量不一致。

当前项目 Chunk ID 的构造规则为：

~~~typescript
id: `${documentId}_${idx}`
~~~

若旧文档切出五块 `doc-001_0` 到 `doc-001_4`，新版本只切出三块 `doc-001_0` 到 `doc-001_2`，只 Upsert 新三块不会自动删除原本存在的尾部两块。所以日后实现“文档重新处理”，需要设计旧 Chunk 清理或版本切换，不可仅依赖固定 ID 覆盖。

### 【删除 Point：逻辑删除与物理空间回收】

项目按 `documentId` 过滤删除：

~~~typescript
await this.client.delete(this.collectionName, {
  filter: {
    must: [{
      key: "documentId",
      match: { value: documentId },
    }],
  },
  wait: true,
});
~~~

`documentId` 索引用于帮助确定删除范围。删除后 Point 不再作为正常有效结果返回，但底层存储空间与过时索引结构的回收可能由后台 Optimizer 完成。**逻辑删除生效，不等于整张 HNSW 图立即同步重建，也不等于磁盘立刻缩小。**

实际文档删除 API 顺序：

~~~text
检查当前用户与知识库归属
  → prisma.document.delete()
  → prisma.knowledgeBase.update()，减少文档数与 Chunk 数
  → deleteDocumentVectors(docId)
  → Qdrant delete(filter: documentId)
~~~

源码：[documents/[docId]/route.ts](https://github.com/cxDlogver/miaoma-aiflow/blob/main/apps/workflow/app/api/knowledge/%5Bid%5D/documents/%5BdocId%5D/route.ts)。

若关系型数据库删除成功而 Qdrant 删除失败，可能残留向量；这是**两个独立数据库之间的最终一致性风险**。此外上传 API 对 `processDocument()` 的调用是“不等待处理完成，仅 catch 错误”的异步逻辑：若上传处理仍在写入而用户开始删除文档，还可能发生删除与新 Upsert 的竞争。更稳健的方案需要持久化任务状态、幂等清理、重试与状态/版本校验；不能说项目已经实现跨存储事务。

官方说明：[Qdrant Optimizer](https://qdrant.tech/documentation/ops-optimization/optimizer/)。

### 【Segment：为什么 Collection 不等于单一 HNSW 图】

Qdrant 在 Collection 下组织 Shard，在 Shard 内进一步管理 Segment。每个 Segment 具有相对独立的向量存储、Payload 存储、Point ID 映射和索引状态。

~~~text
Collection：knowledge_chunks
  └─ Shard
      ├─ Segment A → Vector Storage / Payload / HNSW A / Payload Index
      ├─ Segment B → Vector Storage / Payload / 尚无 HNSW，允许精确扫描
      └─ Segment C → Vector Storage / Payload / HNSW C / Payload Index
~~~

因此，同一 Collection **不一定只有一张 HNSW 图**；不同 Segment 可以分别维护图及索引，优化器按需要合并或重建。

| Optimizer | 主要作用 | 触发判断与代价 |
|---|---|---|
| Indexing Optimizer | 对达到索引条件的 Segment 建立向量索引 | 数据规模及相关阈值；有建图开销 |
| Merge Optimizer | 合并小 Segment，减少碎片和调度成本 | Segment 分布与优化器配置 |
| Vacuum Optimizer | 清理删除记录，整理存储 | 删除比例与 Segment 大小 |

这些是后台职责，不代表每次写入都完整同步运行所有优化器。

---

## 【第五节追问一：Filterable HNSW 是否同时考虑 Vector 和 Payload】

### 【直接结论：普通邻接边看 Vector，过滤增强边结合已索引 Payload】

**会同时利用两类信息，但作用方式不同。**普通 HNSW 的邻接关系主要依据向量距离和邻居多样性选择策略；Qdrant Filterable HNSW 还利用已索引的 Payload 字段构建额外的图连接，使过滤后的候选点更容易在图上导航。

不能将其描述为“对知识库 ID 生成 Embedding，然后和原向量求平均”，也不是改写 Cosine 公式把 Payload 字段数值加权。它是在向量图上增加支持过滤搜索的连接，**不是为每个知识库分别建立一张完全独立的 HNSW 图**。

### 【六个 Point 的示例：不做过滤增强可能发生什么】

假设 A、C、E 属于 `kb-001`，B、D、F 属于 `kb-002`；普通 HNSW 连接（纯示意）：

~~~text
A —— B —— D —— C —— F —— E
~~~

普通向量图允许不同知识库之间存在近邻关系。这没有问题，因为它只负责语义导航。

但用户要求：

~~~typescript
filter: {
  must: [{
    key: "knowledgeBaseId",
    match: { value: "kb-001" }
  }]
}
~~~

符合条件的结果只有 A、C、E。若在图搜索时简单丢弃不符合条件的 B、D、F，A 可能难以抵达 C、E，使原本可召回的结果缺失。

常见三种方案：

1. **后过滤（Post-filtering）**：先对全库做向量 Top-K，再丢弃不符合条件的 Point。优点是实施简单，但因为若干名额被不合法结果占据，最终可能返回不足 K 条，即使库内存在更多合法匹配。
2. **预过滤 + 精确扫描（Pre-filtering with exhaustive scoring）**：先列出所有满足过滤的 Point，再逐个计算向量距离，得到符合范围的精确最近邻；过滤后的候选很大时计算成本高。
3. **过滤感知图检索（Filterable HNSW）**：在图搜索期间利用 Payload 过滤条件，并通过预先添加的连接更高效地在满足条件的节点间导航；不必先获取不受限的全库 Top-K 再丢弃。

图结构的教学示意：

~~~text
基础图：A —— B —— D —— C —— F —— E
增强边：A - - - - - - - - C - - - E
         ↑                ↑       ↑
       kb-001           kb-001  kb-001
~~~

虚线不是保证一定产生的具体 HNSW 连接，而是说明额外边为什么有助于“只允许 `kb-001`”的图导航。

### 【是否所有 Payload 字段都用于 HNSW 加边】

不是。业务保存的 Payload 中包含 `content`、`knowledgeBaseId`、`documentId`、`chunkIndex`、`metadata` 等，但项目只显式创建 `knowledgeBaseId` 和 `documentId` 的 Keyword Payload 索引。

当前 Qdrant 内部源码 `additional_links_fields()` 会读取已经索引的字段，并检查该字段索引是否允许 `enable_hnsw()`，再决定是否参与添加过滤增强边；具体规则受版本、类型及配置影响。

源码：[Qdrant additional_links.rs](https://github.com/qdrant/qdrant/blob/master/lib/segment/src/index/hnsw_index/hnsw/build/additional_links.rs)。

**创建时机重要：**要让字段参与已构建 HNSW 图的过滤增强，通常应在建图之前创建对应 Payload 索引。已有图建好后再增加字段索引，不意味着旧图立即新增全部过滤边；一般要等 HNSW 图重建。

**多字段组合过滤是另一层问题。**额外连接通常是面向各单独索引字段建立的，并不保证针对任意 `知识库ID + 时间 + 权限` 组合预先建好强连通子图。在高选择性组合过滤和大量软删除节点场景中，可能需要增加查询探索范围，或在支持的版本中使用 ACORN 等扩展搜索方式以改善过滤召回，代价是更多搜索工作。

参考官方：[Filtering in Vector Search](https://qdrant.tech/documentation/search-patterns/vector-search-filtering/)、[Qdrant Indexing](https://qdrant.tech/documentation/manage-data/indexing/)。

### 【本追问面试标准回答】

Qdrant 建图时，普通 HNSW 边主要根据向量距离和邻居启发式构建，不要求两个节点的业务 Payload 相同。对于 Filterable HNSW，系统可以结合已建立索引且允许 HNSW 增强的 Payload 字段增加额外连接，使严格过滤时仍更易在图上导航。这并不是用 Payload 改写向量距离公式，也不表示一个知识库会生成一张完全独立的 HNSW 图。创建 Payload 索引的时机和组合过滤的选择性都会影响检索效果，应以精确检索为对照验证过滤召回。

---

## 【第五节追问二：不同 Segment 是否分别搜索，再合并全局 Top-K】

### 【直接结论：局部搜索与全局聚合】

**是。Qdrant 在相关 Shard 内组织 Segment 搜索任务，分别获取局部候选，再将候选合并排序，形成该查询范围的统一 Top-K。**不同 Segment 可以拥有不同的数据规模、索引状态和查询执行策略，并非所有 Segment 都必须用 HNSW。

概念链路：

~~~text
Collection: knowledge_chunks
       ↓
相关 Shard（分布式部署可能包含多个）
       ↓
SegmentSearcher
       ↓
 ┌────────────┼────────────┐
 ▼            ▼            ▼
Segment A   Segment B    Segment C
HNSW 搜索    精确扫描     HNSW / 精确扫描
 ▼            ▼            ▼
局部候选 A   局部候选 B   局部候选 C
 └────────────┼────────────┘
              ▼
    聚合、版本处理、去重、排序
              ▼
   必要时对部分 Segment 重新检索
              ▼
     查询范围内的最终 Top-K
~~~

**Shard 和 Segment 不同：**分布式部署时 Collection 可以被划为多个 Shard，每个 Shard 又有多个 Segment。本节讨论的是 Shard 内部 Segment 搜索；跨 Shard 还存在更高一层的结果聚合。

### 【源码：SegmentsSearcher 真正执行并发局部检索】

Qdrant 源码：[segments_searcher.rs](https://github.com/qdrant/qdrant/blob/master/lib/collection/src/collection_manager/segments_searcher.rs)。

`SegmentsSearcher::search()` 首先收集可检索的 Segment，并为它们组织搜索任务，包含以下源代码：

~~~rust
// perform search on all segments concurrently
let (all_search_results_per_segment, further_results) =
    Self::execute_searches(searches).await?;
~~~

之后使用：

~~~rust
let (mut result_aggregator, searches_to_rerun) =
    Self::process_search_result_step1(
        all_search_results_per_segment,
        // 这里省略 batch_request.searches 中的 limit + offset 等参数
    );
~~~

第二段为便于阅读的**结构示意而非可直接编译的完整 Rust 调用**。其核心职责是聚合局部候选、追踪各 Segment 是否还有更多可用结果，并决定是否对采样不足的 Segment 重新搜索。源码还涉及 Point 版本处理与避免过期版本重复计算。

### 【三 Segment 数值例子】

假设当前 Query 需要 `Top-K=3`；过滤后的局部候选：

| Segment A | Segment B | Segment C |
|---|---|---|
| A1 0.94 | B1 0.91 | C1 0.89 |
| A2 0.78 | B2 0.83 | C2 0.71 |
| A3 0.63 | B3 0.55 | C3 0.60 |

全局合并后前三名为 `A1(0.94)、B1(0.91)、C1(0.89)`。但如果 A 的最高三条得分为 0.99、0.98、0.97，则全局 Top-3 也可能全部来自 Segment A。**最终不是“每个 Segment 分别提供一条”，而是按所有候选的得分全局比较。**

### 【为什么不始终要求每个 Segment 返回 K 条】

如果每个 Segment 都执行精确排序且无去重和版本冲突，**全局 Top-K 一定包含在所有 Segment 的局部 Top-K 的并集中**：反证——若某条 Point 在自己 Segment 的局部排名 >K，就至少有该 Segment 的 K 条记录比它更好，它不可能进入全局前 K。排序有并列分数时还需确定一致的 tie-breaking 规则。

所以理想情况下每个 Segment 返回 K 条是充分的，但可能代价很大。例如 10 个 Segment、全局 K=1000，机械拉取每个 Segment 1000 条可能累计获取 10000 条，而最终只返回 1000 条。

Qdrant 可按各 Segment 点数占比、搜索限制等估算**局部采样数量**，减少过度获取。这又引出风险：若某个 Segment 实际含有很多全局高分项，但采样过少，汇总后的 Top-K 可能遗漏应该由它贡献的候选。

源码中的 `process_search_result_step1()` 通过对比：

1. 当前跨 Segment 聚合的最低分数；
2. 各 Segment 已返回部分的最低分数；
3. 相应 Segment 是否还有进一步结果；
4. 各 Segment 局部检索是否发生采样；

判断有无必要**重新运行相应 Segment 的未采样检索**。

例如全局 Top-K 的最低分数为 0.86，而 Segment A 只采样到最低得分 0.87；若 A 还存在更多结果，就可能存在得分 0.865 的 Point 被省略，这个 Point 也应该进入全局 Top-K。重查 A 可以弥补因局部采样量不足造成的遗漏。

必须区分：

- **采样遗漏：**Segment 没有返回足够候选导致全局合并结果不完整，可借助重查相关 Segment 纠正。
- **ANN 近似误差：**Segment 内 HNSW 本身没找到真实向量最近邻，即使每个 Segment 都返回 K 条候选，全局聚合也无法找回从未被局部搜索发现的 Point。

因此不能说“多个 Segment 合并之后就保证了全局精确 Top-K”；只有局部结果准确且候选足够等前提成立，才有相应保证。

### 【项目开发者是否需要手动遍历 Segment】

在妙码 AI Flow 中，业务端直接调用 Qdrant 的 Collection 查询：

~~~typescript
await this.client.search(this.collectionName, {
  vector,
  limit: topK,
  score_threshold: threshold,
  filter: {
    must: [{
      key: "knowledgeBaseId",
      match: { any: knowledgeBaseIds },
    }],
  },
  with_payload: true,
  with_vector: false,
});
~~~

**业务代码不需要逐个获取 Segment 并自行合并结果**，这是 Qdrant 引擎职责。业务只需正确指定向量、Collection、授权过滤范围与返回数量。

但跨 Segment 查询延迟会受到局部检索耗时、Segment 数量、并发调度、聚合和可能的重查影响。检索性能问题应结合 Segment 状态和优化器工作情况评估，而不只观察最终 Top-K 分数。

### 【本追问面试标准回答】

Qdrant 会对相关 Segment 分别执行局部搜索；每个 Segment 拥有自己的存储、向量图和 Payload 索引状态，可以选择 HNSW 或精确扫描。`SegmentsSearcher` 并发运行局部查询，将候选汇总后选取整个查询范围内的 Top-K。为了避免每个 Segment 一律返回 K 条的过度读取，源码还具有局部采样与必要时重新检索的逻辑。该机制针对多 Segment 聚合过程中的采样缺口，并不自动消除 HNSW 的近似搜索误差。

---

## 【第五节总结：两种索引、两种连接、两级检索】

~~~text
Collection → Shard → Segment → Point(Vector + Payload)

向量索引：向量距离 → HNSW 邻接图 → ANN
Payload 索引：字段匹配 → 过滤候选与估计基数
Filterable HNSW：普通向量边 + 针对可用 Payload 字段的增强边

Segment 内：
  依过滤与索引状态选择 HNSW / 精确扫描

Segment 之间：
  并发局部搜索 → 聚合全局候选 → 必要时重查

业务层：
  文档切分／Embedding／数据写入／权限校验／跨存储一致性
  不直接维护 Segment 的邻接图
~~~

这节最重要的三个边界：

1. Payload 字段与向量距离不混为一谈，Filterable HNSW 是图连接层面的增强。
2. Collection 不是必定对应一张大 HNSW 图；Segment 有各自的检索状态。
3. 跨 Segment 聚合能弥补局部**采样过少**引起的候选不足，但不能自动弥补局部 ANN 近似误差。

### 【进一步阅读与源码】

1. [Qdrant Filtering in Vector Search 官方指南](https://qdrant.tech/documentation/search-patterns/vector-search-filtering/)
2. [Qdrant Indexing 官方文档](https://qdrant.tech/documentation/manage-data/indexing/)
3. [Qdrant Optimizer 官方文档](https://qdrant.tech/documentation/ops-optimization/optimizer/)
4. [Qdrant additional_links.rs：依据已索引 Payload 字段构建过滤增强边](https://github.com/qdrant/qdrant/blob/master/lib/segment/src/index/hnsw_index/hnsw/build/additional_links.rs)
5. [Qdrant segments_searcher.rs：并行局部搜索、聚合和重查](https://github.com/qdrant/qdrant/blob/master/lib/collection/src/collection_manager/segments_searcher.rs)
6. [妙码 AI Flow QdrantVectorStore：业务 API 与配置](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)

## 【第六节：跨 Segment Top-K、局部采样与重查】

### 【提问】

1. 为什么每个 Segment 取得局部 Top-K 可以覆盖全局 Top-K，又为什么可能造成过度获取？
2. 若首次减少各 Segment 返回候选的数量，怎样识别本该进入全局前 K 的候选遗漏？
3. Qdrant 如何根据 Segment 占比、泊松采样和 HNSW ef 决定初次返回量？
4. 哪三个条件会触发重查？关闭采样是否等于精确向量检索？
5. offset 与 limit 如何参与全局分页？为什么不能在各 Segment 独立跳过 offset？
6. 聚合阶段的采样遗漏和 HNSW 的 ANN 误差有什么区别？

### 【回答要点】

**局部 Top-K 足够，但可能浪费。**在局部排序准确、分数可比且没有复杂重复版本的前提下，一个不在所属 Segment 前 K 名的 Point 不可能进入全局前 K。因此可以合并各 Segment 的局部 Top-K；但当 Segment 数量很多时会获得大量最终被丢弃的候选。

**局部采样的风险。**例如最终 Top-5，Segment A 初次只返回 0.98、0.96，但它还有第三条 0.94；其他 Segment 的候选合并后末位可能仅有 0.88。即便首次候选数已经达到五条，仍可能遗漏本应进入全局前五的 0.94。这里的“每段返回两条”仅是教学示意，不代表 Qdrant 的实际默认采样配额。

**重查条件。**Qdrant 源码的 `process_search_result_step1()` 同时检查：`have_further_results`（可能还有剩余候选）、`retrieved_points < required_limit`（首次取回不足所需前缀数量）和 `segment_lowest_score >= lowest_batch_score`（该段末位不低于聚合末位，仍可能存在应该进入全局结果的候选）。同时满足才加入重查列表。

**重查的边界。**`search_in_segment(..., false, ...)` 中的 `false` 是关闭跨 Segment 的局部结果数量采样，不代表 `exact: true`；如果 Segment 使用 HNSW，重查仍可能是 ANN。

**采样数量。**Qdrant 基于 Segment 点数占总点数的比例，使用泊松分布预计算表估算候选数量；若有适用的 HNSW ef，其局部上限计算为 `min(required_limit, max(poisson_sampling, ef_limit))`。因此若 required_limit=5、ef_limit=100，不会被压缩为每段两条；Plain Index 等无 ef 的情况可直接使用完整 limit。

**分页。**`offset=5, limit=5` 表示全局跳过前五条、返回第六至第十条；聚合阶段需要覆盖 `offset + limit = 10` 的候选前缀，不应让每个 Segment 自行跳过五条。Qdrant 源码使用 `request.limit + request.offset` 计算该范围。

**必须区分的两种误差。**聚合采样遗漏是局部首次返回量过少，可通过判定并重查改善；ANN 近似误差是图搜索本身没发现真正最近邻，聚合不能凭空恢复未检索出的 Point。跨页还可能出现独立查询的排序漂移。

### 【标准回答】

Qdrant 的多个 Segment 独立搜索并聚合为全局 Top-K。完整获取各段 Top-K 在精确局部排序前提下足够，但可能过度获取，因此 Qdrant 按 Segment 数据占比、概率采样与 HNSW ef 估算局部首次返回量。聚合后检查各段是否可能仍有结果、已取数量是否不足、局部最低分是否不低于全局最低分；对满足条件的 Segment 关闭局部采样重新检索，再合并排序。此机制不保证消除 HNSW 的近似误差。分页必须在全局层面考虑 limit+offset，再截取结果。

### 【源码与后续衔接】

- [segments_searcher.rs：采样、重查条件与 offset](https://github.com/qdrant/qdrant/blob/master/lib/collection/src/collection_manager/segments_searcher.rs)
- [probabilistic_search_sampling.rs：泊松分布采样](https://github.com/qdrant/qdrant/blob/master/lib/collection/src/collection_manager/probabilistic_search_sampling.rs)
- [search_result_aggregator.rs：聚合与版本处理](https://github.com/qdrant/qdrant/blob/master/lib/shard/src/search_result_aggregator.rs)
- [妙码 AI Flow 的 Qdrant 搜索实现](https://github.com/cxDlogver/miaoma-aiflow/blob/main/packages/ai-engine/src/knowledge/store/qdrant-store.ts)

---

## 【下一题：Hybrid Search、BM25 与 RRF】

讨论关键词与语义检索的互补、BM25 的词频/IDF/长度归一化以及 RRF 如何融合不同检索通道。**妙码 AI Flow 在 2026-10-13 的多空间改造中已使用 Qdrant 原生 BM25，旧版 textSearch() 的 scroll 扫描属于历史实现**。完整现行源码分析衔接：[多 Embedding 知识库构建、跨空间检索与补充召回完整分析](./RAG多Embedding知识库构建与跨空间检索及补充召回源码分析.md)。
