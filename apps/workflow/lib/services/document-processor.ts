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

import type { Prisma } from '@/app/generated/prisma/client'
import { prisma } from '@/lib/prisma'

import { lockKnowledgeBase, refreshKnowledgeCounts } from './knowledge-index-service'

export async function maybeActivateIndex(tx: Prisma.TransactionClient, knowledgeBaseId: string) {
    const kb = await tx.knowledgeBase.findUnique({ where: { id: knowledgeBaseId }, include: { activeIndex: true } })
    if (!kb || kb.deletedAt || !kb.activeIndex) return
    const index = kb.activeIndex
    const count = await tx.document.count({ where: { knowledgeBaseId, deletedAt: null } })
    const ready = await tx.documentIndex.count({
        where: { knowledgeBaseIndexId: index.id, status: 'READY', document: { deletedAt: null } },
    })
    if (ready === count && (index.status === 'BUILDING' || index.status === 'FAILED')) {
        await tx.knowledgeBaseIndex.update({ where: { id: index.id }, data: { status: 'READY', activatedAt: new Date() } })
        await tx.knowledgeBase.update({ where: { id: knowledgeBaseId }, data: { status: 'READY' } })
    } else if (index.status === 'READY') {
        const failed = await tx.document.count({ where: { knowledgeBaseId, deletedAt: null, status: 'ERROR' } })
        const pending = await tx.document.count({ where: { knowledgeBaseId, deletedAt: null, status: { in: ['PENDING', 'PROCESSING'] } } })
        await tx.knowledgeBase.update({
            where: { id: knowledgeBaseId },
            data: { status: failed ? 'ERROR' : pending ? 'INDEXING' : 'READY' },
        })
    }
}

/** 任务固定 DocumentIndex；重试与配置变更不会改写其他索引的 Point。 */
export async function processDocument(
    documentIndexId: string,
    assertLease: (tx?: Prisma.TransactionClient) => Promise<void> = async () => {}
) {
    const entry = await prisma.documentIndex.findUnique({
        where: { id: documentIndexId },
        include: {
            document: true,
            knowledgeBaseIndex: { include: { embeddingSpace: true, knowledgeBase: true } },
        },
    })
    if (!entry) return
    const { document, knowledgeBaseIndex: index } = entry
    const kb = index.knowledgeBase
    const space = index.embeddingSpace
    const store = createQdrantVectorStore({ url: process.env.QDRANT_URL ?? 'http://localhost:6333', collectionName: space.collectionName })
    if (document.deletedAt || kb.deletedAt || kb.activeIndexId !== index.id || index.status === 'RETIRED') {
        await store.deleteByDocumentIndexId(entry.id)
        return
    }
    await assertLease()
    await prisma.$transaction(async tx => {
        await lockKnowledgeBase(tx, kb.id)
        await assertLease(tx)
        const current = await tx.knowledgeBase.findUnique({ where: { id: kb.id } })
        if (!current || current.deletedAt || current.activeIndexId !== index.id) throw new Error('Index changed before processing')
        await tx.documentIndex.update({ where: { id: entry.id }, data: { status: 'RUNNING', errorMessage: null } })
        await tx.document.updateMany({ where: { id: document.id, deletedAt: null }, data: { status: 'PROCESSING', errorMessage: null } })
    })
    if (!document.content?.trim()) throw new Error('文档没有可重建的文本内容')
    const config = { chunkSize: index.chunkSize, chunkOverlap: index.chunkOverlap }
    const splitter = /\.(md|markdown)$/i.test(document.originalName) ? createMarkdownSplitter(config) : createTextSplitter(config)
    const chunks = splitter.split(document.content)
    if (!chunks.length) throw new Error('文档无法切分')
    const embedding = createOllamaEmbeddingService({
        model: space.model,
        modelRevision: space.modelRevision,
        dimensions: space.dimensions,
        baseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    })
    const vectors: number[][] = []
    for (let offset = 0; offset < chunks.length; offset += 16) {
        await assertLease()
        vectors.push(...(await embedding.embedTexts(chunks.slice(offset, offset + 16).map(c => c.content))))
    }
    if (vectors.length !== chunks.length) throw new Error('Embedding count mismatch')
    await assertLease()
    await store.ensureCollection(space.dimensions)
    await store.deleteByDocumentIndexId(entry.id)
    const points: ChunkWithVector[] = chunks.map((chunk, ordinal) => ({
        ...chunk,
        id: entry.id + '_' + ordinal,
        documentId: document.id,
        knowledgeBaseId: kb.id,
        indexId: index.id,
        documentIndexId: entry.id,
        vector: vectors[ordinal]!,
    }))
    await store.upsertVectors(points)
    await assertLease()
    let discarded = false
    await prisma.$transaction(async tx => {
        await lockKnowledgeBase(tx, kb.id)
        await assertLease(tx)
        const currentKb = await tx.knowledgeBase.findUnique({ where: { id: kb.id } })
        const currentDoc = await tx.document.findUnique({ where: { id: document.id } })
        if (!currentKb || currentKb.deletedAt || currentKb.activeIndexId !== index.id || !currentDoc || currentDoc.deletedAt) {
            discarded = true
            return
        }
        await tx.documentIndex.update({ where: { id: entry.id }, data: { status: 'READY', chunkCount: chunks.length, errorMessage: null } })
        await tx.document.update({
            where: { id: document.id },
            data: { status: 'COMPLETED', chunkCount: chunks.length, processedAt: new Date(), errorMessage: null },
        })
        await refreshKnowledgeCounts(tx, kb.id)
        await maybeActivateIndex(tx, kb.id)
    })
    if (discarded) await store.deleteByDocumentIndexId(entry.id)
}
