/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import {
    type ChunkWithVector,
    createMarkdownSplitter,
    createOllamaEmbeddingService,
    createQdrantVectorStore,
    createTextSplitter,
} from '@miaoma-aiflow/ai-engine'

import { prisma } from '@/lib/prisma'

interface ProcessDocumentParams {
    documentId: string
    knowledgeBaseId: string
    content: string
    fileName: string
    chunkSize: number
    chunkOverlap: number
    embeddingModel: string
    dimensions: number
}

/**
 * 处理文档：切分、嵌入、存储到 Qdrant
 */
export async function processDocument(params: ProcessDocumentParams): Promise<void> {
    const { documentId, knowledgeBaseId, content, fileName, chunkSize, chunkOverlap, embeddingModel, dimensions } = params

    try {
        // 更新状态为处理中
        await prisma.document.update({
            where: { id: documentId },
            data: { status: 'PROCESSING' },
        })

        // 1. 切分文档
        const isMarkdown = fileName.endsWith('.md') || fileName.endsWith('.markdown')
        const splitter = isMarkdown ? createMarkdownSplitter({ chunkSize, chunkOverlap }) : createTextSplitter({ chunkSize, chunkOverlap })

        const chunks = splitter.split(content)

        if (chunks.length === 0) {
            throw new Error('文档内容为空或无法切分')
        }

        // 2. 生成嵌入向量
        const embeddingService = createOllamaEmbeddingService({
            model: embeddingModel,
            dimensions,
        })

        const chunkTexts = chunks.map(c => c.content)
        const embeddings = await embeddingService.embedTexts(chunkTexts)

        // 入库前校验：Chunk 与 Embedding 必须一一对应，避免下标错配或无效向量入库。
        if (embeddings.length !== chunks.length) {
            throw new Error(`Embedding 数量不匹配：预期 ${chunks.length}，实际 ${embeddings.length}`)
        }

        embeddings.forEach((vector, index) => {
            if (!Array.isArray(vector) || vector.length !== dimensions) {
                throw new Error(`第 ${index} 个 Chunk 的向量维度无效：预期 ${dimensions}，实际 ${vector?.length ?? 0}`)
            }

            if (vector.some(value => !Number.isFinite(value))) {
                throw new Error(`第 ${index} 个 Chunk 的向量包含非有限数值`)
            }

            if (vector.every(value => value === 0)) {
                throw new Error(`第 ${index} 个 Chunk 的向量为全零向量，无法用于余弦相似度检索`)
            }
        })

        // 3. 存储到 Qdrant
        const vectorStore = createQdrantVectorStore({
            url: process.env.QDRANT_URL || 'http://localhost:6333',
            collectionName: 'knowledge_chunks',
        })

        // 确保 collection 存在
        await vectorStore.ensureCollection(dimensions)

        // 准备向量数据 - 使用正确的 ChunkWithVector 格式
        const vectorChunks: ChunkWithVector[] = chunks.map((chunk, idx) => ({
            id: `${documentId}_${idx}`,
            content: chunk.content,
            index: chunk.index,
            startOffset: chunk.startOffset,
            endOffset: chunk.endOffset,
            documentId,
            knowledgeBaseId,
            vector: embeddings[idx],
            metadata: chunk.metadata,
        }))

        // 存储向量
        await vectorStore.upsertVectors(vectorChunks)

        // 4. 更新文档状态
        await prisma.document.update({
            where: { id: documentId },
            data: {
                status: 'COMPLETED',
                chunkCount: chunks.length,
                processedAt: new Date(),
            },
        })

        // 5. 更新知识库切片计数
        await prisma.knowledgeBase.update({
            where: { id: knowledgeBaseId },
            data: {
                chunkCount: { increment: chunks.length },
            },
        })
    } catch (error) {
        // 更新状态为失败
        await prisma.document.update({
            where: { id: documentId },
            data: {
                status: 'ERROR',
                errorMessage: error instanceof Error ? error.message : '处理失败',
            },
        })
        throw error
    }
}

/**
 * 删除文档的向量数据
 */
export async function deleteDocumentVectors(documentId: string): Promise<void> {
    const vectorStore = createQdrantVectorStore({
        url: process.env.QDRANT_URL || 'http://localhost:6333',
        collectionName: 'knowledge_chunks',
    })

    await vectorStore.deleteByDocumentId(documentId)
}
