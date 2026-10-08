/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import 'dotenv/config'

import { join } from 'node:path'

import { defineConfig, env } from 'prisma/config'

export default defineConfig({
    schema: join(__dirname, 'prisma', 'schema.prisma'),
    datasource: {
        url: env('DATABASE_URL'),
    },
})
