/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

/** Dense 向量在写入和查询时使用同一套校验。 */
export function validateDenseVector(vector: number[], dimensions: number): void {
    if (!Number.isInteger(dimensions) || dimensions < 1 || !Array.isArray(vector) || vector.length !== dimensions) {
        throw new Error(`Vector dimension mismatch: expected ${dimensions}, actual ${vector?.length ?? 0}`)
    }
    if (vector.some(value => !Number.isFinite(value)) || vector.every(value => value === 0)) {
        throw new Error('Dense vector must contain finite values and must not be all zero')
    }
}

export function validateRetrievalRequest(options: { query: string; knowledgeBaseIds: string[]; topK: number; threshold?: number }): void {
    if (typeof options.query !== 'string' || !options.query.trim()) throw new Error('Query cannot be empty')
    if (
        !Array.isArray(options.knowledgeBaseIds) ||
        !options.knowledgeBaseIds.length ||
        options.knowledgeBaseIds.some(id => typeof id !== 'string' || !id.trim())
    )
        throw new Error('Knowledge base IDs cannot be empty')
    if (!Number.isInteger(options.topK) || options.topK < 1 || options.topK > 100)
        throw new Error('Top K must be an integer between 1 and 100')
    if (options.threshold !== undefined && (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1)) {
        throw new Error('Dense threshold must be between 0 and 1')
    }
}
