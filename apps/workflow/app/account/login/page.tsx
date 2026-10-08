/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */
'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'

import { TaiJi } from './TaiJi'
import { World } from './World'

interface LoginFormValues {
    email: string
    password: string
    name?: string
}

export default function LoginPage() {
    const form = useForm<LoginFormValues>({
        defaultValues: {
            email: '',
            password: '',
            name: '',
        },
    })
    const [inputType, setInputType] = useState<'login' | 'register'>('login')
    const [isLoading, setIsLoading] = useState(false)
    const router = useRouter()

    const handleSubmit = async (values: LoginFormValues) => {
        setIsLoading(true)

        try {
            if (inputType === 'login') {
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        email: values.email,
                        password: values.password,
                    }),
                })

                const data = await response.json()

                if (!response.ok) {
                    if (data.code === 'EMAIL_NOT_VERIFIED') {
                        toast.error('请先验证您的邮箱后再登录')
                        return
                    }
                    throw new Error(data.error || '登录失败')
                }

                toast.success('登录成功')
                const searchParams = new URLSearchParams(window.location.search)
                const redirectUrl = searchParams.get('redirect') || '/apps'
                router.push(redirectUrl)
            }

            if (inputType === 'register') {
                const response = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        email: values.email,
                        password: values.password,
                        name: values.name || undefined,
                    }),
                })

                const data = await response.json()

                if (!response.ok) {
                    throw new Error(data.error || '注册失败')
                }

                toast.success('注册成功！请查收验证邮件后登录')
                setInputType('login')
                form.reset()
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : '操作失败，请稍后重试')
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="container relative h-screen w-full flex-row items-center justify-end grid max-w-none grid-cols-2 !min-w-[1300px]">
            <div className="relative h-full flex-col bg-muted p-10 text-white dark:border-r flex">
                <div className="relative z-20 flex items-center text-lg font-medium">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="mr-2 h-6 w-6"
                    >
                        <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
                    </svg>
                    妙码学院
                </div>
                <div className="relative z-20 mt-auto">
                    <blockquote className="space-y-2">
                        <p className="text-4xl mb-8">&ldquo;灵感与链接齐飞，生成共信源一色&rdquo;</p>
                        <footer className="text-sm">@合一</footer>
                    </blockquote>
                </div>
            </div>
            <TaiJi />
            <World yi="yin" />
            <World yi="yang" />
            <div className="lg:p-8">
                <div className="flex items-center justify-center">
                    <div className="mx-auto grid w-[350px] gap-6">
                        <div className="grid gap-2 text-center">
                            <h1 className="text-3xl font-bold mb-8">妙码 AI 应用引擎</h1>
                        </div>
                        <Form {...form}>
                            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
                                {inputType === 'register' && (
                                    <FormField
                                        control={form.control}
                                        name="name"
                                        render={({ field }) => (
                                            <FormItem>
                                                <FormLabel>姓名</FormLabel>
                                                <FormControl>
                                                    <Input {...field} placeholder="请输入姓名（可选）" disabled={isLoading} />
                                                </FormControl>
                                                <FormMessage />
                                            </FormItem>
                                        )}
                                    />
                                )}
                                <FormField
                                    control={form.control}
                                    rules={{
                                        required: '请输入邮箱',
                                        pattern: {
                                            value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                                            message: '请输入有效的邮箱地址',
                                        },
                                    }}
                                    name="email"
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>邮箱</FormLabel>
                                            <FormControl>
                                                <Input {...field} type="email" placeholder="请输入邮箱" disabled={isLoading} />
                                            </FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />
                                <FormField
                                    control={form.control}
                                    name="password"
                                    rules={{
                                        required: '请输入密码',
                                        minLength: inputType === 'register' ? { value: 8, message: '密码至少需要8个字符' } : undefined,
                                    }}
                                    render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>密码</FormLabel>
                                            <FormControl>
                                                <Input {...field} type="password" placeholder="请输入密码" disabled={isLoading} />
                                            </FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )}
                                />

                                <Button type="submit" className="w-full bg-zinc-950 hover:bg-zinc-700" disabled={isLoading}>
                                    {isLoading ? '处理中...' : inputType === 'login' ? '登录' : '注册'}
                                </Button>
                            </form>
                        </Form>
                        {inputType === 'login' ? (
                            <div className="text-center text-sm">
                                没有账号?{' '}
                                <Button
                                    variant="link"
                                    className="px-1 text-zinc-950 hover:text-zinc-700"
                                    onClick={() => {
                                        form.clearErrors()
                                        form.reset()
                                        setInputType('register')
                                    }}
                                >
                                    注册
                                </Button>
                            </div>
                        ) : (
                            <div className="text-center text-sm">
                                已有账号?{' '}
                                <Button
                                    variant="link"
                                    className="px-1 text-zinc-950"
                                    onClick={() => {
                                        form.clearErrors()
                                        form.reset()
                                        setInputType('login')
                                    }}
                                >
                                    登录
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}
