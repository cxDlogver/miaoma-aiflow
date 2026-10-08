/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { NextRequest } from 'next/server'

export async function GET() {
    return Response.json({
        message: '这是一个测试 API，请使用 POST 方法',
        status: 'ok',
    })
}

export async function POST(request: NextRequest) {
    const body = await request.json()

    // 模拟处理请求并返回结果
    return Response.json({
        success: true,
        message: `收到来自用户 ${body.user || 'Guest'} 的请求`,
        data: {
            user: body.user,
            question: body.question,
            count: body.count,
            processedAt: new Date().toISOString(),
            orderInfo: {
                orderId: '12345',
                status: '已发货',
                trackingNumber: 'SF1234567890',
                estimatedDelivery: '2025-12-25',
            },
        },
    })
}
