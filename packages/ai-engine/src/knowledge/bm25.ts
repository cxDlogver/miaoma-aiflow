/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

/** 此协议同时用于 Document 和 Query；改变参数必须重建索引。 */
export const BM25_CONFIG_ID = 'qdrant-bm25-multilingual-v1-k1.2-b0.75-avg256'
export const DENSE_VECTOR_NAME = 'dense'
export const BM25_VECTOR_NAME = 'bm25'
export const BM25_OPTIONS = {
    tokenizer: 'multilingual' as const,
    language: 'none',
    k: 1.2,
    b: 0.75,
    avg_len: 256,
}
export function bm25Document(text: string) {
    return { text, model: 'qdrant/bm25', options: { ...BM25_OPTIONS } }
}
