/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { BM25_CONFIG_ID } from '../bm25'
import { createOllamaEmbeddingService } from '../embeddings'
import { createQdrantVectorStore } from '../store'
import type {
    EmbeddingService,
    KnowledgeIndexDescriptor,
    KnowledgeRetrievalService,
    RetrievalOptions,
    RetrievalResult,
    VectorStoreService,
} from '../types'
import { validateRetrievalRequest } from '../validation'
import { HybridRetriever } from './hybrid-retriever'
import { fuseRankedLists } from './rank-fusion'

export interface MultiKnowledgeDependencies {
    /** 业务层先授权再返回 READY 索引；不从普通工作流输入读取主体。 */
    resolveIndexes(ids: string[]): Promise<KnowledgeIndexDescriptor[]>
    filterVisibleResults(results: RetrievalResult[]): Promise<RetrievalResult[]>
    createEmbedding?: (index: KnowledgeIndexDescriptor) => EmbeddingService
    createStore?: (index: KnowledgeIndexDescriptor) => VectorStoreService
    qdrantUrl?: string
    ollamaBaseUrl?: string
    concurrency?: number
    timeoutMs?: number
}

export class MultiKnowledgeRetriever implements KnowledgeRetrievalService {
    constructor(private readonly deps: MultiKnowledgeDependencies) {}

    async retrieve(options: RetrievalOptions): Promise<RetrievalResult[]> {
        validateRetrievalRequest(options)
        const ids = [...new Set(options.knowledgeBaseIds)]
        const indexes = await this.deps.resolveIndexes(ids)
        if (indexes.length !== ids.length || ids.some(id => !indexes.some(index => index.knowledgeBaseId === id))) {
            throw new Error('Knowledge base authorization or index resolution failed')
        }
        const groups = new Map<string, KnowledgeIndexDescriptor[]>()
        for (const index of indexes) {
            if (
                index.status !== 'READY' ||
                index.provider !== 'ollama' ||
                index.bm25ConfigId !== BM25_CONFIG_ID ||
                index.queryEncodingVersion !== 'ollama-raw-v1' ||
                index.documentEncodingVersion !== 'ollama-raw-v1'
            ) {
                throw new Error('Knowledge index is not ready or uses an unsupported encoding protocol')
            }
            const group = groups.get(index.embeddingSpaceId) ?? []
            if (
                group[0] &&
                ['collectionName', 'model', 'modelRevision', 'dimensions', 'bm25ConfigId'].some(
                    field => group[0]![field as keyof KnowledgeIndexDescriptor] !== index[field as keyof KnowledgeIndexDescriptor]
                )
            ) {
                throw new Error('Embedding space contains conflicting index descriptors')
            }
            group.push(index)
            groups.set(index.embeddingSpaceId, group)
        }
        const entries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
        const candidateTopK = Math.min(100, Math.max(20, options.topK * 4))
        const lists: Array<{ results: RetrievalResult[]; weight: number; source: 'hybrid' | 'dense' | 'bm25'; embeddingSpaceId: string }> =
            []
        let cursor = 0
        let failed = false
        const worker = async () => {
            while (!failed && cursor < entries.length) {
                const [spaceId, group] = entries[cursor++]!
                const index = group[0]!
                try {
                    const store =
                        this.deps.createStore?.(index) ??
                        createQdrantVectorStore({
                            url: this.deps.qdrantUrl,
                            collectionName: index.collectionName,
                        })
                    // 纯全文检索不创建或调用 Dense Encoder。
                    const embedding =
                        options.mode === 'fulltext'
                            ? undefined
                            : (this.deps.createEmbedding?.(index) ??
                              createOllamaEmbeddingService({
                                  model: index.model,
                                  modelRevision: index.modelRevision,
                                  dimensions: index.dimensions,
                                  baseUrl: this.deps.ollamaBaseUrl,
                              }))
                    const retriever = new HybridRetriever(
                        embedding,
                        store,
                        store.textSearch ? { search: opts => store.textSearch!(opts) } : undefined
                    )
                    let timer: ReturnType<typeof setTimeout> | undefined
                    const results = await Promise.race([
                        retriever.retrieve({
                            ...options,
                            topK: candidateTopK,
                            knowledgeBaseIds: group.map(i => i.knowledgeBaseId),
                            indexScopes: group,
                        }),
                        new Promise<never>((_, reject) => {
                            timer = setTimeout(() => reject(new Error('Knowledge space query timed out')), this.deps.timeoutMs ?? 30000)
                        }),
                    ]).finally(() => clearTimeout(timer))
                    // 即便存储适配器返回额外候选，也不能让越权/旧版本证据进入输出。
                    if (results.some(r => !group.some(i => i.knowledgeBaseId === r.knowledgeBaseId && i.indexId === r.indexId))) {
                        throw new Error('Storage returned an unauthorized index candidate')
                    }
                    lists.push({
                        results: await this.deps.filterVisibleResults(results.map(r => ({ ...r, embeddingSpaceId: spaceId }))),
                        weight: 1,
                        source: options.mode === 'vector' ? 'dense' : options.mode === 'fulltext' ? 'bm25' : 'hybrid',
                        embeddingSpaceId: spaceId,
                    })
                } catch (error) {
                    failed = true
                    throw new Error('Knowledge space ' + spaceId + ' failed: ' + (error instanceof Error ? error.message : String(error)))
                }
            }
        }
        await Promise.all(Array.from({ length: Math.min(Math.max(1, this.deps.concurrency ?? 3), entries.length) }, worker))
        // 防止查询期间撤权/切换索引；不把旧配置的结果当成新索引结果。
        const current = await this.deps.resolveIndexes(ids)
        if (
            current.length !== indexes.length ||
            indexes.some(i => !current.some(c => c.knowledgeBaseId === i.knowledgeBaseId && c.indexId === i.indexId))
        ) {
            throw new Error('Knowledge authorization or active index changed during retrieval')
        }
        const ordered = lists.length === 1 ? lists[0]!.results : fuseRankedLists(lists)
        return (await this.deps.filterVisibleResults(ordered)).slice(0, options.topK)
    }
}
