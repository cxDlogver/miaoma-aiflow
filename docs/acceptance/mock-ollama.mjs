/*
 * Deterministic Ollama-compatible stub for local acceptance only.
 *
 * It is intentionally small and dependency-free. It verifies the integration
 * contract used by @langchain/ollama without pretending to be a real model.
 * Replace it with a real Ollama service for semantic-quality acceptance.
 */
import { createServer } from 'node:http'

const port = Number(process.env.MOCK_OLLAMA_PORT || 11434)
const dimensions = 1024

function sendJson(response, body, status = 200) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
}

async function readJson(request) {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function tokenize(text) {
    return String(text)
        .toLowerCase()
        .match(/[\u3400-\u9fff]|[a-z0-9]+/g) || []
}

function hashToken(token) {
    let hash = 2166136261
    for (const character of token) {
        hash ^= character.codePointAt(0)
        hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
}

function embed(text) {
    const vector = Array(dimensions).fill(0)
    for (const token of tokenize(text)) {
        const hash = hashToken(token)
        const index = hash % dimensions
        vector[index] += (hash & 1) === 0 ? 1 : -1
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
    return vector.map(value => value / norm)
}

function answerFromMessages(messages = []) {
    const prompt = messages.map(message => String(message.content || '')).join('\n')

    if (prompt.includes('年假')) {
        return '根据检索到的《企业员工手册》：正式员工每个自然年享有 10 天带薪年假；试用期满后可以申请；原则上需至少提前 3 个工作日在 OA 提交，连续休假超过 5 天还需部门负责人审批。'
    }

    return '已完成本地兼容桩验收：工作流成功接收检索证据并生成结构化回答。请切换到真实 Ollama 模型进行语义质量验收。'
}

const server = createServer(async (request, response) => {
    try {
        if (request.method === 'GET' && request.url === '/api/version') {
            return sendJson(response, { version: '0.0.0-acceptance-stub' })
        }

        if (request.method === 'GET' && request.url === '/api/tags') {
            return sendJson(response, {
                models: [
                    { name: 'qwen3:8b', model: 'qwen3:8b' },
                    { name: 'mxbai-embed-large:latest', model: 'mxbai-embed-large:latest' },
                ],
            })
        }

        if (request.method === 'POST' && request.url === '/api/embed') {
            const body = await readJson(request)
            const inputs = Array.isArray(body.input) ? body.input : [body.input]
            return sendJson(response, {
                model: body.model,
                embeddings: inputs.map(embed),
                total_duration: 1,
                load_duration: 0,
                prompt_eval_count: inputs.length,
            })
        }

        if (request.method === 'POST' && request.url === '/api/chat') {
            const body = await readJson(request)
            const content = answerFromMessages(body.messages)
            const payload = {
                model: body.model,
                created_at: new Date().toISOString(),
                message: { role: 'assistant', content },
                done: true,
                done_reason: 'stop',
                total_duration: 1,
                load_duration: 0,
                prompt_eval_count: tokenize(JSON.stringify(body.messages || [])).length,
                eval_count: tokenize(content).length,
            }

            if (body.stream) {
                response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' })
                response.end(`${JSON.stringify(payload)}\n`)
                return
            }

            return sendJson(response, payload)
        }

        return sendJson(response, { error: `Unsupported endpoint: ${request.method} ${request.url}` }, 404)
    } catch (error) {
        return sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500)
    }
})

server.listen(port, '127.0.0.1', () => {
    console.log(`Mock Ollama acceptance server listening on http://127.0.0.1:${port}`)
})
