/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */
import type { FlowEdge, FlowNode } from './editor'
import { FlowEditor } from './editor'

interface FlowProps {
    appId?: string
    appName?: string
    initialNodes?: FlowNode[]
    initialEdges?: FlowEdge[]
}

export const Flow = ({ appId = '', appName = '', initialNodes = [], initialEdges = [] }: FlowProps) => {
    return (
        <div className="h-[calc(100vh-var(--header-height))] w-full">
            {appId ? (
                <FlowEditor appId={appId} appName={appName} initialNodes={initialNodes} initialEdges={initialEdges} />
            ) : (
                <FlowEditor appId="" appName="" initialNodes={[]} initialEdges={[]} />
            )}
        </div>
    )
}
