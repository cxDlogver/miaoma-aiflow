/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */
import { redirect } from 'next/navigation'

interface PageProps {
    params: Promise<{ id: string }>
}

export default async function KnowledgePage({ params }: PageProps) {
    const { id } = await params
    redirect(`/knowledge/${id}/documents`)
}
