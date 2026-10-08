/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */
'use client'

import { createContext, useContext, useState } from 'react'

export interface AppInfo {
    id: string
    name: string
    description: string | null
    icon: string
    type: 'workflow' | 'chatbot' | 'agent'
    tags: string[]
}

interface AppContextValue {
    app: AppInfo | null
    setApp: (app: AppInfo | null) => void
}

const AppContext = createContext<AppContextValue | undefined>(undefined)

export function AppProvider({ children }: { children: React.ReactNode }) {
    const [app, setApp] = useState<AppInfo | null>(null)

    return <AppContext.Provider value={{ app, setApp }}>{children}</AppContext.Provider>
}

export function useApp() {
    const context = useContext(AppContext)
    if (context === undefined) {
        throw new Error('useApp must be used within an AppProvider')
    }
    return context
}
