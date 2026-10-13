/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */
'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'

import { type KnowledgeBaseDetail, knowledgeService } from '@/lib/services/knowledge-service'

interface KnowledgeContextType {
    knowledgeBase: KnowledgeBaseDetail | null
    setKnowledgeBase: (kb: KnowledgeBaseDetail | null) => void
    refreshKnowledgeBase: () => void
    isRefreshing: boolean
}

const KnowledgeContext = createContext<KnowledgeContextType | undefined>(undefined)

export function KnowledgeProvider({ children }: { children: React.ReactNode }) {
    const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeBaseDetail | null>(null)
    const [isRefreshing, setIsRefreshing] = useState(false)

    const refreshKnowledgeBase = useCallback(() => {
        setIsRefreshing(true)
        // isRefreshing will be set to false by the consumer after fetching
        setTimeout(() => setIsRefreshing(false), 100)
    }, [])

    useEffect(() => {
        const id = knowledgeBase?.id
        if (!id || !['INDEXING', 'ERROR'].includes(knowledgeBase.status)) return
        let cancelled = false
        const timer = setInterval(() => {
            void knowledgeService
                .getById(id)
                .then(updated => {
                    if (!cancelled)
                        setKnowledgeBase(current =>
                            current?.id === id
                                ? {
                                      ...current,
                                      status: updated.status,
                                      documentCount: updated.documentCount,
                                      chunkCount: updated.chunkCount,
                                      updatedAt: updated.updatedAt,
                                  }
                                : current
                        )
                })
                .catch(() => {})
        }, 5000)
        return () => {
            cancelled = true
            clearInterval(timer)
        }
    }, [knowledgeBase?.id, knowledgeBase?.status])

    return (
        <KnowledgeContext.Provider
            value={{
                knowledgeBase,
                setKnowledgeBase,
                refreshKnowledgeBase,
                isRefreshing,
            }}
        >
            {children}
        </KnowledgeContext.Provider>
    )
}

export function useKnowledge() {
    const context = useContext(KnowledgeContext)
    if (context === undefined) {
        throw new Error('useKnowledge must be used within a KnowledgeProvider')
    }
    return context
}
