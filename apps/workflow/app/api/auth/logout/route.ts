/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { apiSuccess, handleApiError } from '@/lib/api-response'
import { clearAuthCookie } from '@/lib/auth'

export async function POST() {
    try {
        await clearAuthCookie()

        return apiSuccess({ message: '已成功登出' })
    } catch (error) {
        return handleApiError(error)
    }
}
