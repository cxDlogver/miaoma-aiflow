/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

export default function HomePage() {
    return (
        <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-purple-50 p-8">
            <div className="text-center">
                <div className="mx-auto mb-6 flex size-20 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-400 to-purple-500 text-4xl">
                    🤖
                </div>
                <h1 className="mb-2 text-2xl font-bold">MiaoMa AI Flow</h1>
                <p className="text-muted-foreground">
                    访问 <code className="rounded bg-muted px-2 py-1 text-sm">/workflow/[id]</code> 运行已发布的工作流
                </p>
            </div>
        </div>
    )
}
