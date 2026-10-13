/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import {
    collectPublishedKnowledgeBaseIds,
    type KnowledgeIndexDescriptor,
    type KnowledgeRetrievalService,
    MultiKnowledgeRetriever,
} from '@miaoma-aiflow/ai-engine'

import type { PrismaService } from '../../prisma/prisma.service'
type KnowledgeScope = { kind: 'user'; userId: string } | { kind: 'published'; appId: string; publishedAppId: string }

/** 只在服务端由认证后的入口调用；不接受节点 JSON 中的主体信息。 */
export function createKnowledgeRetrievalService(prisma: PrismaService, scope: KnowledgeScope): KnowledgeRetrievalService {
    return new MultiKnowledgeRetriever({
        qdrantUrl: process.env.QDRANT_URL ?? 'http://localhost:6333',
        ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
        async resolveIndexes(ids) {
            let ownerId: string
            if (scope.kind === 'user') {
                if (!scope.userId) throw new Error('Authenticated user is required')
                ownerId = scope.userId
            } else {
                const app = await prisma.app.findFirst({
                    where: { id: scope.appId, isDeleted: false, isPublished: true, activePublishedId: scope.publishedAppId },
                    include: { activePublished: true },
                })
                if (!app?.activePublished || app.activePublished.appId !== app.id) throw new Error('Published app is no longer active')
                const allowed = collectPublishedKnowledgeBaseIds(app.activePublished.nodes)
                if (ids.some(id => !allowed.includes(id))) throw new Error('Knowledge base is outside the published workflow scope')
                ownerId = app.userId
            }
            const bases = await prisma.knowledgeBase.findMany({
                where: { id: { in: ids }, userId: ownerId, deletedAt: null },
                include: { activeIndex: { include: { embeddingSpace: true } } },
            })
            if (bases.length !== ids.length) throw new Error('Knowledge base is unavailable or unauthorized')
            return bases.map((kb): KnowledgeIndexDescriptor => {
                const index = kb.activeIndex
                if (!index || index.knowledgeBaseId !== kb.id || index.status !== 'READY')
                    throw new Error('Knowledge base index requires rebuilding or is not ready')
                const space = index.embeddingSpace
                if (space.provider !== 'ollama') throw new Error('Unsupported embedding provider')
                return {
                    knowledgeBaseId: kb.id,
                    indexId: index.id,
                    embeddingSpaceId: space.id,
                    collectionName: space.collectionName,
                    provider: 'ollama',
                    model: space.model,
                    modelRevision: space.modelRevision,
                    dimensions: space.dimensions,
                    bm25ConfigId: space.bm25ConfigId,
                    queryEncodingVersion: space.queryEncodingVersion,
                    documentEncodingVersion: space.documentEncodingVersion,
                    status: 'READY',
                }
            })
        },
        async filterVisibleResults(results) {
            if (!results.length) return []
            const indexes = await prisma.documentIndex.findMany({
                where: {
                    id: { in: results.map(r => r.documentIndexId ?? '') },
                    status: 'READY',
                    document: { deletedAt: null, knowledgeBase: { deletedAt: null } },
                },
                select: { id: true, documentId: true, knowledgeBaseIndexId: true },
            })
            const keys = new Set(indexes.map(i => [i.id, i.documentId, i.knowledgeBaseIndexId].join(':')))
            return results.filter(r => keys.has([r.documentIndexId, r.documentId, r.indexId].join(':')))
        },
    })
}
