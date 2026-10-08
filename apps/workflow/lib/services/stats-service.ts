/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import type { StatsQuery, StatsResponse } from '@/lib/types/stats'

// 获取应用统计数据
async function getStats(appId: string, query?: StatsQuery): Promise<StatsResponse> {
    const params = new URLSearchParams()

    if (query?.period) {
        params.set('period', query.period)
    }

    const url = `/api/apps/${appId}/stats${params.toString() ? `?${params.toString()}` : ''}`
    const response = await fetch(url)
    const result = await response.json()

    if (!response.ok || !result.success) {
        throw new Error(result.message || '获取统计数据失败')
    }

    return result.data
}

export const statsService = {
    getStats,
}
