/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import type { EndNodeConfig, ValidationResult, WorkflowDefinition, WorkflowNode } from '../../types'
import type { NodeValidator } from '../types'

/**
 * END 节点验证器
 */
export class EndValidator implements NodeValidator<EndNodeConfig> {
    readonly type = 'end' as const

    validate(_config: EndNodeConfig): ValidationResult {
        // End 节点没有特殊的配置要求
        return {
            valid: true,
        }
    }

    validateInWorkflow(_node: WorkflowNode, workflow: WorkflowDefinition): ValidationResult {
        const errors: string[] = []

        // 检查是否至少有一个 end 节点
        const endNodes = workflow.nodes.filter(n => n.type === 'end')
        if (endNodes.length === 0) {
            errors.push('Workflow must have at least one end node')
        }

        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
        }
    }
}
