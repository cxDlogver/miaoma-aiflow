/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { createHash } from 'node:crypto'

import { BM25_CONFIG_ID, createOllamaEmbeddingService, createQdrantVectorStore, getOllamaModelRevision } from '@miaoma-aiflow/ai-engine'

import { BusinessError, ErrorCode } from '@/lib/api-response'
import { prisma } from '@/lib/prisma'

export async function ensureEmbeddingSpace(config: { embeddingProvider?: string; embeddingModel: string; dimensions: number }) {
    if ((config.embeddingProvider ?? 'ollama') !== 'ollama')
        throw new BusinessError(ErrorCode.VALIDATION_ERROR, '目前仅支持 Ollama Embedding')
    const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
    let modelRevision: string
    try {
        modelRevision = await getOllamaModelRevision(config.embeddingModel, baseUrl)
        const service = createOllamaEmbeddingService({
            model: config.embeddingModel,
            dimensions: config.dimensions,
            modelRevision,
            baseUrl,
        })
        await service.embedText('知识库索引维度校验 / embedding dimension probe')
    } catch {
        throw new BusinessError(ErrorCode.INVALID_OPERATION, 'Embedding 模型校验失败，请确认服务可用、模型已安装且维度正确')
    }
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
    const id = createHash('sha256').update(JSON.stringify(protocol)).digest('hex')
    const collectionName = 'knowledge_v2_' + id
    await createQdrantVectorStore({ url: process.env.QDRANT_URL ?? 'http://localhost:6333', collectionName }).ensureCollection(
        config.dimensions
    )
    return prisma.embeddingSpace.upsert({ where: { id }, create: { id, collectionName, ...protocol }, update: {} })
}
