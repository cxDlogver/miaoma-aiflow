/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import './globals.css'

import type { Metadata } from 'next'

import { Toaster } from '@/components/ui/sonner'

export const metadata: Metadata = {
    title: '妙码 AI 引擎 | 妙码学院',
    description: '妙码 AI 引擎，基于 Next.js 构建的 AI 工作流引擎',
}

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode
}>) {
    return (
        <html lang="en">
            <body>
                {children}
                <Toaster richColors position="top-center" />
            </body>
        </html>
    )
}
