/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'

import { QdrantClient } from '@qdrant/js-client-rest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const routePrincipal = vi.hoisted(() => ({ userId: null as string | null }))
vi.mock('@/lib/auth', () => ({ getCurrentUserId: async () => routePrincipal.userId }))

const db = process.env.KNOWLEDGE_INTEGRATION_DATABASE_URL
const qdrant = process.env.QDRANT_INTEGRATION_URL
// 仅针对专用空数据库；禁止将生产连接串用作清理目标。
describe.skipIf(!db || !qdrant)('PostgreSQL jobs + native Qdrant lifecycle', () => {
    const prefix = 'rag-lifecycle-' + Date.now()
    const users: string[] = []
    const kbIds: string[] = []
    const models = [prefix + '-1024', prefix + '-768', prefix + '-same1024']
    const collections = new Set<string>()
    let server: Server
    let prisma: any, indexService: any, worker: any, retrieval: any, ensureSpace: any, processor: any
    let owner: string, other: string
    let searchRoute: any, reindexRoute: any
    let badModel = false
    let raceHit: () => void = () => {}
    let raceRelease: Promise<void> | undefined
    const request = (ids: string[], mode = 'fulltext') => ({ query: '量子纠缠 E1042', knowledgeBaseIds: ids, mode, topK: 5, threshold: 0 })
    const makeBase = async (model = models[0], dimensions = 1024) => {
        const space = await ensureSpace({ embeddingModel: model, dimensions })
        collections.add(space.collectionName)
        const kb = await prisma.$transaction(async (tx: any) => {
            const kb = await tx.knowledgeBase.create({ data: { name: prefix, userId: owner, embeddingModel: model, dimensions } })
            const ix = await tx.knowledgeBaseIndex.create({
                data: {
                    knowledgeBaseId: kb.id,
                    embeddingSpaceId: space.id,
                    status: 'READY',
                    chunkSize: 500,
                    chunkOverlap: 50,
                    activatedAt: new Date(),
                },
            })
            return tx.knowledgeBase.update({ where: { id: kb.id }, data: { activeIndexId: ix.id, status: 'READY' } })
        })
        kbIds.push(kb.id)
        return kb
    }
    const enqueue = (kb: any, text = '量子纠缠 E1042 quantum') =>
        indexService.enqueueDocument(kb.id, owner, { name: 'test.txt', mimeType: 'text/plain', size: text.length, content: text })
    const drain = async () => {
        for (let n = 0; n < 30; n++) {
            if (!(await worker.runNextKnowledgeJob())) return
        }
        throw Error('Job drain did not finish')
    }
    beforeAll(async () => {
        const parsed = new URL(db!)
        if (parsed.hostname !== '127.0.0.1' || parsed.port !== '15433' || parsed.pathname !== '/rag_integration')
            throw Error('Use only the isolated rag_integration DB on 127.0.0.1:15433')
        process.env.DATABASE_URL = db
        process.env.QDRANT_URL = qdrant
        server = createServer(async (req, res) => {
            res.setHeader('Content-Type', 'application/json')
            if (req.url === '/api/tags') {
                res.end(
                    JSON.stringify({
                        models: models.map(name => ({ name: name + ':latest', digest: badModel ? 'changed' : 'fixed-digest' })),
                    })
                )
                return
            }
            if (req.url !== '/api/embed') {
                res.statusCode = 404
                res.end('{}')
                return
            }
            const body: Buffer[] = []
            for await (const chunk of req) body.push(chunk)
            const payload = JSON.parse(Buffer.concat(body).toString())
            if (payload.input.some((s: string) => s.includes('delete-race')) && raceRelease) {
                raceHit()
                await raceRelease
            }
            const dims = payload.model.includes('-768') ? 768 : 1024
            res.end(JSON.stringify({ embeddings: payload.input.map(() => [1, ...Array(dims - 1).fill(0)]) }))
        })
        server.listen(0, '127.0.0.1')
        await once(server, 'listening')
        process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:' + (server.address() as { port: number }).port
        prisma = (await import('@/lib/prisma')).prisma
        indexService = await import('@/lib/services/knowledge-index-service')
        worker = await import('@/lib/services/knowledge-worker')
        retrieval = (await import('@/lib/services/knowledge-retrieval')).createKnowledgeRetrievalService
        ensureSpace = (await import('@/lib/services/embedding-space-service')).ensureEmbeddingSpace
        processor = (await import('@/lib/services/document-processor')).processDocument
        owner = (await prisma.user.create({ data: { email: prefix + '@test.invalid', password: 'test' } })).id
        other = (await prisma.user.create({ data: { email: prefix + '-other@test.invalid', password: 'test' } })).id
        users.push(owner, other)
        searchRoute = (await import('@/app/api/knowledge/[id]/search/route')).POST
        reindexRoute = (await import('@/app/api/knowledge/[id]/reindex/route')).POST
    })
    afterAll(async () => {
        if (prisma) {
            await prisma.app.updateMany({ where: { userId: { in: users } }, data: { activePublishedId: null } })
            await prisma.app.deleteMany({ where: { userId: { in: users } } })
            await prisma.knowledgeIndexJob.deleteMany({ where: { knowledgeBaseId: { in: kbIds } } })
            await prisma.user.deleteMany({ where: { id: { in: users } } })
            await prisma.embeddingSpace.deleteMany({ where: { collectionName: { in: [...collections] } } })
        }
        if (qdrant) {
            const c = new QdrantClient({ url: qdrant })
            for (const name of collections) if ((await c.collectionExists(name)).exists) await c.deleteCollection(name)
        }
        if (worker) await worker.closeKnowledgeWorker()
        if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    })

    it('returns native BM25 results and rejects anonymous or unauthorized search requests', async () => {
        const kb = await makeBase()
        const doc = await enqueue(kb)
        await drain()
        const search = () =>
            searchRoute(
                new Request('http://localhost/api/knowledge/' + kb.id + '/search', {
                    method: 'POST',
                    body: JSON.stringify({ query: '量子纠缠 E1042', mode: 'fulltext', topK: 5 }),
                }),
                { params: Promise.resolve({ id: kb.id }) }
            )
        routePrincipal.userId = owner
        const response = await search()
        expect(response.status).toBe(200)
        const result = await response.json()
        expect(result.data.results[0]).toMatchObject({ documentId: doc.id, scoreType: 'bm25' })
        routePrincipal.userId = null
        expect((await search()).status).toBe(401)
        routePrincipal.userId = other
        expect((await search()).status).toBe(404)
        routePrincipal.userId = owner
    })
    it('reports invalid rebuild requests without changing the active index', async () => {
        const kb = await makeBase()
        const reindex = (body: string) =>
            reindexRoute(new Request('http://localhost/api/knowledge/' + kb.id + '/reindex', { method: 'POST', body }), {
                params: Promise.resolve({ id: kb.id }),
            })
        routePrincipal.userId = owner
        const invalidJson = await reindex('{')
        expect(invalidJson.status).toBe(400)
        expect(await invalidJson.json()).toMatchObject({ code: 'VALIDATION_ERROR', message: '请求正文必须是有效的 JSON' })
        const overlap = await reindex(JSON.stringify({ chunkSize: 100, chunkOverlap: 100 }))
        expect(overlap.status).toBe(400)
        expect(await overlap.json()).toMatchObject({ code: 'VALIDATION_ERROR', message: '重叠长度必须小于切片长度' })
        const dimensions = await reindex(JSON.stringify({ dimensions: 768 }))
        expect(dimensions.status).toBe(400)
        expect((await dimensions.json()).message).toContain('Embedding 模型校验失败')
        routePrincipal.userId = other
        expect((await reindex('{}')).status).toBe(404)
        routePrincipal.userId = owner
        expect((await prisma.knowledgeBase.findUnique({ where: { id: kb.id } })).activeIndexId).toBe(kb.activeIndexId)
    })
    it('reports rebuilding as a readable business error and resumes search after activation', async () => {
        const kb = await makeBase()
        await enqueue(kb)
        await drain()
        routePrincipal.userId = owner
        const rebuilt = await reindexRoute(
            new Request('http://localhost/api/knowledge/' + kb.id + '/reindex', {
                method: 'POST',
                body: JSON.stringify({ embeddingModel: models[1], dimensions: 768 }),
            }),
            { params: Promise.resolve({ id: kb.id }) }
        )
        expect(rebuilt.status).toBe(200)
        const search = () =>
            searchRoute(
                new Request('http://localhost/api/knowledge/' + kb.id + '/search', {
                    method: 'POST',
                    body: JSON.stringify({ query: '量子纠缠', mode: 'fulltext' }),
                }),
                { params: Promise.resolve({ id: kb.id }) }
            )
        const blocked = await search()
        expect(blocked.status).toBe(400)
        expect(await blocked.json()).toMatchObject({
            code: 'INVALID_OPERATION',
            message: '知识库索引尚未就绪，请先重建或等待处理完成',
        })
        await drain()
        expect((await search()).status).toBe(200)
        const ready = await prisma.knowledgeBase.findUnique({
            where: { id: kb.id },
            include: { activeIndex: { include: { embeddingSpace: true } } },
        })
        collections.add(ready.activeIndex.embeddingSpace.collectionName)
    })

    it('marks legacy indexes for rebuild while retaining original document text', async () => {
        const kb = await prisma.knowledgeBase.create({
            data: { name: prefix + '-legacy', userId: owner, status: 'READY', chunkCount: 3, documentCount: 1 },
        })
        kbIds.push(kb.id)
        const doc = await prisma.document.create({
            data: {
                knowledgeBaseId: kb.id,
                name: 'legacy',
                originalName: 'legacy.txt',
                mimeType: 'text/plain',
                size: 6,
                content: '历史文档正文',
                status: 'COMPLETED',
                chunkCount: 3,
                processedAt: new Date(),
            },
        })
        const migration = await readFile(
            new URL('../../../../apps/workflow/prisma/migrations/202610130002_require_index_rebuild/migration.sql', import.meta.url),
            'utf8'
        )
        await prisma.$transaction(async (tx: any) => {
            for (const sql of migration
                .split(';')
                .map(s => s.trim())
                .filter(Boolean))
                await tx.$executeRawUnsafe(sql)
        })
        const current = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } })
        const document = await prisma.document.findUnique({ where: { id: doc.id } })
        expect(current.status).toBe('NEEDS_REBUILD')
        expect(current.activeIndexId).toBeNull()
        expect(current.chunkCount).toBe(0)
        expect(document.content).toBe('历史文档正文')
        expect(document.status).toBe('ERROR')
        expect(document.chunkCount).toBe(0)
        await expect(retrieval({ kind: 'user', userId: owner }).retrieve(request([kb.id]))).rejects.toThrow('索引尚未就绪')
    })
    it('processes persistent upload jobs, survives idempotent replay and keeps counts accurate', async () => {
        const kb = await makeBase()
        const doc = await enqueue(kb)
        expect(await prisma.knowledgeIndexJob.count({ where: { documentId: doc.id, status: 'PENDING' } })).toBe(1)
        await drain()
        const di = await prisma.documentIndex.findFirst({ where: { documentId: doc.id } })
        expect(di.status).toBe('READY')
        const results = await retrieval({ kind: 'user', userId: owner }).retrieve(request([kb.id]))
        expect(results[0].documentId).toBe(doc.id)
        expect(results[0].scoreType).toBe('bm25')
        await processor(di.id)
        const current = await prisma.knowledgeBase.findUnique({ where: { id: kb.id } })
        expect(current.chunkCount).toBe(di.chunkCount)
        expect(current.documentCount).toBe(1)
    })
    it('recovers expired RUNNING jobs after a worker restart', async () => {
        const kb = await makeBase()
        const doc = await enqueue(kb)
        await prisma.knowledgeIndexJob.updateMany({
            where: { documentId: doc.id },
            data: { status: 'RUNNING', lockedAt: new Date(0), leaseToken: 'dead-worker' },
        })
        await drain()
        expect((await prisma.document.findUnique({ where: { id: doc.id } })).status).toBe('COMPLETED')
        expect((await prisma.knowledgeIndexJob.findFirst({ where: { documentId: doc.id } })).status).toBe('COMPLETED')
    })
    it('blocks uploads and retrieval while rebuilding, then activates the new 768 space', async () => {
        const kb = await makeBase()
        await enqueue(kb)
        await drain()
        const rebuilt = await indexService.rebuildKnowledgeBase(kb.id, owner, { embeddingModel: models[1], dimensions: 768 })
        expect(rebuilt.activeIndexId).not.toBe(kb.activeIndexId)
        await expect(enqueue(rebuilt)).rejects.toThrow('暂不能上传')
        await expect(retrieval({ kind: 'user', userId: owner }).retrieve(request([kb.id]))).rejects.toThrow('索引尚未就绪')
        await drain()
        const ready = await prisma.knowledgeBase.findUnique({
            where: { id: kb.id },
            include: { activeIndex: { include: { embeddingSpace: true } } },
        })
        expect(ready.activeIndex.status).toBe('READY')
        expect(ready.activeIndex.embeddingSpace.dimensions).toBe(768)
        expect((await retrieval({ kind: 'user', userId: owner }).retrieve(request([kb.id], 'hybrid')))[0].indexId).toBe(
            rebuilt.activeIndexId
        )
        collections.add(ready.activeIndex.embeddingSpace.collectionName)
    })
    it('fuses different models at equal dimensions and rejects wrong-owner requests', async () => {
        const a = await makeBase(),
            b = await makeBase(models[2])
        await enqueue(a)
        await enqueue(b)
        await drain()
        const r = await retrieval({ kind: 'user', userId: owner }).retrieve(request([a.id, b.id], 'vector'))
        expect(new Set(r.map((x: any) => x.embeddingSpaceId)).size).toBe(2)
        expect(r.every((x: any) => x.scoreType === 'rrf')).toBe(true)
        await expect(retrieval({ kind: 'user', userId: other }).retrieve(request([a.id]))).rejects.toThrow('unauthorized')
    })
    it('enforces the publication snapshot and live owner, including unpublish/revoke', async () => {
        const a = await makeBase(),
            b = await makeBase()
        await enqueue(a)
        await enqueue(b)
        await drain()
        const app = await prisma.app.create({ data: { name: prefix, userId: owner, isPublished: true } })
        const pub = await prisma.publishedApp.create({
            data: {
                appId: app.id,
                version: 1,
                name: prefix,
                nodes: [{ type: 'knowledge', data: { config: { knowledgeBaseIds: [a.id] } } }],
                edges: [],
            },
        })
        await prisma.app.update({ where: { id: app.id }, data: { activePublishedId: pub.id } })
        const service = retrieval({ kind: 'published', appId: app.id, publishedAppId: pub.id })
        expect(await service.retrieve(request([a.id]))).toHaveLength(1)
        await expect(service.retrieve(request([b.id]))).rejects.toThrow('published workflow scope')
        await prisma.knowledgeBase.update({ where: { id: a.id }, data: { userId: other } })
        await expect(service.retrieve(request([a.id]))).rejects.toThrow('unauthorized')
        await prisma.knowledgeBase.update({ where: { id: a.id }, data: { userId: owner } })
        await prisma.app.update({ where: { id: app.id }, data: { isPublished: false } })
        await expect(service.retrieve(request([a.id]))).rejects.toThrow('no longer active')
    })
    it('hides tombstones immediately and removes vectors after cleanup', async () => {
        const kb = await makeBase()
        const doc = await enqueue(kb)
        await drain()
        await indexService.scheduleDocumentDeletion(kb.id, doc.id, owner)
        expect(await retrieval({ kind: 'user', userId: owner }).retrieve(request([kb.id]))).toHaveLength(0)
        await drain()
        expect(await prisma.document.findUnique({ where: { id: doc.id } })).toBeNull()
        const survivor = await enqueue(kb)
        await drain()
        await indexService.scheduleKnowledgeDeletion(kb.id, owner)
        await expect(retrieval({ kind: 'user', userId: owner }).retrieve(request([kb.id]))).rejects.toThrow('unauthorized')
        await drain()
        expect(await prisma.knowledgeBase.findUnique({ where: { id: kb.id } })).toBeNull()
        expect(await prisma.document.findUnique({ where: { id: survivor.id } })).toBeNull()
    })
    it('prevents a processing upload from resurrecting a deleted document', async () => {
        const kb = await makeBase()
        let release!: () => void
        raceRelease = new Promise<void>(resolve => {
            release = resolve
        })
        const hit = new Promise<void>(resolve => {
            raceHit = resolve
        })
        const doc = await enqueue(kb, '量子纠缠 delete-race')
        const running = worker.runNextKnowledgeJob()
        await hit
        await indexService.scheduleDocumentDeletion(kb.id, doc.id, owner)
        release()
        await running
        raceRelease = undefined
        await drain()
        expect(await prisma.document.findUnique({ where: { id: doc.id } })).toBeNull()
        expect(await retrieval({ kind: 'user', userId: owner }).retrieve(request([kb.id]))).toHaveLength(0)
    })
    it('records retryable failures and stops on model digest drift', async () => {
        const kb = await makeBase()
        const doc = await enqueue(kb)
        badModel = true
        await worker.runNextKnowledgeJob()
        badModel = false
        const job = await prisma.knowledgeIndexJob.findFirst({ where: { documentId: doc.id } })
        expect(job.status).toBe('PENDING')
        expect(job.errorMessage).toContain('revision changed')
        expect((await prisma.document.findUnique({ where: { id: doc.id } })).status).toBe('ERROR')
        await prisma.knowledgeIndexJob.update({ where: { id: job.id }, data: { availableAt: new Date(0) } })
        await drain()
        expect((await prisma.document.findUnique({ where: { id: doc.id } })).status).toBe('COMPLETED')
    })
    it('retries cleanup failures without changing a READY index or no-op status', async () => {
        const kb = await makeBase()
        expect(await indexService.retryFailedKnowledgeJobs(kb.id, owner)).toBe(0)
        expect((await prisma.knowledgeBase.findUnique({ where: { id: kb.id } })).status).toBe('READY')
        await prisma.knowledgeIndexJob.create({
            data: {
                knowledgeBaseId: kb.id,
                kind: 'DELETE_INDEX',
                indexId: 'retired-id',
                status: 'FAILED',
                payload: { collectionName: (await prisma.embeddingSpace.findFirst({ where: { model: models[0] } })).collectionName },
            },
        })
        expect(await indexService.retryFailedKnowledgeJobs(kb.id, owner)).toBe(1)
        expect((await prisma.knowledgeBase.findUnique({ where: { id: kb.id } })).status).toBe('READY')
        await drain()
    })
    it('fences a stale lease without overwriting a newer completed state', async () => {
        const kb = await makeBase()
        let release!: () => void
        raceRelease = new Promise<void>(resolve => {
            release = resolve
        })
        const hit = new Promise<void>(resolve => {
            raceHit = resolve
        })
        const doc = await enqueue(kb, '量子纠缠 delete-race fencing')
        const running = worker.runNextKnowledgeJob()
        await hit
        const job = await prisma.knowledgeIndexJob.findFirst({ where: { documentId: doc.id } })
        const di = await prisma.documentIndex.findFirst({ where: { documentId: doc.id } })
        await prisma.$transaction(async (tx: any) => {
            await tx.knowledgeIndexJob.update({ where: { id: job.id }, data: { leaseToken: 'new-owner', status: 'COMPLETED' } })
            await tx.documentIndex.update({ where: { id: di.id }, data: { status: 'READY', chunkCount: 1 } })
            await tx.document.update({ where: { id: doc.id }, data: { status: 'COMPLETED', chunkCount: 1 } })
            await tx.knowledgeBase.update({ where: { id: kb.id }, data: { status: 'READY', chunkCount: 1 } })
        })
        release()
        await running
        raceRelease = undefined
        expect((await prisma.document.findUnique({ where: { id: doc.id } })).status).toBe('COMPLETED')
        expect((await prisma.documentIndex.findUnique({ where: { id: di.id } })).status).toBe('READY')
        expect((await prisma.knowledgeBase.findUnique({ where: { id: kb.id } })).status).toBe('READY')
    })

    it('waits for a writer with a live lease after its advisory connection is lost', async () => {
        const kb = await makeBase()
        let release!: () => void
        raceRelease = new Promise<void>(resolve => {
            release = resolve
        })
        const hit = new Promise<void>(resolve => {
            raceHit = resolve
        })
        const doc = await enqueue(kb, '量子纠缠 delete-race connection-loss')
        const running = worker.runNextKnowledgeJob()
        await hit
        await indexService.scheduleDocumentDeletion(kb.id, doc.id, owner)
        const killed = await prisma.$queryRawUnsafe(
            "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE datname = 'rag_integration' AND application_name = 'miaoma-knowledge-worker' AND pid <> pg_backend_pid()"
        )
        expect(killed.some((row: any) => row.terminated)).toBe(true)
        await new Promise(resolve => setTimeout(resolve, 50))
        // Session lock 已释放，但未完成的写入仍由 job lease 保护。
        expect(await worker.runNextKnowledgeJob()).toBe(false)
        release()
        await running
        raceRelease = undefined
        await drain()
        expect(await prisma.document.findUnique({ where: { id: doc.id } })).toBeNull()
        expect(await retrieval({ kind: 'user', userId: owner }).retrieve(request([kb.id]))).toHaveLength(0)
    })
})
