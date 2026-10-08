/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import type { ExecutionLogListResponse, ExecutionLogQuery } from '@/lib/types/execution'

/**
 * 执行日志服务
 */
export const executionService = {
    /**
     * 获取应用的执行日志列表
     */
    async getList(appId: string, query?: ExecutionLogQuery): Promise<ExecutionLogListResponse> {
        const params = new URLSearchParams()

        if (query?.page) {
            params.set('page', String(query.page))
        }
        if (query?.pageSize) {
            params.set('pageSize', String(query.pageSize))
        }
        if (query?.status && query.status !== 'all') {
            params.set('status', query.status)
        }
        if (query?.startDate) {
            params.set('startDate', query.startDate)
        }
        if (query?.endDate) {
            params.set('endDate', query.endDate)
        }
        if (query?.search) {
            params.set('search', query.search)
        }

        const queryString = params.toString()
        const url = `/api/apps/${appId}/executions${queryString ? `?${queryString}` : ''}`

        const response = await fetch(url)
        const result = await response.json()

        if (!response.ok) {
            throw new Error(result.message || '获取执行日志失败')
        }

        return result.data
    },
}
