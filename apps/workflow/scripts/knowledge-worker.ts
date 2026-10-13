/* eslint-disable no-console -- 常驻 CLI 将错误输出给进程管理器。 */
/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import 'dotenv/config'

import { closeKnowledgeWorker, runNextKnowledgeJob } from '../lib/services/knowledge-worker'
let stopped = false
process.on('SIGINT', () => {
    stopped = true
})
process.on('SIGTERM', () => {
    stopped = true
})
async function main() {
    while (!stopped) {
        try {
            const worked = await runNextKnowledgeJob()
            if (!worked) await new Promise(resolve => setTimeout(resolve, 1000))
        } catch (error) {
            console.error('Knowledge worker failed:', error instanceof Error ? error.message : error)
            await new Promise(resolve => setTimeout(resolve, 3000))
        }
    }
    await closeKnowledgeWorker()
}
main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
