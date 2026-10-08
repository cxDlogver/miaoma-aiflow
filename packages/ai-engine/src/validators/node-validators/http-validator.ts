/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import type { HttpNodeConfig, ValidationResult } from '../../types'
import type { NodeValidator } from '../types'

/**
 * HTTP 节点验证器
 */
export class HTTPValidator implements NodeValidator<HttpNodeConfig> {
    readonly type = 'http' as const

    validate(config: HttpNodeConfig): ValidationResult {
        const errors: string[] = []

        if (!config.url) {
            errors.push('URL is required')
        }

        if (!config.method) {
            errors.push('HTTP method is required')
        }

        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
        }
    }
}
