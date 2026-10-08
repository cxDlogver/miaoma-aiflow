/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { GlobalHeader } from '@/components/global-header'

export default function KnowledgeLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="h-screen flex flex-col">
            {/* 全局顶部导航 */}
            <GlobalHeader />

            {/* 主内容区 */}
            <div className="flex-1 flex overflow-hidden">
                {/* 内容区 */}
                <main className="flex-1 flex flex-col overflow-hidden bg-[#f4f6fb]">{children}</main>
            </div>
        </div>
    )
}
