/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import type { Prisma } from '@/app/generated/prisma/client'
import { BusinessError, ErrorCode } from '@/lib/api-response'
import { prisma } from '@/lib/prisma'

import { ensureEmbeddingSpace } from './embedding-space-service'

export async function lockKnowledgeBase(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRawUnsafe('SELECT id FROM knowledge_bases WHERE id = $1 FOR UPDATE', id)
}
export async function refreshKnowledgeCounts(tx: Prisma.TransactionClient, id: string) {
    const stats = await tx.document.aggregate({
        where: { knowledgeBaseId: id, deletedAt: null },
        _sum: { chunkCount: true },
        _count: { _all: true },
    })
    await tx.knowledgeBase.update({ where: { id }, data: { documentCount: stats._count._all, chunkCount: stats._sum.chunkCount ?? 0 } })
}

export async function enqueueDocument(
    knowledgeBaseId: string,
    userId: string,
    file: { name: string; mimeType: string; size: number; content: string }
) {
    return prisma.$transaction(async tx => {
        await lockKnowledgeBase(tx, knowledgeBaseId)
        const kb = await tx.knowledgeBase.findFirst({
            where: { id: knowledgeBaseId, userId, deletedAt: null },
            include: { activeIndex: { include: { embeddingSpace: true } } },
        })
        if (!kb?.activeIndex || kb.activeIndex.status !== 'READY')
            throw new BusinessError(ErrorCode.INVALID_OPERATION, '知识库需要重建或正在重建，暂不能上传')
        const index = kb.activeIndex
        const document = await tx.document.create({
            data: {
                knowledgeBaseId,
                name: file.name.replace(/\.[^/.]+$/, ''),
                originalName: file.name,
                mimeType: file.mimeType,
                size: file.size,
                content: file.content,
                status: 'PENDING',
            },
        })
        const di = await tx.documentIndex.create({ data: { documentId: document.id, knowledgeBaseIndexId: index.id } })
        await tx.knowledgeIndexJob.create({
            data: {
                kind: 'PROCESS_DOCUMENT',
                knowledgeBaseId,
                documentId: document.id,
                indexId: index.id,
                payload: { documentIndexId: di.id, collectionName: index.embeddingSpace.collectionName },
            },
        })
        await refreshKnowledgeCounts(tx, knowledgeBaseId)
        await tx.knowledgeBase.update({ where: { id: knowledgeBaseId }, data: { status: 'INDEXING' } })
        return document
    })
}

interface RebuildConfig {
    embeddingModel?: string
    embeddingProvider?: string
    dimensions?: number
    chunkSize?: number
    chunkOverlap?: number
    name?: string
    description?: string
    icon?: string
    retrievalMode?: 'VECTOR' | 'FULLTEXT' | 'HYBRID'
    vectorWeight?: number
    topK?: number
    threshold?: number
}
export async function rebuildKnowledgeBase(id: string, userId: string, changes: RebuildConfig = {}) {
    const original = await prisma.knowledgeBase.findFirst({ where: { id, userId, deletedAt: null } })
    if (!original) throw new BusinessError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, '知识库不存在或无权访问')
    const target = {
        embeddingModel: changes.embeddingModel ?? original.embeddingModel,
        embeddingProvider: changes.embeddingProvider ?? original.embeddingProvider,
        dimensions: changes.dimensions ?? original.dimensions,
        chunkSize: changes.chunkSize ?? original.chunkSize,
        chunkOverlap: changes.chunkOverlap ?? original.chunkOverlap,
    }
    if (target.chunkOverlap >= target.chunkSize) throw new BusinessError(ErrorCode.VALIDATION_ERROR, '重叠长度必须小于切片长度')
    const space = await ensureEmbeddingSpace(target)
    return prisma.$transaction(
        async tx => {
            await lockKnowledgeBase(tx, id)
            const kb = await tx.knowledgeBase.findFirst({ where: { id, userId, deletedAt: null } })
            if (!kb || kb.updatedAt.getTime() !== original.updatedAt.getTime())
                throw new BusinessError(ErrorCode.INVALID_OPERATION, '知识库配置已变化，请重试重建')
            if (await tx.knowledgeIndexJob.count({ where: { knowledgeBaseId: id, status: 'RUNNING' } }))
                throw new BusinessError(ErrorCode.INVALID_OPERATION, '仍有任务执行中，请等待完成后重建')
            await tx.knowledgeIndexJob.updateMany({
                where: { knowledgeBaseId: id, kind: 'PROCESS_DOCUMENT', status: 'PENDING' },
                data: { status: 'CANCELLED' },
            })
            const oldIndexes = await tx.knowledgeBaseIndex.findMany({ where: { knowledgeBaseId: id }, include: { embeddingSpace: true } })
            await tx.knowledgeBaseIndex.updateMany({ where: { knowledgeBaseId: id }, data: { status: 'RETIRED' } })
            const documents = await tx.document.findMany({ where: { knowledgeBaseId: id, deletedAt: null }, select: { id: true } })
            const index = await tx.knowledgeBaseIndex.create({
                data: {
                    knowledgeBaseId: id,
                    embeddingSpaceId: space.id,
                    chunkSize: target.chunkSize,
                    chunkOverlap: target.chunkOverlap,
                    status: documents.length ? 'BUILDING' : 'READY',
                    activatedAt: documents.length ? null : new Date(),
                },
            })
            const entries = documents.length
                ? await tx.documentIndex.createManyAndReturn({
                      data: documents.map(d => ({ documentId: d.id, knowledgeBaseIndexId: index.id })),
                  })
                : []
            if (entries.length)
                await tx.knowledgeIndexJob.createMany({
                    data: entries.map(di => ({
                        kind: 'PROCESS_DOCUMENT' as const,
                        knowledgeBaseId: id,
                        documentId: di.documentId,
                        indexId: index.id,
                        payload: { documentIndexId: di.id, collectionName: space.collectionName },
                    })),
                })
            for (const old of oldIndexes)
                await tx.knowledgeIndexJob.create({
                    data: {
                        kind: 'DELETE_INDEX',
                        knowledgeBaseId: id,
                        indexId: old.id,
                        payload: { collectionName: old.embeddingSpace.collectionName },
                    },
                })
            await tx.document.updateMany({
                where: { knowledgeBaseId: id, deletedAt: null },
                data: { status: 'PENDING', chunkCount: 0, errorMessage: null, processedAt: null },
            })
            return tx.knowledgeBase.update({
                where: { id },
                data: {
                    ...changes,
                    ...target,
                    activeIndexId: index.id,
                    status: documents.length ? 'INDEXING' : 'READY',
                    chunkCount: 0,
                    documentCount: documents.length,
                },
            })
        },
        { timeout: 30000 }
    )
}

export async function scheduleDocumentDeletion(knowledgeBaseId: string, documentId: string, userId: string) {
    return prisma.$transaction(async tx => {
        await lockKnowledgeBase(tx, knowledgeBaseId)
        const kb = await tx.knowledgeBase.findFirst({
            where: { id: knowledgeBaseId, userId, deletedAt: null },
            include: { indexes: { include: { embeddingSpace: true } } },
        })
        if (!kb) throw new BusinessError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, '知识库不存在或无权访问')
        const document = await tx.document.findFirst({ where: { id: documentId, knowledgeBaseId, deletedAt: null } })
        if (!document) throw new BusinessError(ErrorCode.DOCUMENT_NOT_FOUND, '文档不存在')
        await tx.document.update({ where: { id: documentId }, data: { deletedAt: new Date() } })
        await tx.knowledgeIndexJob.updateMany({
            where: { documentId, kind: 'PROCESS_DOCUMENT', status: 'PENDING' },
            data: { status: 'CANCELLED' },
        })
        await tx.knowledgeIndexJob.create({
            data: {
                kind: 'DELETE_DOCUMENT',
                knowledgeBaseId,
                documentId,
                payload: { collections: [...new Set(kb.indexes.map(i => i.embeddingSpace.collectionName))] },
            },
        })
        await refreshKnowledgeCounts(tx, knowledgeBaseId)
        return { id: documentId, cleanupPending: true }
    })
}
export async function scheduleKnowledgeDeletion(id: string, userId: string) {
    return prisma.$transaction(async tx => {
        await lockKnowledgeBase(tx, id)
        const kb = await tx.knowledgeBase.findFirst({
            where: { id, userId, deletedAt: null },
            include: { indexes: { include: { embeddingSpace: true } } },
        })
        if (!kb) throw new BusinessError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, '知识库不存在或无权访问')
        await tx.knowledgeBase.update({ where: { id }, data: { deletedAt: new Date() } })
        await tx.knowledgeIndexJob.updateMany({
            where: { knowledgeBaseId: id, kind: 'PROCESS_DOCUMENT', status: 'PENDING' },
            data: { status: 'CANCELLED' },
        })
        await tx.knowledgeIndexJob.create({
            data: {
                kind: 'DELETE_KNOWLEDGE_BASE',
                knowledgeBaseId: id,
                payload: { collections: [...new Set(kb.indexes.map(i => i.embeddingSpace.collectionName))] },
            },
        })
        return { id, cleanupPending: true }
    })
}

/** 失败任务只重试仍有效的文档版本；清理任务不会改变活动索引状态。 */
export async function retryFailedKnowledgeJobs(id: string, userId: string) {
    return prisma.$transaction(async tx => {
        await lockKnowledgeBase(tx, id)
        const kb = await tx.knowledgeBase.findFirst({ where: { id, userId } })
        if (!kb) throw new BusinessError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, '知识库不存在或无权访问')
        const cleanup = await tx.knowledgeIndexJob.updateMany({
            where: { knowledgeBaseId: id, status: 'FAILED', kind: { not: 'PROCESS_DOCUMENT' } },
            data: { status: 'PENDING', attempts: 0, availableAt: new Date(), errorMessage: null },
        })
        let documents = 0
        if (kb.activeIndexId && !kb.deletedAt) {
            const pending = await tx.knowledgeIndexJob.findMany({
                where: { knowledgeBaseId: id, indexId: kb.activeIndexId, kind: 'PROCESS_DOCUMENT', status: 'FAILED' },
            })
            const visible = await tx.document.findMany({
                where: { id: { in: pending.flatMap(j => (j.documentId ? [j.documentId] : [])) }, deletedAt: null },
                select: { id: true },
            })
            const ids = new Set(visible.map(d => d.id))
            const retried = await tx.knowledgeIndexJob.updateMany({
                where: { id: { in: pending.filter(j => j.documentId && ids.has(j.documentId)).map(j => j.id) } },
                data: { status: 'PENDING', attempts: 0, availableAt: new Date(), errorMessage: null },
            })
            documents = retried.count
            if (documents) {
                await tx.knowledgeBaseIndex.updateMany({ where: { id: kb.activeIndexId, status: 'FAILED' }, data: { status: 'BUILDING' } })
                await tx.knowledgeBase.update({ where: { id }, data: { status: 'INDEXING' } })
            }
        }
        return cleanup.count + documents
    })
}
