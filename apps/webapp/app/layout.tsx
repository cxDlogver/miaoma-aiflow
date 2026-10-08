/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import './globals.css'

import type { Metadata } from 'next'
import { Toaster } from 'sonner'

export const metadata: Metadata = {
    title: '妙码 AI 应用 - WebApp | 妙码学院',
    description: '工作流演示应用',
}

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode
}>) {
    return (
        <html lang="zh-CN">
            <body className="min-h-screen antialiased">
                {children}
                <Toaster position="top-center" richColors />
            </body>
        </html>
    )
}
