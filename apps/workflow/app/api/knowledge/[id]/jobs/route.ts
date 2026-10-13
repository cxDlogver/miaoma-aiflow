/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { NextRequest } from 'next/server'

import { apiError, apiSuccess, ErrorCode, handleApiError } from '@/lib/api-response'
import { getCurrentUserId } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { retryFailedKnowledgeJobs } from '@/lib/services/knowledge-index-service'
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const userId = await getCurrentUserId()
        if (!userId) return apiError(ErrorCode.UNAUTHORIZED)
        const { id } = await params
        if (!(await prisma.knowledgeBase.findFirst({ where: { id, userId } }))) return apiError(ErrorCode.KNOWLEDGE_BASE_NOT_FOUND)
        const items = await prisma.knowledgeIndexJob.findMany({
            where: { knowledgeBaseId: id },
            orderBy: { createdAt: 'desc' },
            take: 100,
            select: { id: true, kind: true, status: true, attempts: true, errorMessage: true, availableAt: true, updatedAt: true },
        })
        return apiSuccess({ items })
    } catch (error) {
        return handleApiError(error)
    }
}
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const userId = await getCurrentUserId()
        if (!userId) return apiError(ErrorCode.UNAUTHORIZED)
        const { id } = await params
        const count = await retryFailedKnowledgeJobs(id, userId)
        return apiSuccess({ retried: count }, '失败任务已重新排队')
    } catch (error) {
        return handleApiError(error)
    }
}
