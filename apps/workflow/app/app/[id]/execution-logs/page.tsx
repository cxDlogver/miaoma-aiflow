/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */
'use client'

import { useParams } from 'next/navigation'

import { ExecutionLogList } from '@/components/execution-logs/execution-log-list'

export default function LogsPage() {
    const { id: appId } = useParams<{ id: string }>()

    return (
        <div className="flex-1 overflow-auto bg-white">
            <div className="mx-auto  p-6 pb-12">
                <ExecutionLogList appId={appId} />
            </div>
        </div>
    )
}
