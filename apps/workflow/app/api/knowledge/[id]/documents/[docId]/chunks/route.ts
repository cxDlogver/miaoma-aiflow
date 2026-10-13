/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { QdrantClient } from '@qdrant/js-client-rest'
import { NextRequest } from 'next/server'

import { apiError, apiSuccess, ErrorCode, handleApiError } from '@/lib/api-response'
import { getCurrentUserId } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/knowledge/[id]/documents/[docId]/chunks - 获取文档切片列表
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
            include: { activeIndex: { include: { embeddingSpace: true } } },
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

        const index = knowledgeBase.activeIndex
        if (!index || index.status !== 'READY') return apiError(ErrorCode.VALIDATION_ERROR, '索引尚未就绪，请重建索引')
        const documentIndex = await prisma.documentIndex.findFirst({
            where: { documentId: docId, knowledgeBaseIndexId: index.id, status: 'READY' },
        })
        if (!documentIndex) return apiError(ErrorCode.VALIDATION_ERROR, '文档索引尚未完成')
        const cursor = request.nextUrl.searchParams.get('cursor')
        if (cursor && !/^[0-9a-f-]{36}$/i.test(cursor)) return apiError(ErrorCode.VALIDATION_ERROR, '分页游标无效')

        // 从 Qdrant 获取切片（包含向量）
        const client = new QdrantClient({
            url: process.env.QDRANT_URL || 'http://localhost:6333',
        })

        const response = await client.scroll(index.embeddingSpace.collectionName, {
            offset: cursor || undefined,
            filter: {
                must: [
                    { key: 'documentIndexId', match: { value: documentIndex.id } },
                    { key: 'indexId', match: { value: index.id } },
                    { key: 'knowledgeBaseId', match: { value: knowledgeBaseId } },
                ],
            },
            limit: 100,
            with_payload: true,
            with_vector: true, // 获取向量用于统计
        })

        // 格式化切片数据，包含 embedding 统计信息
        const chunks = response.points
            .map(point => {
                const vector = (point.vector && !Array.isArray(point.vector) ? point.vector.dense : point.vector) as number[] | undefined
                let embeddingStats = null

                if (vector && Array.isArray(vector)) {
                    // 计算向量统计信息
                    const sum = vector.reduce((a, b) => a + b, 0)
                    const mean = sum / vector.length
                    const squaredDiffs = vector.map(v => Math.pow(v - mean, 2))
                    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / vector.length
                    const std = Math.sqrt(variance)
                    const min = Math.min(...vector)
                    const max = Math.max(...vector)
                    const norm = Math.sqrt(vector.reduce((a, b) => a + b * b, 0))

                    embeddingStats = {
                        dimensions: vector.length,
                        mean: Number(mean.toFixed(6)),
                        std: Number(std.toFixed(6)),
                        min: Number(min.toFixed(6)),
                        max: Number(max.toFixed(6)),
                        norm: Number(norm.toFixed(6)),
                        // 只返回前 10 个维度作为预览
                        preview: vector.slice(0, 10).map(v => Number(v.toFixed(4))),
                    }
                }

                return {
                    chunkId: point.payload?.chunkId as string,
                    content: point.payload?.content as string,
                    chunkIndex: point.payload?.chunkIndex as number,
                    startOffset: point.payload?.startOffset as number,
                    endOffset: point.payload?.endOffset as number,
                    charCount: ((point.payload?.content as string) || '').length,
                    wordCount: ((point.payload?.content as string) || '').split(/\s+/).filter(Boolean).length,
                    embeddingStats,
                }
            })
            .sort((a, b) => a.chunkIndex - b.chunkIndex)

        return apiSuccess({
            documentId: docId,
            documentName: document.name,
            total: documentIndex.chunkCount,
            nextCursor: response.next_page_offset == null ? null : String(response.next_page_offset),
            // 文档级别的统计
            documentStats: {
                totalChars: chunks.reduce((sum, c) => sum + c.charCount, 0),
                totalWords: chunks.reduce((sum, c) => sum + c.wordCount, 0),
                embeddingModel: index.embeddingSpace.model,
                embeddingDimensions: index.embeddingSpace.dimensions,
            },
            chunks,
        })
    } catch (error) {
        return handleApiError(error)
    }
}
