/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

export { LegacyWorkflowEngine, createWorkflowEngine } from './core'
export type { LegacyEngineConfig } from './core'

// 类型定义
export * from './types'

// 节点系统
export {
    NodeRegistry,
    createNodeRegistry,
    createDefaultRegistry,
    BaseNodeExecutor,
    StartExecutor,
    LLMExecutor,
    HTTPExecutor,
    ConditionExecutor,
    EndExecutor,
} from './nodes'

// 日志系统
export { DefaultExecutionLogger, createExecutionLogger } from './logger'
export type { LogCallback } from './logger'

// 核心工具
export { createExecutionContext, GraphBuilder, VariableResolver } from './core'

// 知识库模块 (RAG)
export * from './knowledge'

// 版本信息
export const VERSION = '1.0.0'
