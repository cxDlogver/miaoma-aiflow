/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { QdrantClient } from '@qdrant/js-client-rest'

import { BM25_VECTOR_NAME, bm25Document, DENSE_VECTOR_NAME } from '../bm25'
import type {
    BM25SearchOptions,
    ChunkWithVector,
    IndexScope,
    VectorSearchOptions,
    VectorSearchResult,
    VectorStoreConfig,
    VectorStoreService,
} from '../types'
import { DEFAULT_VECTOR_STORE_CONFIG } from '../types'
import { validateDenseVector } from '../validation'
type Filter = NonNullable<Parameters<QdrantClient['search']>[1]['filter']>
export class QdrantVectorStore implements VectorStoreService {
    private readonly client: QdrantClient
    private readonly collectionName: string
    constructor(config?: Partial<VectorStoreConfig>) {
        this.client = new QdrantClient({ url: config?.url ?? DEFAULT_VECTOR_STORE_CONFIG.url, timeout: 30000 })
        this.collectionName = config?.collectionName ?? DEFAULT_VECTOR_STORE_CONFIG.collectionName
    }
    private schema(info: Awaited<ReturnType<QdrantClient['getCollection']>>, dimensions?: number): number {
        const vectors = info.config.params.vectors
        const dense = vectors && typeof vectors === 'object' && DENSE_VECTOR_NAME in vectors ? vectors[DENSE_VECTOR_NAME] : undefined
        if (!dense || typeof dense !== 'object' || !('size' in dense) || !('distance' in dense) || dense.distance !== 'Cosine')
            throw new Error('Collection requires named dense Cosine vector')
        if (dimensions !== undefined && dense.size !== dimensions) throw new Error('Collection vector dimension mismatch')
        if (info.config.params.sparse_vectors?.[BM25_VECTOR_NAME]?.modifier !== 'idf')
            throw new Error('Collection requires bm25 sparse vector with IDF')
        return dense.size as number
    }
    async ensureCollection(dimensions: number): Promise<void> {
        if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error('Invalid vector dimensions')
        if (!(await this.client.collectionExists(this.collectionName)).exists) {
            try {
                await this.client.createCollection(this.collectionName, {
                    vectors: { [DENSE_VECTOR_NAME]: { size: dimensions, distance: 'Cosine' } },
                    sparse_vectors: { [BM25_VECTOR_NAME]: { modifier: 'idf' } },
                })
            } catch (error) {
                if (!(await this.client.collectionExists(this.collectionName)).exists) throw error
            }
        }
        const info = await this.client.getCollection(this.collectionName)
        this.schema(info, dimensions)
        for (const field of ['knowledgeBaseId', 'documentId', 'indexId', 'documentIndexId']) {
            if (info.payload_schema?.[field] && info.payload_schema[field]?.data_type !== 'keyword')
                throw new Error('Payload index must be keyword: ' + field)
            if (!info.payload_schema?.[field]) {
                try {
                    await this.client.createPayloadIndex(this.collectionName, { field_name: field, field_schema: 'keyword', wait: true })
                } catch (error) {
                    if ((await this.client.getCollection(this.collectionName)).payload_schema?.[field]?.data_type !== 'keyword') throw error
                }
            }
        }
    }
    private filter(ids: string[], scopes?: IndexScope[]): Filter {
        if (
            !ids.length ||
            !scopes?.length ||
            scopes.some(s => !s.indexId || !ids.includes(s.knowledgeBaseId)) ||
            ids.some(id => !scopes.some(s => s.knowledgeBaseId === id))
        )
            throw new Error('Authorized knowledge base and active index scopes are required')
        return {
            should: scopes.map(s => ({
                must: [
                    { key: 'knowledgeBaseId', match: { value: s.knowledgeBaseId } },
                    { key: 'indexId', match: { value: s.indexId } },
                ],
            })),
        }
    }
    async upsertVectors(chunks: ChunkWithVector[]): Promise<void> {
        if (!chunks.length) return
        const dimensions = this.schema(await this.client.getCollection(this.collectionName))
        const points = await Promise.all(
            chunks.map(async c => {
                validateDenseVector(c.vector, dimensions)
                if (!c.indexId || !c.documentIndexId) throw new Error('Index identity is required when writing chunks')
                const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(c.indexId + ':' + c.id)))
                const hex = [...hash.slice(0, 16)].map(v => v.toString(16).padStart(2, '0')).join('')
                return {
                    id: hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20),
                    vector: { [DENSE_VECTOR_NAME]: c.vector, [BM25_VECTOR_NAME]: bm25Document(c.content) },
                    payload: {
                        chunkId: c.id,
                        content: c.content,
                        chunkIndex: c.index,
                        startOffset: c.startOffset,
                        endOffset: c.endOffset,
                        documentId: c.documentId,
                        knowledgeBaseId: c.knowledgeBaseId,
                        indexId: c.indexId,
                        documentIndexId: c.documentIndexId,
                        metadata: c.metadata ?? {},
                    },
                }
            })
        )
        for (let i = 0; i < points.length; i += 100)
            await this.client.upsert(this.collectionName, { points: points.slice(i, i + 100), wait: true })
    }
    async deleteByDocumentId(documentId: string): Promise<void> {
        await this.client.delete(this.collectionName, {
            filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
            wait: true,
        })
    }
    async deleteByKnowledgeBaseId(knowledgeBaseId: string): Promise<void> {
        await this.client.delete(this.collectionName, {
            filter: { must: [{ key: 'knowledgeBaseId', match: { value: knowledgeBaseId } }] },
            wait: true,
        })
    }
    async deleteByDocumentIndexId(id: string): Promise<void> {
        await this.client.delete(this.collectionName, { filter: { must: [{ key: 'documentIndexId', match: { value: id } }] }, wait: true })
    }
    async deleteByIndexId(indexId: string): Promise<void> {
        await this.client.delete(this.collectionName, { filter: { must: [{ key: 'indexId', match: { value: indexId } }] }, wait: true })
    }
    private result(point: { payload?: Record<string, unknown> | null; score: number }, scoreType: 'cosine' | 'bm25'): VectorSearchResult {
        const p = point.payload ?? {}
        return {
            chunkId: String(p.chunkId ?? ''),
            content: String(p.content ?? ''),
            chunkIndex: Number(p.chunkIndex ?? 0),
            documentId: String(p.documentId ?? ''),
            knowledgeBaseId: String(p.knowledgeBaseId ?? ''),
            indexId: String(p.indexId ?? ''),
            documentIndexId: String(p.documentIndexId ?? ''),
            score: point.score,
            scoreType,
            metadata: p.metadata as Record<string, unknown> | undefined,
        }
    }
    async search(options: VectorSearchOptions): Promise<VectorSearchResult[]> {
        const filter = this.filter(options.knowledgeBaseIds, options.indexScopes)
        validateDenseVector(options.vector, this.schema(await this.client.getCollection(this.collectionName)))
        const response = await this.client.query(this.collectionName, {
            query: options.vector,
            using: DENSE_VECTOR_NAME,
            filter,
            limit: options.topK,
            score_threshold: options.threshold ?? 0,
            with_payload: true,
            with_vector: false,
        })
        return response.points.map(p => this.result(p, 'cosine'))
    }
    async textSearch(options: BM25SearchOptions): Promise<VectorSearchResult[]> {
        if (!options.query.trim()) throw new Error('Query cannot be empty')
        const filter = this.filter(options.knowledgeBaseIds, options.indexScopes)
        this.schema(await this.client.getCollection(this.collectionName))
        const response = await this.client.query(this.collectionName, {
            query: bm25Document(options.query.trim()),
            using: BM25_VECTOR_NAME,
            filter,
            limit: options.topK,
            with_payload: true,
            with_vector: false,
        })
        return response.points.map(p => this.result(p, 'bm25'))
    }
    async getCollectionInfo(): Promise<{ pointsCount: number; status: string } | null> {
        try {
            const info = await this.client.getCollection(this.collectionName)
            return { pointsCount: info.points_count ?? 0, status: info.status }
        } catch {
            return null
        }
    }
    async healthCheck(): Promise<boolean> {
        try {
            await this.client.getCollections()
            return true
        } catch {
            return false
        }
    }
}
export function createQdrantVectorStore(config?: Partial<VectorStoreConfig>): QdrantVectorStore {
    return new QdrantVectorStore(config)
}
