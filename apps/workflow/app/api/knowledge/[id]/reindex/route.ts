/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'

import { apiError, apiSuccess, ErrorCode, handleApiError } from '@/lib/api-response'
import { getCurrentUserId } from '@/lib/auth'
import { rebuildKnowledgeBase } from '@/lib/services/knowledge-index-service'
const config = z.object({
    embeddingProvider: z.literal('ollama').optional(),
    embeddingModel: z.string().min(1).max(120).optional(),
    dimensions: z.number().int().min(1).max(32768).optional(),
    chunkSize: z.number().int().min(100).max(2000).optional(),
    chunkOverlap: z.number().int().min(0).max(500).optional(),
})
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const userId = await getCurrentUserId()
        if (!userId) return apiError(ErrorCode.UNAUTHORIZED)
        const { id } = await params
        const text = await request.text()
        let body: unknown = {}
        if (text.trim()) {
            try {
                body = JSON.parse(text)
            } catch {
                return apiError(ErrorCode.VALIDATION_ERROR, '请求正文必须是有效的 JSON')
            }
        }
        const parsed = config.safeParse(body)
        if (!parsed.success) return apiError(ErrorCode.VALIDATION_ERROR, parsed.error.issues[0]?.message)
        return apiSuccess(await rebuildKnowledgeBase(id, userId, parsed.data), '索引重建已排队')
    } catch (error) {
        return handleApiError(error)
    }
}
