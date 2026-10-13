/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import type { BM25SearchOptions, EmbeddingService, RetrievalOptions, RetrievalResult, RetrieverService, VectorStoreService } from '../types'
import { validateDenseVector, validateRetrievalRequest } from '../validation'
import { fuseRankedLists } from './rank-fusion'
export interface FulltextSearchProvider {
    search(options: BM25SearchOptions): Promise<RetrievalResult[]>
}
export class HybridRetriever implements RetrieverService {
    constructor(
        private readonly embeddingService: EmbeddingService | undefined,
        private readonly vectorStore: VectorStoreService,
        private readonly fulltextProvider?: FulltextSearchProvider
    ) {}
    async retrieve(options: RetrievalOptions): Promise<RetrievalResult[]> {
        validateRetrievalRequest(options)
        const { query, knowledgeBaseIds, mode, topK, threshold = 0.5, vectorWeight = 0.7, indexScopes } = options
        if (!Number.isFinite(vectorWeight) || vectorWeight < 0 || vectorWeight > 1) throw new Error('Vector weight must be between 0 and 1')
        const dense = async (limit: number): Promise<RetrievalResult[]> => {
            if (!this.embeddingService) throw new Error('Dense embedding service is not configured')
            const vector = await this.embeddingService.embedText(query.trim())
            validateDenseVector(vector, this.embeddingService.getDimensions())
            return this.vectorStore.search({ vector, knowledgeBaseIds, topK: limit, threshold, indexScopes })
        }
        const bm25 = async (limit: number): Promise<RetrievalResult[]> => {
            if (!this.fulltextProvider) throw new Error('BM25 search provider is not configured')
            return this.fulltextProvider.search({ query: query.trim(), knowledgeBaseIds, topK: limit, indexScopes })
        }
        switch (mode) {
            case 'vector':
                return dense(topK)
            case 'fulltext':
                return bm25(topK)
            case 'hybrid': {
                const limit = Math.min(100, Math.ceil(topK * 1.5))
                const [vectorResults, textResults] = await Promise.all([dense(limit), bm25(limit)])
                return fuseRankedLists([
                    { results: vectorResults, weight: vectorWeight, source: 'dense' },
                    { results: textResults, weight: 1 - vectorWeight, source: 'bm25' },
                ]).slice(0, topK)
            }
            default:
                throw new Error('Unsupported retrieval mode: ' + mode)
        }
    }
}
export function createHybridRetriever(
    embeddingService: EmbeddingService | undefined,
    vectorStore: VectorStoreService,
    fulltextProvider?: FulltextSearchProvider
): RetrieverService {
    return new HybridRetriever(embeddingService, vectorStore, fulltextProvider)
}
