/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */
'use client'

import { createContext, useContext } from 'react'

import type { NodeKind } from '../handle'

export interface FlowEditorContextValue {
    onAddNode?: (type: NodeKind) => void
    hasStartNode?: boolean
    /** 所有节点信息，用于在节点卡片中渲染变量标签 */
    nodes?: Array<{ id: string; data?: { label?: string } }>
}

export const FlowEditorContext = createContext<FlowEditorContextValue>({})

export function useFlowEditorContext() {
    return useContext(FlowEditorContext)
}
