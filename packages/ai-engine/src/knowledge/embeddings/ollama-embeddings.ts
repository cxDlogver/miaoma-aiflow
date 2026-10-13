/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import type { EmbeddingConfig, EmbeddingService } from '../types'
import { DEFAULT_EMBEDDING_CONFIG } from '../types'
import { validateDenseVector } from '../validation'
import { getOllamaModelRevision } from './model-revision'
/** Query/Document 使用相同 raw 协议；网络请求有超时且禁止静默截断正文。 */
export class OllamaEmbeddingService implements EmbeddingService {
    private readonly config: EmbeddingConfig
    constructor(config?: Partial<EmbeddingConfig>) {
        this.config = {
            model: config?.model ?? DEFAULT_EMBEDDING_CONFIG.model,
            baseUrl: config?.baseUrl ?? DEFAULT_EMBEDDING_CONFIG.baseUrl,
            dimensions: config?.dimensions ?? DEFAULT_EMBEDDING_CONFIG.dimensions,
            modelRevision: config?.modelRevision,
        }
    }
    private async assertRevision() {
        if (
            this.config.modelRevision &&
            (await getOllamaModelRevision(this.config.model, this.config.baseUrl)) !== this.config.modelRevision
        )
            throw new Error('Ollama model revision changed; rebuild the index')
    }
    async embedText(text: string): Promise<number[]> {
        return (await this.embedTexts([text]))[0]!
    }
    async embedTexts(texts: string[]): Promise<number[][]> {
        if (!texts.length) return []
        if (texts.some(t => typeof t !== 'string' || !t.trim())) throw new Error('Embedding batch contains empty text')
        await this.assertRevision()
        const response = await fetch(this.config.baseUrl.replace(/\/$/, '') + '/api/embed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(30000),
            body: JSON.stringify({ model: this.config.model, input: texts.map(t => t.trim()), truncate: false }),
        })
        if (!response.ok) throw new Error('Ollama embedding request failed: HTTP ' + response.status)
        const data = (await response.json()) as { embeddings?: number[][] }
        if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new Error('Embedding count mismatch')
        data.embeddings.forEach(vector => validateDenseVector(vector, this.config.dimensions))
        await this.assertRevision()
        return data.embeddings
    }
    getDimensions() {
        return this.config.dimensions
    }
    getModel() {
        return this.config.model
    }
    getBaseUrl() {
        return this.config.baseUrl
    }
}
export function createOllamaEmbeddingService(config?: Partial<EmbeddingConfig>): EmbeddingService {
    return new OllamaEmbeddingService(config)
}
