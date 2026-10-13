/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

/** 发布只接受静态知识库 ID；拒绝通过 inputs 动态扩大公开范围。 */
export function collectPublishedKnowledgeBaseIds(nodes: unknown): string[] {
    if (!Array.isArray(nodes)) throw new Error('Published workflow nodes must be an array')
    const ids = new Set<string>()
    for (const raw of nodes) {
        if (!raw || typeof raw !== 'object') throw new Error('Invalid workflow node')
        const node = raw as Record<string, unknown>
        if (node.type !== 'knowledge') continue
        const data = node.data as Record<string, unknown> | undefined
        const config = data?.config as Record<string, unknown> | undefined
        const selected = config?.knowledgeBaseIds
        if (!Array.isArray(selected) || !selected.length || selected.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))) {
            throw new Error('Published knowledge nodes require static knowledge base IDs')
        }
        selected.forEach(id => ids.add(id as string))
    }
    return [...ids]
}
