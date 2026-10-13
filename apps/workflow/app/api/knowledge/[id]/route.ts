/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */
import { NextRequest } from 'next/server'
import { z } from 'zod'

import { apiError, apiSuccess, ErrorCode, handleApiError } from '@/lib/api-response'
import { getCurrentUserId } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { rebuildKnowledgeBase, scheduleKnowledgeDeletion } from '@/lib/services/knowledge-index-service'

/**
 * GET /api/knowledge/[id] - 获取知识库详情
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const userId = await getCurrentUserId()
        if (!userId) {
            return apiError(ErrorCode.UNAUTHORIZED)
        }

        const { id } = await params

        const knowledgeBase = await prisma.knowledgeBase.findFirst({
            where: { id, deletedAt: null },
        })

        if (!knowledgeBase) {
            return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND)
        }

        // 检查权限
        if (knowledgeBase.userId !== userId) {
            return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, '无权访问此知识库')
        }

        return apiSuccess({
            id: knowledgeBase.id,
            name: knowledgeBase.name,
            description: knowledgeBase.description,
            icon: knowledgeBase.icon,
            // 嵌入配置
            embeddingModel: knowledgeBase.embeddingModel,
            embeddingProvider: knowledgeBase.embeddingProvider,
            dimensions: knowledgeBase.dimensions,
            // 切分配置
            chunkSize: knowledgeBase.chunkSize,
            chunkOverlap: knowledgeBase.chunkOverlap,
            // 检索配置
            retrievalMode: knowledgeBase.retrievalMode,
            vectorWeight: knowledgeBase.vectorWeight,
            topK: knowledgeBase.topK,
            threshold: knowledgeBase.threshold,
            // 统计
            documentCount: knowledgeBase.documentCount,
            chunkCount: knowledgeBase.chunkCount,
            status: knowledgeBase.status,
            // 时间
            createdAt: knowledgeBase.createdAt.toISOString(),
            updatedAt: knowledgeBase.updatedAt.toISOString(),
        })
    } catch (error) {
        return handleApiError(error)
    }
}

/**
 * PUT /api/knowledge/[id] - 更新知识库
 */
const updateKnowledgeBaseSchema = z.object({
    name: z.string().min(1).max(50).optional(),
    description: z.string().max(200).optional(),
    icon: z.string().optional(),
    embeddingProvider: z.literal('ollama').optional(),
    embeddingModel: z.string().min(1).max(120).optional(),
    dimensions: z.number().int().min(1).max(32768).optional(),
    // 切分配置
    chunkSize: z.number().min(100).max(2000).optional(),
    chunkOverlap: z.number().min(0).max(500).optional(),
    // 检索配置
    retrievalMode: z.enum(['VECTOR', 'FULLTEXT', 'HYBRID']).optional(),
    vectorWeight: z.number().min(0).max(1).optional(),
    topK: z.number().min(1).max(20).optional(),
    threshold: z.number().min(0).max(1).optional(),
})

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const userId = await getCurrentUserId()
        if (!userId) {
            return apiError(ErrorCode.UNAUTHORIZED)
        }

        const { id } = await params
        const body = await request.json()
        const result = updateKnowledgeBaseSchema.safeParse(body)

        if (!result.success) {
            return apiError(ErrorCode.VALIDATION_ERROR, result.error.issues[0]?.message)
        }

        // 检查知识库是否存在且属于当前用户
        const existingKb = await prisma.knowledgeBase.findFirst({
            where: { id, deletedAt: null },
        })

        if (!existingKb) {
            return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND)
        }

        if (existingKb.userId !== userId) {
            return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, '无权修改此知识库')
        }

        const indexFields = ['embeddingModel', 'embeddingProvider', 'dimensions', 'chunkSize', 'chunkOverlap'] as const
        if (indexFields.some(field => result.data[field] !== undefined && result.data[field] !== existingKb[field])) {
            const kb = await rebuildKnowledgeBase(id, userId, result.data)
            return apiSuccess(kb, '配置已更新，索引正在重建')
        }

        // 构建更新数据
        const updateData: Record<string, unknown> = {}

        if (result.data.name !== undefined) updateData.name = result.data.name
        if (result.data.description !== undefined) {
            updateData.description = result.data.description || null
        }
        if (result.data.icon !== undefined) updateData.icon = result.data.icon
        if (result.data.chunkSize !== undefined) updateData.chunkSize = result.data.chunkSize
        if (result.data.chunkOverlap !== undefined) updateData.chunkOverlap = result.data.chunkOverlap
        if (result.data.retrievalMode !== undefined) updateData.retrievalMode = result.data.retrievalMode
        if (result.data.vectorWeight !== undefined) updateData.vectorWeight = result.data.vectorWeight
        if (result.data.topK !== undefined) updateData.topK = result.data.topK
        if (result.data.threshold !== undefined) updateData.threshold = result.data.threshold

        // 更新知识库
        const knowledgeBase = await prisma.knowledgeBase.update({
            where: { id, deletedAt: null },
            data: updateData,
        })

        return apiSuccess(
            {
                id: knowledgeBase.id,
                name: knowledgeBase.name,
                description: knowledgeBase.description,
                icon: knowledgeBase.icon,
                embeddingModel: knowledgeBase.embeddingModel,
                embeddingProvider: knowledgeBase.embeddingProvider,
                dimensions: knowledgeBase.dimensions,
                retrievalMode: knowledgeBase.retrievalMode,
                vectorWeight: knowledgeBase.vectorWeight,
                topK: knowledgeBase.topK,
                threshold: knowledgeBase.threshold,
                chunkSize: knowledgeBase.chunkSize,
                chunkOverlap: knowledgeBase.chunkOverlap,
                documentCount: knowledgeBase.documentCount,
                chunkCount: knowledgeBase.chunkCount,
                status: knowledgeBase.status,
                updatedAt: knowledgeBase.updatedAt.toISOString(),
            },
            '知识库更新成功'
        )
    } catch (error) {
        return handleApiError(error)
    }
}

/**
 * DELETE /api/knowledge/[id] - 删除知识库
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const userId = await getCurrentUserId()
        if (!userId) {
            return apiError(ErrorCode.UNAUTHORIZED)
        }

        const { id } = await params

        // 检查知识库是否存在且属于当前用户
        const existingKb = await prisma.knowledgeBase.findFirst({
            where: { id, deletedAt: null },
        })

        if (!existingKb) {
            return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND)
        }

        if (existingKb.userId !== userId) {
            return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, '无权删除此知识库')
        }

        const deleted = await scheduleKnowledgeDeletion(id, userId)
        return apiSuccess(deleted, '知识库已删除，向量清理已排队')
    } catch (error) {
        return handleApiError(error)
    }
}
