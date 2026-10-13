/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import type { EmbeddingService, RetrievalOptions, RetrievalResult, RetrieverService, VectorStoreService } from '../types'
import { HybridRetriever } from './hybrid-retriever'
export class VectorRetriever implements RetrieverService {
    private readonly delegate: HybridRetriever
    constructor(embedding: EmbeddingService, store: VectorStoreService) {
        this.delegate = new HybridRetriever(embedding, store)
    }
    retrieve(options: RetrievalOptions): Promise<RetrievalResult[]> {
        return this.delegate.retrieve({ ...options, mode: 'vector' })
    }
}
export function createVectorRetriever(embedding: EmbeddingService, store: VectorStoreService): RetrieverService {
    return new VectorRetriever(embedding, store)
}
