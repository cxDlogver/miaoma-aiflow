/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { randomUUID } from 'node:crypto'

import { createQdrantVectorStore } from '@miaoma-aiflow/ai-engine'
import { Pool } from 'pg'

import { prisma } from '@/lib/prisma'

import { maybeActivateIndex, processDocument } from './document-processor'
import { lockKnowledgeBase, refreshKnowledgeCounts } from './knowledge-index-service'

const locks = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, application_name: 'miaoma-knowledge-worker' })
const leaseMs = 5 * 60 * 1000
/** 多 worker 按知识库取 PostgreSQL advisory lock；外部网络请求不占用数据库事务。 */
export async function runNextKnowledgeJob(): Promise<boolean> {
    const cutoff = new Date(Date.now() - leaseMs)
    const eligible = {
        OR: [
            { status: 'PENDING' as const, availableAt: { lte: new Date() } },
            { status: 'RUNNING' as const, lockedAt: { lt: cutoff } },
        ],
    }
    const candidates = await prisma.knowledgeIndexJob.findMany({ where: eligible, orderBy: { createdAt: 'asc' }, take: 20 })
    for (const candidate of candidates) {
        const connection = await locks.connect()
        let heartbeat: ReturnType<typeof setInterval> | undefined
        let locked = false
        let lost = false
        const token = randomUUID()
        try {
            locked =
                (
                    await connection.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
                        candidate.knowledgeBaseId,
                    ])
                ).rows[0]?.locked ?? false
            if (!locked) continue
            if (candidate.kind === 'DELETE_DOCUMENT' || candidate.kind === 'DELETE_KNOWLEDGE_BASE') {
                const writing = await prisma.knowledgeIndexJob.count({
                    where: {
                        knowledgeBaseId: candidate.knowledgeBaseId,
                        kind: 'PROCESS_DOCUMENT',
                        status: 'RUNNING',
                        lockedAt: { gte: cutoff },
                        ...(candidate.kind === 'DELETE_DOCUMENT' ? { documentId: candidate.documentId } : {}),
                    },
                })
                if (writing) continue
            }
            const claimed = await prisma.$transaction(async tx => {
                await lockKnowledgeBase(tx, candidate.knowledgeBaseId)
                return tx.knowledgeIndexJob.updateMany({
                    where: { id: candidate.id, ...eligible },
                    data: { status: 'RUNNING', lockedAt: new Date(), leaseToken: token, attempts: { increment: 1 } },
                })
            })
            if (!claimed.count) continue
            const onLost = () => {
                lost = true
            }
            connection.on('error', onLost)
            const assertLease = async (tx?: import('@/app/generated/prisma/client').Prisma.TransactionClient) => {
                if (
                    lost ||
                    !(await (tx ?? prisma).knowledgeIndexJob.count({ where: { id: candidate.id, leaseToken: token, status: 'RUNNING' } }))
                )
                    throw new Error('Knowledge job lease was lost')
            }
            heartbeat = setInterval(() => {
                void prisma.knowledgeIndexJob
                    .updateMany({ where: { id: candidate.id, leaseToken: token, status: 'RUNNING' }, data: { lockedAt: new Date() } })
                    .then(result => {
                        if (!result.count) lost = true
                    })
                    .catch(() => {
                        lost = true
                    })
            }, 10000)
            try {
                const payload = candidate.payload as Record<string, unknown>
                if (candidate.kind === 'PROCESS_DOCUMENT') {
                    if (typeof payload.documentIndexId !== 'string') throw new Error('Invalid document job payload')
                    await processDocument(payload.documentIndexId, assertLease)
                } else {
                    const collections = candidate.kind === 'DELETE_INDEX' ? [payload.collectionName] : payload.collections
                    if (!Array.isArray(collections) || collections.some(name => typeof name !== 'string'))
                        throw new Error('Invalid cleanup job payload')
                    for (const collectionName of [...new Set(collections as string[])]) {
                        await assertLease()
                        const store = createQdrantVectorStore({ url: process.env.QDRANT_URL ?? 'http://localhost:6333', collectionName })
                        if (candidate.kind === 'DELETE_INDEX') await store.deleteByIndexId(candidate.indexId!)
                        else if (candidate.kind === 'DELETE_DOCUMENT') await store.deleteByDocumentId(candidate.documentId!)
                        else await store.deleteByKnowledgeBaseId(candidate.knowledgeBaseId)
                    }
                    await assertLease()
                    await prisma.$transaction(async tx => {
                        await lockKnowledgeBase(tx, candidate.knowledgeBaseId)
                        await assertLease(tx)
                        if (candidate.kind === 'DELETE_DOCUMENT') {
                            await tx.document.deleteMany({ where: { id: candidate.documentId!, deletedAt: { not: null } } })
                            const kb = await tx.knowledgeBase.findUnique({ where: { id: candidate.knowledgeBaseId } })
                            if (kb && !kb.deletedAt) {
                                await refreshKnowledgeCounts(tx, kb.id)
                                await maybeActivateIndex(tx, kb.id)
                            }
                        } else if (candidate.kind === 'DELETE_KNOWLEDGE_BASE') {
                            await tx.knowledgeBase.deleteMany({ where: { id: candidate.knowledgeBaseId, deletedAt: { not: null } } })
                        }
                    })
                }
                await assertLease()
                await prisma.knowledgeIndexJob.updateMany({
                    where: { id: candidate.id, leaseToken: token, status: 'RUNNING' },
                    data: { status: 'COMPLETED', leaseToken: null, lockedAt: null, errorMessage: null },
                })
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                const terminal = candidate.attempts + 1 >= 5
                await prisma.$transaction(async tx => {
                    await lockKnowledgeBase(tx, candidate.knowledgeBaseId)
                    const released = await tx.knowledgeIndexJob.updateMany({
                        where: { id: candidate.id, leaseToken: token, status: 'RUNNING' },
                        data: {
                            status: terminal ? 'FAILED' : 'PENDING',
                            leaseToken: null,
                            lockedAt: null,
                            errorMessage: message,
                            availableAt: new Date(Date.now() + Math.min(60000, 2000 * 2 ** candidate.attempts)),
                        },
                    })
                    if (!released.count || lost) return
                    if (candidate.kind === 'PROCESS_DOCUMENT') {
                        const payload = candidate.payload as Record<string, unknown>
                        await tx.documentIndex.updateMany({
                            where: { id: String(payload.documentIndexId), status: { not: 'READY' } },
                            data: { status: 'FAILED', errorMessage: message },
                        })
                        await tx.document.updateMany({
                            where: { id: candidate.documentId!, deletedAt: null, status: { not: 'COMPLETED' } },
                            data: { status: 'ERROR', errorMessage: message },
                        })
                        await tx.knowledgeBaseIndex.updateMany({
                            where: { id: candidate.indexId!, status: 'BUILDING' },
                            data: { status: 'FAILED' },
                        })
                        await tx.knowledgeBase.updateMany({
                            where: { id: candidate.knowledgeBaseId, deletedAt: null, activeIndexId: candidate.indexId },
                            data: { status: 'ERROR' },
                        })
                    }
                })
            } finally {
                connection.removeListener('error', onLost)
            }
            return true
        } finally {
            clearInterval(heartbeat)
            if (locked) {
                try {
                    await connection.query('SELECT pg_advisory_unlock(hashtext($1))', [candidate.knowledgeBaseId])
                } catch {
                    /* 连接断开会释放 session lock。 */
                }
            }
            connection.release()
        }
    }
    return false
}
export async function closeKnowledgeWorker() {
    await locks.end()
    await prisma.$disconnect()
}
