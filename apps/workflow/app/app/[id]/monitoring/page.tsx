/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */
'use client'

import { useParams } from 'next/navigation'

import { MonitoringDashboard } from '@/components/monitoring'

export default function MonitoringPage() {
    const { id: appId } = useParams<{ id: string }>()

    return (
        <div className="flex-1 overflow-auto">
            <div className="mx-auto space-y-12 py-6 px-12 pb-12">
                <MonitoringDashboard appId={appId} />
            </div>
        </div>
    )
}
