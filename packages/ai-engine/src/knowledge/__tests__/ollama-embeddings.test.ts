/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { OllamaEmbeddingService } from '../embeddings/ollama-embeddings'
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
afterEach(() => vi.unstubAllGlobals())
describe('Ollama immutable encoding contract', () => {
    it('sends the same raw protocol for queries and documents, forbids truncation', async () => {
        const fetch = vi.fn().mockResolvedValue(response({ embeddings: [[1, 0]] }))
        vi.stubGlobal('fetch', fetch)
        const service = new OllamaEmbeddingService({ model: 'model', dimensions: 2 })
        expect(await service.embedText(' query ')).toEqual([1, 0])
        const options = fetch.mock.calls[0]![1] as RequestInit
        expect(JSON.parse(options.body as string)).toEqual({ model: 'model', input: ['query'], truncate: false })
        expect(options.signal).toBeDefined()
    })
    it('does not drop an empty input and shift document chunk/vector alignment', async () => {
        const fetch = vi.fn()
        vi.stubGlobal('fetch', fetch)
        await expect(new OllamaEmbeddingService({ dimensions: 2 }).embedTexts(['one', ' '])).rejects.toThrow('empty')
        expect(fetch).not.toHaveBeenCalled()
    })
    it('rejects missing or truncated batches', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ embeddings: [[1, 0]] })))
        await expect(new OllamaEmbeddingService({ dimensions: 2 }).embedTexts(['one', 'two'])).rejects.toThrow('count')
    })
    it.each([[[1]], [[0, 0]], [[null, 1]]].map(v => [v]))('rejects invalid dense output %j', async vectors => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ embeddings: vectors })))
        await expect(new OllamaEmbeddingService({ dimensions: 2 }).embedText('one')).rejects.toThrow()
    })
    it('rejects model digest drift before encoding', async () => {
        const fetch = vi.fn().mockResolvedValue(response({ models: [{ name: 'm:latest', digest: 'new' }] }))
        vi.stubGlobal('fetch', fetch)
        await expect(new OllamaEmbeddingService({ model: 'm', dimensions: 2, modelRevision: 'old' }).embedText('one')).rejects.toThrow(
            'revision changed'
        )
        expect(fetch).toHaveBeenCalledTimes(1)
    })
    it('rejects drift while embedding is running', async () => {
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockResolvedValueOnce(response({ models: [{ name: 'm:latest', digest: 'old' }] }))
                .mockResolvedValueOnce(response({ embeddings: [[1, 0]] }))
                .mockResolvedValueOnce(response({ models: [{ name: 'm:latest', digest: 'new' }] }))
        )
        await expect(new OllamaEmbeddingService({ model: 'm', dimensions: 2, modelRevision: 'old' }).embedText('one')).rejects.toThrow(
            'revision changed'
        )
    })
})
