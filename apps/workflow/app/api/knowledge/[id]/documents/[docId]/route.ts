/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { NextRequest } from 'next/server'

import { apiError, apiSuccess, ErrorCode, handleApiError } from '@/lib/api-response'
import { getCurrentUserId } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { scheduleDocumentDeletion } from '@/lib/services/knowledge-index-service'

/**
 * GET /api/knowledge/[id]/documents/[docId] - 获取文档详情
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; docId: string }> }) {
    try {
        const userId = await getCurrentUserId()
        if (!userId) {
            return apiError(ErrorCode.UNAUTHORIZED)
        }

        const { id: knowledgeBaseId, docId } = await params

        // 检查知识库是否存在且属于当前用户
        const knowledgeBase = await prisma.knowledgeBase.findFirst({
            where: { id: knowledgeBaseId, deletedAt: null },
        })

        if (!knowledgeBase) {
            return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND)
        }

        if (knowledgeBase.userId !== userId) {
            return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, '无权访问此知识库')
        }

        // 获取文档
        const document = await prisma.document.findFirst({
            where: {
                id: docId,
                deletedAt: null,
                knowledgeBaseId,
            },
        })

        if (!document) {
            return apiError(ErrorCode.DOCUMENT_NOT_FOUND)
        }

        return apiSuccess({
            id: document.id,
            name: document.name,
            originalName: document.originalName,
            mimeType: document.mimeType,
            size: document.size,
            content: document.content,
            status: document.status,
            errorMessage: document.errorMessage,
            chunkCount: document.chunkCount,
            processedAt: document.processedAt?.toISOString() || null,
            createdAt: document.createdAt.toISOString(),
            updatedAt: document.updatedAt.toISOString(),
        })
    } catch (error) {
        return handleApiError(error)
    }
}

/**
 * DELETE /api/knowledge/[id]/documents/[docId] - 删除文档
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; docId: string }> }) {
    try {
        const userId = await getCurrentUserId()
        if (!userId) {
            return apiError(ErrorCode.UNAUTHORIZED)
        }

        const { id: knowledgeBaseId, docId } = await params

        // 检查知识库是否存在且属于当前用户
        const knowledgeBase = await prisma.knowledgeBase.findFirst({
            where: { id: knowledgeBaseId, deletedAt: null },
        })

        if (!knowledgeBase) {
            return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND)
        }

        if (knowledgeBase.userId !== userId) {
            return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND, '无权访问此知识库')
        }

        // 检查文档是否存在
        const document = await prisma.document.findFirst({
            where: {
                id: docId,
                deletedAt: null,
                knowledgeBaseId,
            },
        })

        if (!document) {
            return apiError(ErrorCode.DOCUMENT_NOT_FOUND)
        }

        const deleted = await scheduleDocumentDeletion(knowledgeBaseId, docId, userId)
        return apiSuccess(deleted, '文档已删除，向量清理已排队')
    } catch (error) {
        return handleApiError(error)
    }
}
