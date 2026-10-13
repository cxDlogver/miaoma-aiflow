/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('../../apps/workflow/', import.meta.url)),
            '@miaoma-aiflow/ai-engine': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['src/**/__tests__/**/*.test.ts', 'tests/**/*.test.ts'],
        exclude: ['node_modules', 'build'],
        testTimeout: 30000,
    },
})
