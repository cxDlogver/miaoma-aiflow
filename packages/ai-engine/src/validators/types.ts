/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import type { ValidationResult, WorkflowDefinition, WorkflowNode } from '../types'

/**
 * 节点验证器接口
 */
export interface NodeValidator<TConfig = unknown> {
    /**
     * 节点类型
     */
    readonly type: string

    /**
     * 验证节点配置
     */
    validate(config: TConfig): ValidationResult

    /**
     * 验证节点在工作流中的上下文（可选）
     * 例如：验证节点的连接关系、前置条件等
     */
    validateInWorkflow?(node: WorkflowNode, workflow: WorkflowDefinition): ValidationResult
}

/**
 * 工作流验证器接口
 */
export interface WorkflowValidator {
    /**
     * 验证工作流定义
     */
    validate(workflow: WorkflowDefinition): ValidationResult
}
