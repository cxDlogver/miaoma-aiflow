/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */
'use client'

import { Loader2Icon, SaveIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { useKnowledge } from '@/lib/contexts/knowledge-context'
import { knowledgeService } from '@/lib/services/knowledge-service'

interface SettingsFormData {
    embeddingModel: string
    dimensions: number
    name: string
    description: string
    icon: string
    retrievalMode: 'VECTOR' | 'FULLTEXT' | 'HYBRID'
    vectorWeight: number
    topK: number
    threshold: number
    chunkSize: number
    chunkOverlap: number
}

export function KnowledgeSettings() {
    const { knowledgeBase, setKnowledgeBase } = useKnowledge()
    const [saving, setSaving] = useState(false)
    const [formData, setFormData] = useState<SettingsFormData>({
        embeddingModel: 'mxbai-embed-large:latest',
        dimensions: 1024,
        name: '',
        description: '',
        icon: '📚',
        retrievalMode: 'VECTOR',
        vectorWeight: 0.7,
        topK: 5,
        threshold: 0.5,
        chunkSize: 500,
        chunkOverlap: 50,
    })

    const configuration = knowledgeBase
        ? JSON.stringify({
              embeddingModel: knowledgeBase.embeddingModel,
              dimensions: knowledgeBase.dimensions,
              name: knowledgeBase.name,
              description: knowledgeBase.description || '',
              icon: knowledgeBase.icon,
              retrievalMode: knowledgeBase.retrievalMode,
              vectorWeight: knowledgeBase.vectorWeight,
              topK: knowledgeBase.topK,
              threshold: knowledgeBase.threshold,
              chunkSize: knowledgeBase.chunkSize,
              chunkOverlap: knowledgeBase.chunkOverlap,
          })
        : null
    useEffect(() => {
        if (configuration) setFormData(JSON.parse(configuration) as SettingsFormData)
    }, [configuration])

    const handleSave = async () => {
        if (!knowledgeBase) return

        try {
            setSaving(true)
            const updated = await knowledgeService.update(knowledgeBase.id, formData)
            setKnowledgeBase(updated)
            toast.success('设置已保存')
        } catch (error) {
            toast.error(error instanceof Error ? error.message : '保存设置失败')
        } finally {
            setSaving(false)
        }
    }

    const updateField = <K extends keyof SettingsFormData>(field: K, value: SettingsFormData[K]) => {
        setFormData(prev => ({ ...prev, [field]: value }))
    }

    return (
        <div className="max-w-2xl space-y-8">
            {knowledgeBase && (
                <div className="rounded-lg border p-4 space-y-3">
                    <p className="text-sm">
                        索引状态：
                        {knowledgeBase.status === 'NEEDS_REBUILD'
                            ? '需要重建'
                            : knowledgeBase.status === 'INDEXING'
                              ? '索引中'
                              : knowledgeBase.status === 'ERROR'
                                ? '任务异常'
                                : '就绪'}
                    </p>
                    <p className="text-xs text-muted-foreground">修改模型或切分参数后会重建全部文档。重建期间暂停上传和检索。</p>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            disabled={saving || knowledgeBase.status === 'INDEXING'}
                            onClick={async () => {
                                try {
                                    setSaving(true)
                                    setKnowledgeBase(await knowledgeService.reindex(knowledgeBase.id))
                                    toast.success('索引重建已排队')
                                } catch (error) {
                                    toast.error(error instanceof Error ? error.message : '重建失败')
                                } finally {
                                    setSaving(false)
                                }
                            }}
                        >
                            重建索引
                        </Button>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={async () => {
                                try {
                                    setSaving(true)
                                    await knowledgeService.retryJobs(knowledgeBase.id)
                                    setKnowledgeBase(await knowledgeService.getById(knowledgeBase.id))
                                    toast.success('失败任务已重新排队')
                                } catch (error) {
                                    toast.error(error instanceof Error ? error.message : '重试失败')
                                } finally {
                                    setSaving(false)
                                }
                            }}
                        >
                            重试失败任务
                        </Button>
                    </div>
                </div>
            )}
            <div>
                <h2 className="text-lg font-semibold">设置</h2>
                <p className="text-sm text-muted-foreground">配置知识库的基本信息和检索参数</p>
            </div>

            {/* 基本信息 */}
            <div className="space-y-4">
                <h3 className="font-medium">基本信息</h3>

                <div className="space-y-2">
                    <Label>知识库名称</Label>
                    <Input value={formData.name} onChange={e => updateField('name', e.target.value)} placeholder="输入知识库名称" />
                </div>

                <div className="space-y-2">
                    <Label>描述</Label>
                    <Textarea
                        value={formData.description}
                        onChange={e => updateField('description', e.target.value)}
                        placeholder="输入知识库描述（可选）"
                        rows={3}
                    />
                </div>

                <div className="space-y-2">
                    <Label>图标</Label>
                    <Input value={formData.icon} onChange={e => updateField('icon', e.target.value)} className="w-20" maxLength={2} />
                </div>
            </div>

            <Separator />

            {/* 检索配置 */}
            <div className="space-y-4">
                <h3 className="font-medium">检索配置</h3>

                <div className="space-y-2">
                    <Label>检索模式</Label>
                    <Select
                        value={formData.retrievalMode}
                        onValueChange={v => updateField('retrievalMode', v as SettingsFormData['retrievalMode'])}
                    >
                        <SelectTrigger className="w-48">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="VECTOR">向量检索</SelectItem>
                            <SelectItem value="FULLTEXT">全文检索</SelectItem>
                            <SelectItem value="HYBRID">混合检索</SelectItem>
                        </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                        向量检索基于语义相似度，全文检索使用 BM25 词项排序，混合检索结合两者优势
                    </p>
                </div>

                {formData.retrievalMode === 'HYBRID' && (
                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Label>向量权重</Label>
                            <span className="text-sm text-muted-foreground">{(formData.vectorWeight * 100).toFixed(0)}%</span>
                        </div>
                        <Slider
                            value={[formData.vectorWeight]}
                            onValueChange={([v]: number[]) => updateField('vectorWeight', v)}
                            min={0}
                            max={1}
                            step={0.05}
                        />
                        <p className="text-xs text-muted-foreground">混合检索中向量检索的权重，剩余为全文检索权重</p>
                    </div>
                )}

                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <Label>Top K</Label>
                        <span className="text-sm text-muted-foreground">{formData.topK}</span>
                    </div>
                    <Slider value={[formData.topK]} onValueChange={([v]: number[]) => updateField('topK', v)} min={1} max={20} step={1} />
                    <p className="text-xs text-muted-foreground">返回的最大切片数量</p>
                </div>

                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <Label>相似度阈值</Label>
                        <span className="text-sm text-muted-foreground">{formData.threshold.toFixed(2)}</span>
                    </div>
                    <Slider
                        value={[formData.threshold]}
                        onValueChange={([v]: number[]) => updateField('threshold', v)}
                        min={0}
                        max={1}
                        step={0.05}
                    />
                    <p className="text-xs text-muted-foreground">仅过滤向量召回；全文检索和融合排名使用各自的分数尺度</p>
                </div>
            </div>

            <Separator />

            {/* 切分配置 */}
            <div className="space-y-4">
                <h3 className="font-medium">切分配置</h3>
                <p className="text-sm text-muted-foreground">修改切分配置后，需要重新处理所有文档才能生效</p>

                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label>切片大小</Label>
                        <Input
                            type="number"
                            value={formData.chunkSize}
                            onChange={e => updateField('chunkSize', parseInt(e.target.value) || 500)}
                            min={100}
                            max={2000}
                        />
                        <p className="text-xs text-muted-foreground">每个切片的最大字符数</p>
                    </div>

                    <div className="space-y-2">
                        <Label>重叠字符数</Label>
                        <Input
                            type="number"
                            value={formData.chunkOverlap}
                            onChange={e => updateField('chunkOverlap', parseInt(e.target.value) || 50)}
                            min={0}
                            max={500}
                        />
                        <p className="text-xs text-muted-foreground">相邻切片的重叠字符数</p>
                    </div>
                </div>
            </div>

            <Separator />

            <div className="space-y-4">
                <h3 className="font-medium">嵌入模型</h3>
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label htmlFor="embedding-model">Ollama 模型</Label>
                        <Input
                            id="embedding-model"
                            value={formData.embeddingModel}
                            onChange={e => updateField('embeddingModel', e.target.value)}
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="embedding-dimensions">向量维度</Label>
                        <Input
                            id="embedding-dimensions"
                            type="number"
                            min={1}
                            value={formData.dimensions}
                            onChange={e => updateField('dimensions', Number(e.target.value))}
                        />
                    </div>
                </div>
            </div>

            {/* 保存按钮 */}
            <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving || !knowledgeBase}>
                    {saving ? (
                        <>
                            <Loader2Icon className="size-4 animate-spin" />
                            保存中...
                        </>
                    ) : (
                        <>
                            <SaveIcon className="size-4" />
                            保存设置
                        </>
                    )}
                </Button>
            </div>
        </div>
    )
}
