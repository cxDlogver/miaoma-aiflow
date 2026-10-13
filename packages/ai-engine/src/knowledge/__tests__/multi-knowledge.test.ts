/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { describe, expect, it, vi } from 'vitest'

import { BM25_CONFIG_ID } from '../bm25'
import { collectPublishedKnowledgeBaseIds } from '../published-knowledge'
import { HybridRetriever } from '../retriever/hybrid-retriever'
import { MultiKnowledgeRetriever } from '../retriever/multi-knowledge-retriever'
import { fuseRankedLists } from '../retriever/rank-fusion'
import type { EmbeddingService, KnowledgeIndexDescriptor, RetrievalOptions, RetrievalResult, VectorStoreService } from '../types'
import { validateDenseVector } from '../validation'

const index = (kb: string, space = 's1', dims = 1024): KnowledgeIndexDescriptor => ({
    knowledgeBaseId: kb,
    indexId: kb + '-v2',
    embeddingSpaceId: space,
    collectionName: space,
    provider: 'ollama',
    model: space,
    modelRevision: 'digest-' + space,
    dimensions: dims,
    bm25ConfigId: BM25_CONFIG_ID,
    queryEncodingVersion: 'ollama-raw-v1',
    documentEncodingVersion: 'ollama-raw-v1',
    status: 'READY',
})
const result = (kb = 'a', chunk = 'one', score = 0.9): RetrievalResult => ({
    knowledgeBaseId: kb,
    indexId: kb + '-v2',
    documentIndexId: kb + '-di',
    documentId: kb + '-doc',
    chunkId: chunk,
    chunkIndex: 0,
    content: chunk,
    score,
    scoreType: 'cosine',
})
const request: RetrievalOptions = { query: '中文 API E1042', knowledgeBaseIds: ['a'], mode: 'vector', topK: 3, threshold: 0 }
const embedding = (dims = 1024): EmbeddingService => ({
    embedText: vi.fn().mockResolvedValue(Array(dims).fill(0.1)),
    embedTexts: vi.fn(),
    getDimensions: () => dims,
})
const store = (results: RetrievalResult[] = []): VectorStoreService => ({
    ensureCollection: vi.fn(),
    upsertVectors: vi.fn(),
    deleteByDocumentId: vi.fn(),
    deleteByKnowledgeBaseId: vi.fn(),
    search: vi.fn().mockResolvedValue(results),
    textSearch: vi.fn().mockResolvedValue(results.map(r => ({ ...r, scoreType: 'bm25' }))),
})
const setup = (indexes = [index('a')]) => {
    const calls: Array<{ index: KnowledgeIndexDescriptor; embedding: EmbeddingService; store: VectorStoreService }> = []
    const resolveIndexes = vi.fn().mockResolvedValue(indexes)
    const createEmbedding = vi.fn((i: KnowledgeIndexDescriptor) => {
        const e = embedding(i.dimensions)
        calls.find(c => c.index === i)!.embedding = e
        return e
    })
    const retriever = new MultiKnowledgeRetriever({
        resolveIndexes,
        filterVisibleResults: async r => r,
        createEmbedding,
        createStore: i => {
            const s = store(indexes.filter(x => x.embeddingSpaceId === i.embeddingSpaceId).map(x => result(x.knowledgeBaseId)))
            calls.push({ index: i, store: s, embedding: undefined! })
            return s
        },
    })
    return { retriever, calls, resolveIndexes, createEmbedding }
}

describe('multi space routing and authorization', () => {
    it('embeds once for two knowledge bases in the same immutable space', async () => {
        const s = setup([index('a'), index('b')])
        const r = await s.retriever.retrieve({ ...request, knowledgeBaseIds: ['a', 'b', 'a'] })
        expect(s.createEmbedding).toHaveBeenCalledTimes(1)
        expect(s.calls[0]!.embedding.embedText).toHaveBeenCalledTimes(1)
        expect(s.calls[0]!.store.search).toHaveBeenCalledWith(
            expect.objectContaining({ indexScopes: [index('a'), index('b')], knowledgeBaseIds: ['a', 'b'] })
        )
        expect(r.map(r => r.knowledgeBaseId)).toEqual(['a', 'b'])
    })
    it.each([
        [1024, 768],
        [1024, 1024],
    ])('keeps distinct model spaces separate even at equal dimensions %s/%s', async (a, b) => {
        const s = setup([index('a', 's1', a), index('b', 's2', b)])
        const r = await s.retriever.retrieve({ ...request, knowledgeBaseIds: ['a', 'b'], topK: 1 })
        expect(s.createEmbedding).toHaveBeenCalledTimes(2)
        expect(s.calls.map(c => c.embedding.getDimensions())).toEqual([a, b])
        expect(r).toHaveLength(1)
        expect(r[0]!.scoreType).toBe('rrf')
        expect(r[0]!.sources?.[0]).toMatchObject({ source: 'dense', rank: 1, score: 0.9 })
    })
    it('pure BM25 never creates or calls a dense encoder', async () => {
        const s = setup([index('a'), index('b', 's2', 768)])
        expect(await s.retriever.retrieve({ ...request, mode: 'fulltext', knowledgeBaseIds: ['a', 'b'] })).toHaveLength(2)
        expect(s.createEmbedding).not.toHaveBeenCalled()
        expect(s.calls.every(c => vi.mocked(c.store.search).mock.calls.length === 0)).toBe(true)
    })
    it('fails authorization before any model or collection access', async () => {
        const s = setup([])
        await expect(s.retriever.retrieve(request)).rejects.toThrow('authorization')
        expect(s.calls).toHaveLength(0)
        expect(s.createEmbedding).not.toHaveBeenCalled()
    })
    it('rejects non-ready or conflicting protocols', async () => {
        const s = setup([{ ...index('a'), bm25ConfigId: 'old' }])
        await expect(s.retriever.retrieve(request)).rejects.toThrow('encoding')
        expect(s.calls).toHaveLength(0)
    })
    it('rejects same-space inconsistent models', async () => {
        const s = setup([index('a'), { ...index('b'), model: 'different' }])
        await expect(s.retriever.retrieve({ ...request, knowledgeBaseIds: ['a', 'b'] })).rejects.toThrow('conflicting')
        expect(s.calls).toHaveLength(0)
    })
    it('fails closed if active index changes during retrieval', async () => {
        const s = setup()
        s.resolveIndexes.mockResolvedValueOnce([index('a')]).mockResolvedValueOnce([{ ...index('a'), indexId: 'a-v3' }])
        await expect(s.retriever.retrieve(request)).rejects.toThrow('changed')
    })
    it('rejects storage candidates outside the authorized kb/index pairs', async () => {
        const r = new MultiKnowledgeRetriever({
            resolveIndexes: async () => [index('a')],
            filterVisibleResults: async r => r,
            createEmbedding: () => embedding(),
            createStore: () => store([result('other')]),
        })
        await expect(r.retrieve(request)).rejects.toThrow('unauthorized index candidate')
    })
    it('removes deleted document evidence before final topK', async () => {
        const r = new MultiKnowledgeRetriever({
            resolveIndexes: async () => [index('a')],
            filterVisibleResults: async r => r.filter(x => x.chunkId !== 'deleted'),
            createEmbedding: () => embedding(),
            createStore: () => store([result('a', 'deleted'), result('a', 'live')]),
        })
        expect((await r.retrieve({ ...request, topK: 1 }))[0]!.chunkId).toBe('live')
    })
    it('does not return partial results when one space fails', async () => {
        const r = new MultiKnowledgeRetriever({
            resolveIndexes: async () => [index('a'), index('b', 's2')],
            filterVisibleResults: async r => r,
            createEmbedding: () => embedding(),
            createStore: i =>
                i.embeddingSpaceId === 's1'
                    ? store([result('a')])
                    : { ...store(), search: vi.fn().mockRejectedValue(new Error('offline')) },
        })
        await expect(r.retrieve({ ...request, knowledgeBaseIds: ['a', 'b'] })).rejects.toThrow('offline')
    })
    it('bounds query duration', async () => {
        const r = new MultiKnowledgeRetriever({
            timeoutMs: 10,
            resolveIndexes: async () => [index('a')],
            filterVisibleResults: async r => r,
            createEmbedding: () => embedding(),
            createStore: () => ({ ...store(), search: () => new Promise(() => {}) }),
        })
        await expect(r.retrieve(request)).rejects.toThrow('timed out')
    })
    it('limits simultaneous space calls', async () => {
        let active = 0,
            max = 0
        const indexes = ['a', 'b', 'c', 'd'].map(k => index(k, k))
        const r = new MultiKnowledgeRetriever({
            concurrency: 2,
            resolveIndexes: async () => indexes,
            filterVisibleResults: async r => r,
            createEmbedding: () => embedding(),
            createStore: i => ({
                ...store(),
                search: async () => {
                    max = Math.max(max, ++active)
                    await new Promise(resolve => setTimeout(resolve, 10))
                    active--
                    return [result(i.knowledgeBaseId)]
                },
            }),
        })
        expect(await r.retrieve({ ...request, knowledgeBaseIds: ['a', 'b', 'c', 'd'] })).toHaveLength(3)
        expect(max).toBe(2)
    })
})
describe('hybrid and vector validation', () => {
    it.each([[], [0, 0], [NaN, 1], [Infinity, 1], [1]].map(v => [v]))('rejects invalid vector %j before querying storage', async v => {
        const e = embedding(2)
        vi.mocked(e.embedText).mockResolvedValue(v)
        const s = store()
        await expect(new HybridRetriever(e, s).retrieve(request)).rejects.toThrow()
        expect(s.search).not.toHaveBeenCalled()
    })
    it('never silently falls back when BM25 is missing', async () => {
        await expect(new HybridRetriever(embedding(), store()).retrieve({ ...request, mode: 'hybrid' })).rejects.toThrow('BM25')
    })
    it('retains RRF semantics when BM25 returns no matches', async () => {
        const r = await new HybridRetriever(embedding(), store([result()]), { search: async () => [] }).retrieve({
            ...request,
            mode: 'hybrid',
        })
        expect(r[0]!.scoreType).toBe('rrf')
        expect(r[0]!.score).toBeCloseTo(0.7 / 61)
        expect(r[0]!.sources).toMatchObject([{ source: 'dense', score: 0.9 }])
    })
    it('BM25 does not receive the dense threshold', async () => {
        const text = { search: vi.fn().mockResolvedValue([]) }
        await new HybridRetriever(undefined, store(), text).retrieve({ ...request, mode: 'fulltext', threshold: 0.9 })
        expect(text.search).toHaveBeenCalledWith(expect.not.objectContaining({ threshold: expect.anything() }))
    })
    it('validates finite nonzero dimensions without padding', () => {
        expect(() => validateDenseVector([1, 2], 3)).toThrow()
        expect(() => validateDenseVector([1, 2], 2)).not.toThrow()
    })
})
describe('RRF and publication snapshot', () => {
    it('uses rank rather than incompatible raw score scales and deduplicates evidence', () => {
        const lists = [
            { results: [result('a', 'x', 0.01), result('a', 'y', 0.001), result('a', 'x', 0.01)], weight: 1, source: 'dense' as const },
            { results: [result('b', 'z', 10000)], weight: 1, source: 'bm25' as const },
        ]
        const r = fuseRankedLists(lists)
        expect(r.map(r => r.chunkId)).toEqual(['x', 'z', 'y'])
        expect(r[0]!.score).toBeCloseTo(1 / 61)
        expect(r[1]!.sources?.[0]!.score).toBe(10000)
        expect(fuseRankedLists([...lists].reverse()).map(r => r.chunkId)).toEqual(['x', 'z', 'y'])
    })
    it('does not deduplicate different index generations', () => {
        expect(fuseRankedLists([{ results: [result(), { ...result(), indexId: 'a-v3' }], weight: 1, source: 'dense' }])).toHaveLength(2)
    })
    it('zero weight does not introduce unrelated candidates', () => {
        expect(fuseRankedLists([{ results: [result()], weight: 0, source: 'bm25' }])).toHaveLength(0)
    })
    it('extracts only statically declared ids from knowledge nodes', () => {
        expect(
            collectPublishedKnowledgeBaseIds([
                { type: 'knowledge', data: { config: { knowledgeBaseIds: ['a', 'b', 'a'] } } },
                { type: 'start', data: {} },
            ])
        ).toEqual(['a', 'b'])
    })
    it.each(['{{input.kb}}', '${input.kb}', '', null])('rejects dynamic or invalid published id %s', id => {
        expect(() => collectPublishedKnowledgeBaseIds([{ type: 'knowledge', data: { config: { knowledgeBaseIds: [id] } } }])).toThrow()
    })
})
