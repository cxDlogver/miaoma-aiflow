/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { QdrantClient } from '@qdrant/js-client-rest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BM25_CONFIG_ID } from '../bm25'
import { HybridRetriever } from '../retriever/hybrid-retriever'
import { MultiKnowledgeRetriever } from '../retriever/multi-knowledge-retriever'
import { QdrantVectorStore } from '../store/qdrant-store'
import type { ChunkWithVector, KnowledgeIndexDescriptor } from '../types'

// 显式启用后，服务不可用必须失败；未启用时由 Vitest 报告 skipped。
const url = process.env.QDRANT_INTEGRATION_URL
describe.skipIf(!url)('native Qdrant 1.16.2 integration', () => {
    const prefix = 'rag_test_' + Date.now()
    const names = [prefix + '_1024', prefix + '_768', prefix + '_legacy']
    const client = new QdrantClient({ url: url ?? 'http://127.0.0.1:16333' })
    const dense = new QdrantVectorStore({ url, collectionName: names[0] })
    const small = new QdrantVectorStore({ url, collectionName: names[1] })
    const scope = [{ knowledgeBaseId: 'a', indexId: 'a-v2' }]
    const make = (id: string, content: string, kb = 'a', idx = kb + '-v2', dim = 1024): ChunkWithVector => ({
        id,
        content,
        index: 0,
        startOffset: 0,
        endOffset: content.length,
        knowledgeBaseId: kb,
        indexId: idx,
        documentId: kb + '-doc',
        documentIndexId: idx + '-di',
        vector: [1, ...Array(dim - 1).fill(0)],
    })
    beforeAll(async () => {
        expect((await (await fetch(url!)).json()).version).toBe('1.16.2')
        await dense.ensureCollection(1024)
        await small.ensureCollection(768)
        await dense.upsertVectors([
            ...Array.from({ length: 1001 }, (_, i) => make('filler-' + i, '普通背景文本 filler' + i)),
            { ...make('late', '量子纠缠 quantum E1042 C++ [a.*]'), vector: [0, 1, ...Array(1022).fill(0)] },
            make('same', '量子纠缠旧版本', 'a', 'a-v1'),
            make('same', '量子纠缠当前版本'),
            make('cross', '量子纠缠交叉配对泄露', 'a', 'b-v2'),
            make('cross', '量子纠缠交叉配对泄露', 'b', 'a-v2'),
            make('foreign', '量子纠缠未授权', 'secret'),
            make('b-current', '量子纠缠资料', 'b'),
        ])
        await small.upsertVectors([make('small', '量子纠缠 E1042', 'c', 'c-v2', 768)])
    }, 60000)
    afterAll(async () => {
        for (const name of names) if ((await client.collectionExists(name)).exists) await client.deleteCollection(name)
    })
    it('writes dense and native bm25 into the same point', async () => {
        const p = await client.scroll(names[0]!, {
            filter: { must: [{ key: 'chunkId', match: { value: 'late' } }] },
            limit: 1,
            with_vector: true,
            with_payload: true,
        })
        const vector = p.points[0]!.vector as Record<string, unknown>
        expect(vector.dense).toHaveLength(1024)
        expect(vector.bm25).toMatchObject({ indices: expect.any(Array), values: expect.any(Array) })
        expect(p.points[0]!.payload).toMatchObject({ indexId: 'a-v2', documentIndexId: 'a-v2-di' })
    })
    it('finds Chinese terms across more than 1000 chunks', async () => {
        const r = await dense.textSearch({ query: '量子纠缠', knowledgeBaseIds: ['a'], indexScopes: scope, topK: 10 })
        expect(r.map(r => r.chunkId)).toContain('late')
        expect(r.every(r => r.knowledgeBaseId === 'a' && r.indexId === 'a-v2')).toBe(true)
        expect(r[0]!.scoreType).toBe('bm25')
    })
    it.each(['E1042', 'quantum', 'C++', '[a.*]'])('handles mixed identifiers and punctuation: %s', async query => {
        const r = await dense.textSearch({ query, knowledgeBaseIds: ['a'], indexScopes: scope, topK: 5 })
        expect(r.map(r => r.chunkId)).toContain('late')
    })
    it('pairs each kb with its own active index rather than independent any filters', async () => {
        const r = await dense.textSearch({
            query: '量子纠缠',
            knowledgeBaseIds: ['a', 'b'],
            indexScopes: [...scope, { knowledgeBaseId: 'b', indexId: 'b-v2' }],
            topK: 20,
        })
        expect(r).toHaveLength(3)
        expect(r.map(r => r.chunkId)).not.toContain('cross')
        expect(r.map(r => r.chunkId)).not.toContain('foreign')
    })
    it('rebuilds in the same space without overwriting older index points', async () => {
        const r = await dense.textSearch({
            query: '量子纠缠',
            knowledgeBaseIds: ['a'],
            indexScopes: [{ knowledgeBaseId: 'a', indexId: 'a-v1' }],
            topK: 5,
        })
        expect(r[0]!.content).toBe('量子纠缠旧版本')
    })
    it('validates collection schema, dimensions and scopes', async () => {
        await expect(dense.ensureCollection(768)).rejects.toThrow('dimension')
        await expect(dense.search({ vector: [1, 0], knowledgeBaseIds: ['a'], indexScopes: scope, topK: 5 })).rejects.toThrow()
        await expect(dense.textSearch({ query: 'test', knowledgeBaseIds: ['a'], topK: 5 })).rejects.toThrow('scopes')
        await client.createCollection(names[2]!, { vectors: { size: 1024, distance: 'Cosine' } })
        await expect(new QdrantVectorStore({ url, collectionName: names[2] }).ensureCollection(1024)).rejects.toThrow('named dense')
    })
    it('returns both routes with raw provenance in hybrid mode', async () => {
        const hybrid = new HybridRetriever(
            { embedText: async () => [0, 1, ...Array(1022).fill(0)], embedTexts: async () => [], getDimensions: () => 1024 },
            dense,
            { search: o => dense.textSearch(o) }
        )
        const r = await hybrid.retrieve({
            query: 'quantum',
            knowledgeBaseIds: ['a'],
            indexScopes: scope,
            topK: 20,
            mode: 'hybrid',
            threshold: 0,
        })
        const match = r.find(r => r.chunkId === 'late')!
        expect(match.scoreType).toBe('rrf')
        expect(match.sources!.map(s => s.source)).toContain('bm25')
        expect(r.some(r => r.sources?.some(s => s.source === 'dense'))).toBe(true)
    })
    it('performs pure BM25 across 1024 and 768 spaces with a global topK', async () => {
        const ix = (kb: string, dim: number, name: string): KnowledgeIndexDescriptor => ({
            knowledgeBaseId: kb,
            indexId: kb + '-v2',
            dimensions: dim,
            embeddingSpaceId: name,
            collectionName: name,
            provider: 'ollama',
            model: 'synthetic-' + dim,
            modelRevision: 'test',
            bm25ConfigId: BM25_CONFIG_ID,
            queryEncodingVersion: 'ollama-raw-v1',
            documentEncodingVersion: 'ollama-raw-v1',
            status: 'READY',
        })
        const multi = new MultiKnowledgeRetriever({
            resolveIndexes: async () => [ix('a', 1024, names[0]!), ix('c', 768, names[1]!)],
            filterVisibleResults: async r => r,
            qdrantUrl: url,
            createEmbedding: () => {
                throw Error('Dense must never be instantiated')
            },
        })
        const r = await multi.retrieve({ query: 'E1042', knowledgeBaseIds: ['a', 'c'], mode: 'fulltext', topK: 2 })
        expect(r).toHaveLength(2)
        expect(new Set(r.map(r => r.knowledgeBaseId))).toEqual(new Set(['a', 'c']))
        expect(r.every(r => r.scoreType === 'rrf')).toBe(true)
    })
    it('deletes only the requested index/document/kb', async () => {
        await dense.deleteByIndexId('a-v1')
        expect(
            await dense.textSearch({
                query: '量子纠缠',
                knowledgeBaseIds: ['a'],
                indexScopes: [{ knowledgeBaseId: 'a', indexId: 'a-v1' }],
                topK: 5,
            })
        ).toHaveLength(0)
        expect(await dense.textSearch({ query: 'quantum', knowledgeBaseIds: ['a'], indexScopes: scope, topK: 5 })).toHaveLength(1)
        await small.deleteByDocumentIndexId('c-v2-di')
        expect((await small.getCollectionInfo())!.pointsCount).toBe(0)
        await dense.deleteByDocumentId('b-doc')
        expect(
            await dense.textSearch({
                query: '量子纠缠',
                knowledgeBaseIds: ['b'],
                indexScopes: [{ knowledgeBaseId: 'b', indexId: 'b-v2' }],
                topK: 5,
            })
        ).toHaveLength(0)
        await dense.deleteByKnowledgeBaseId('a')
        expect(await dense.textSearch({ query: 'quantum', knowledgeBaseIds: ['a'], indexScopes: scope, topK: 5 })).toHaveLength(0)
    })
})
