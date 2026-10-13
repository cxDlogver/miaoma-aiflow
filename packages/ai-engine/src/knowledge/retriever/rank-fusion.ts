/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import type { RetrievalOrigin, RetrievalResult } from '../types'

export function evidenceKey(result: RetrievalResult): string {
    return [result.knowledgeBaseId, result.indexId ?? '', result.documentId, result.chunkId].join(':')
}

/** 原始分数仅保留为来源，不用于比较不同召回路线/空间。 */
export function fuseRankedLists(
    lists: Array<{ results: RetrievalResult[]; weight: number; source: RetrievalOrigin['source']; embeddingSpaceId?: string }>
): RetrievalResult[] {
    const candidates = new Map<string, RetrievalResult>()
    for (const list of lists) {
        if (list.weight <= 0) continue
        const seen = new Set<string>()
        list.results.forEach((result, rank) => {
            const key = evidenceKey(result)
            if (seen.has(key)) return
            seen.add(key)
            const contribution = list.weight / (60 + rank + 1)
            const origin: RetrievalOrigin = {
                source: list.source,
                score: result.score,
                rank: rank + 1,
                indexId: result.indexId,
                embeddingSpaceId: list.embeddingSpaceId ?? result.embeddingSpaceId,
            }
            const previous = candidates.get(key)
            candidates.set(key, {
                ...result,
                score: (previous?.score ?? 0) + contribution,
                scoreType: 'rrf',
                sources: [...(previous?.sources ?? []), ...(result.sources ?? []), origin],
            })
        })
    }
    return [...candidates.values()].sort((a, b) => b.score - a.score || evidenceKey(a).localeCompare(evidenceKey(b)))
}
