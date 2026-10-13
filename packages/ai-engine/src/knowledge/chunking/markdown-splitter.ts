/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import MarkdownIt from 'markdown-it'

import type { ChunkingConfig, TextChunk, TextSplitterService } from '../types'
import { DEFAULT_CHUNKING_CONFIG } from '../types'

// 通过 Markdown 块级语法识别真实标题，避免把代码块中的 # 误识别为标题。
const markdownParser = new MarkdownIt()

/**
 * Markdown 文本切分器
 * 保持 Markdown 结构，优先在标题处切分
 */
export class MarkdownSplitter implements TextSplitterService {
    private config: ChunkingConfig

    constructor(config?: Partial<ChunkingConfig>) {
        this.config = { ...DEFAULT_CHUNKING_CONFIG, ...config }
    }

    /**
     * 将 Markdown 文本切分为多个块
     */
    split(text: string, config?: Partial<ChunkingConfig>): TextChunk[] {
        const { chunkSize, chunkOverlap } = { ...this.config, ...config }

        if (!text || text.trim().length === 0) {
            return []
        }

        // 验证配置
        if (chunkSize <= 0) {
            throw new Error('chunkSize must be greater than 0')
        }
        if (chunkOverlap < 0 || chunkOverlap >= chunkSize) {
            throw new Error('chunkOverlap must be >= 0 and < chunkSize')
        }

        // 按 Markdown 标题分段
        const sections = this.splitByHeaders(text)

        // 对每个段落进行二次切分
        const chunks: TextChunk[] = []
        let globalIndex = 0

        for (const section of sections) {
            const sectionChunks = this.splitSection(section.content, section.startOffset, chunkSize, chunkOverlap)

            for (const chunk of sectionChunks) {
                chunks.push({
                    ...chunk,
                    index: globalIndex++,
                    metadata: {
                        ...chunk.metadata,
                        headerPath: section.headerPath,
                    },
                })
            }
        }

        return chunks
    }

    /**
     * 按 Markdown 标题切分
     */
    private splitByHeaders(text: string): Array<{
        content: string
        startOffset: number
        headerPath: string[]
    }> {
        const sections: Array<{
            content: string
            startOffset: number
            headerPath: string[]
        }> = []

        // MarkdownIt 的 heading_open Token 含有原始行号；
        // 预先建立行号到原始字符串偏移量的映射，兼容 LF、CRLF 和 CR 换行符。
        const lineOffsets = [0]
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\r') {
                if (text[i + 1] === '\n') i++
                lineOffsets.push(i + 1)
            } else if (text[i] === '\n') {
                lineOffsets.push(i + 1)
            }
        }

        // Markdown Token 可以区分标题与 fenced/indented code 等块级结构。
        const tokens = markdownParser.parse(text, {})
        const headers: Array<{ level: number; title: string; index: number }> = []

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i]
            if (token.type !== 'heading_open' || !token.map) continue

            const level = Number(token.tag.slice(1))
            const startOffset = lineOffsets[token.map[0]]
            const inlineToken = tokens[i + 1]
            if (!Number.isInteger(level) || level < 1 || level > 6 || startOffset === undefined || inlineToken?.type !== 'inline') {
                continue
            }

            // 从 inline 子 Token 提取可读标题，避免把强调、链接等 Markdown 标记写进 headerPath。
            const title = (inlineToken.children ?? [])
                .map(child => {
                    if (child.type === 'text' || child.type === 'code_inline' || child.type === 'image') return child.content
                    if (child.type === 'softbreak' || child.type === 'hardbreak') return ' '
                    return ''
                })
                .join('')
                .trim() || inlineToken.content.trim()

            headers.push({ level, title, index: startOffset })
        }

        // 裁剪空白时同步调整起始偏移，确保 Section 仍能定位回原文。
        const appendSection = (start: number, end: number, headerPath: string[]) => {
            const raw = text.slice(start, end)
            const content = raw.trim()
            if (content.length === 0) return

            const removedPrefix = raw.length - raw.trimStart().length
            sections.push({
                content,
                startOffset: start + removedPrefix,
                headerPath: [...headerPath],
            })
        }

        if (headers.length === 0) {
            appendSection(0, text.length, [])
            return sections
        }

        // 标题栈必须保存真实 level，不能以数组长度代表标题级别（Markdown 允许跳级）。
        const headerStack: Array<{ level: number; title: string }> = []

        if (headers[0].index > 0) {
            appendSection(0, headers[0].index, [])
        }

        for (let i = 0; i < headers.length; i++) {
            const header = headers[i]
            const nextHeader = headers[i + 1]

            while (headerStack.length > 0 && headerStack[headerStack.length - 1].level >= header.level) {
                headerStack.pop()
            }
            headerStack.push({ level: header.level, title: header.title })

            appendSection(
                header.index,
                nextHeader ? nextHeader.index : text.length,
                headerStack.map(item => item.title)
            )
        }

        return sections
    }

    /**
     * 对单个段落进行切分
     */
    private splitSection(content: string, baseOffset: number, chunkSize: number, chunkOverlap: number): TextChunk[] {
        if (content.length <= chunkSize) {
            return [
                {
                    content,
                    index: 0,
                    startOffset: baseOffset,
                    endOffset: baseOffset + content.length,
                },
            ]
        }

        const chunks: TextChunk[] = []
        const separators = ['\n\n', '\n', '。', '！', '？', '.', '!', '?', ' ']

        let startOffset = 0
        let index = 0

        while (startOffset < content.length) {
            let endOffset = Math.min(startOffset + chunkSize, content.length)

            // 尝试在分隔符处切分
            if (endOffset < content.length) {
                const searchStart = Math.max(startOffset + Math.floor(chunkSize * 0.5), startOffset)
                let bestSplit = endOffset

                for (const sep of separators) {
                    const lastIndex = content.lastIndexOf(sep, endOffset - 1)
                    if (lastIndex > searchStart && lastIndex < bestSplit) {
                        bestSplit = lastIndex + sep.length
                        break
                    }
                }

                endOffset = bestSplit
            }

            const rawChunk = content.slice(startOffset, endOffset)
            const chunkContent = rawChunk.trim()

            if (chunkContent.length > 0) {
                const removedPrefix = rawChunk.length - rawChunk.trimStart().length
                const chunkStart = baseOffset + startOffset + removedPrefix

                chunks.push({
                    content: chunkContent,
                    index,
                    startOffset: chunkStart,
                    endOffset: chunkStart + chunkContent.length,
                })
                index++
            }

            if (endOffset >= content.length) {
                break
            }

            const previousStart = startOffset
            startOffset = endOffset - chunkOverlap
            if (startOffset <= previousStart) {
                startOffset = endOffset
            }
        }

        return chunks
    }
}

/**
 * 创建 Markdown 切分器实例
 */
export function createMarkdownSplitter(config?: Partial<ChunkingConfig>): TextSplitterService {
    return new MarkdownSplitter(config)
}
