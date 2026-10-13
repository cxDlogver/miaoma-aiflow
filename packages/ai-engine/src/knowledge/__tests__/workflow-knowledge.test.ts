/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { describe, expect, it, vi } from 'vitest'

import { createWorkflowEngine } from '../../core/engine'
import type { WorkflowDefinition } from '../../types'
import type { KnowledgeRetrievalService, RetrievalResult } from '../types'
const evidence: RetrievalResult = {
    chunkId: 'chunk',
    content: '中文证据',
    chunkIndex: 0,
    documentId: 'doc',
    knowledgeBaseId: 'a',
    indexId: 'idx',
    documentIndexId: 'di',
    embeddingSpaceId: 'space',
    score: 1 / 61,
    scoreType: 'rrf',
    metadata: { section: '标题' },
    sources: [{ source: 'bm25', score: 9, rank: 1, indexId: 'idx', embeddingSpaceId: 'space' }],
}
const workflow = (format: 'text' | 'json'): WorkflowDefinition => ({
    id: 'legacy-workflow',
    name: 'legacy knowledge config',
    nodes: [
        { id: 'start', type: 'start', data: { label: '开始', config: { inputs: [{ name: 'question', type: 'string', required: true }] } } },
        {
            id: 'kb',
            type: 'knowledge',
            data: {
                label: '知识库',
                config: {
                    knowledgeBaseIds: ['a'],
                    query: '${start.question}',
                    retrievalMode: 'hybrid',
                    topK: 5,
                    threshold: 0.2,
                    outputFormat: format,
                },
            },
        },
        {
            id: 'end',
            type: 'end',
            data: { label: '结束', config: { outputs: [{ name: 'answer', type: 'string', value: '${kb.output}' }] } },
        },
    ],
    edges: [
        { id: 'one', source: 'start', target: 'kb' },
        { id: 'two', source: 'kb', target: 'end' },
    ],
})
describe('workflow knowledge service injection', () => {
    it('executes existing JSON config and preserves evidence provenance', async () => {
        const retrieve = vi.fn().mockResolvedValue([evidence])
        const r = await createWorkflowEngine({ knowledgeRetrieval: { retrieve } }).execute(workflow('json'), { question: '问题' })
        expect(JSON.parse(r.outputs!.answer as string)).toEqual([evidence])
        expect(retrieve).toHaveBeenCalledWith({ query: '问题', knowledgeBaseIds: ['a'], mode: 'hybrid', topK: 5, threshold: 0.2 })
    })
    it('keeps the existing text output format', async () => {
        const service: KnowledgeRetrievalService = { retrieve: async () => [evidence] }
        const r = await createWorkflowEngine({ knowledgeRetrieval: service }).execute(workflow('text'), { question: '问题' })
        expect(r.outputs!.answer).toBe('[1] 中文证据')
    })
    it('fails explicitly when the entry point did not inject an authorized service', async () => {
        const r = await createWorkflowEngine().execute(workflow('text'), { question: '问题' })
        expect(JSON.stringify(r)).toContain('Authorized knowledge retrieval service is not configured')
    })
    it('does not pass caller-supplied owner fields to the trusted service', async () => {
        const retrieve = vi.fn().mockResolvedValue([evidence])
        await createWorkflowEngine({ knowledgeRetrieval: { retrieve } }).execute(workflow('text'), {
            question: '问题',
            userId: 'victim',
            ownerId: 'victim',
        })
        expect(retrieve.mock.calls[0]![0]).not.toHaveProperty('userId')
        expect(retrieve.mock.calls[0]![0]).not.toHaveProperty('ownerId')
    })
})
