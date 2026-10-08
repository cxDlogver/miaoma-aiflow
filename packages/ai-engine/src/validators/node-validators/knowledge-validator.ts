/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import type { KnowledgeNodeConfig, ValidationResult } from '../../types'
import type { NodeValidator } from '../types'

/**
 * 知识库节点验证器
 */
export class KnowledgeValidator implements NodeValidator<KnowledgeNodeConfig> {
    readonly type = 'knowledge' as const

    validate(config: KnowledgeNodeConfig): ValidationResult {
        const errors: string[] = []

        if (!config.knowledgeBaseIds || config.knowledgeBaseIds.length === 0) {
            errors.push('At least one knowledge base must be selected')
        }

        if (!config.query || config.query.trim().length === 0) {
            errors.push('Query is required')
        }

        if (config.topK && (config.topK < 1 || config.topK > 20)) {
            errors.push('Top K must be between 1 and 20')
        }

        if (config.threshold !== undefined && (config.threshold < 0 || config.threshold > 1)) {
            errors.push('Threshold must be between 0 and 1')
        }

        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
        }
    }
}
