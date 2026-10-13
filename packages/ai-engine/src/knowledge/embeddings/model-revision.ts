/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { DEFAULT_EMBEDDING_CONFIG } from '../types'
export async function getOllamaModelRevision(model: string, baseUrl = DEFAULT_EMBEDDING_CONFIG.baseUrl): Promise<string> {
    const response = await fetch(baseUrl.replace(/\/$/, '') + '/api/tags', { signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error('Cannot read Ollama model revisions')
    const data = (await response.json()) as { models?: Array<{ name: string; model?: string; digest: string }> }
    const canonical = model.includes(':') ? model : model + ':latest'
    const found = data.models?.find(
        item => item.name === canonical || item.model === canonical || item.name === model || item.model === model
    )
    if (!found?.digest) throw new Error('Embedding model is not installed: ' + model)
    return found.digest
}
