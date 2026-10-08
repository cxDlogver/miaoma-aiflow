/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import jwt from 'jsonwebtoken'
import { cookies } from 'next/headers'

const JWT_SECRET = process.env.JWT_SECRET!
const TOKEN_NAME = 'auth-token'
const TOKEN_MAX_AGE = 60 * 60 * 24 * 7 // 7 days in seconds

export interface JWTPayload {
    userId: string
}

/**
 * Generate a JWT token for a user
 */
export function generateToken(userId: string): string {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' })
}

/**
 * Verify a JWT token and return the payload
 */
export function verifyToken(token: string): JWTPayload | null {
    try {
        return jwt.verify(token, JWT_SECRET) as JWTPayload
    } catch {
        return null
    }
}

/**
 * Set the auth cookie with the token
 */
export async function setAuthCookie(token: string): Promise<void> {
    const cookieStore = await cookies()
    cookieStore.set(TOKEN_NAME, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: TOKEN_MAX_AGE,
        path: '/',
    })
}

/**
 * Get the auth token from cookies
 */
export async function getAuthToken(): Promise<string | undefined> {
    const cookieStore = await cookies()
    return cookieStore.get(TOKEN_NAME)?.value
}

/**
 * Clear the auth cookie
 */
export async function clearAuthCookie(): Promise<void> {
    const cookieStore = await cookies()
    cookieStore.delete(TOKEN_NAME)
}

/**
 * Get the current user ID from the auth cookie
 */
export async function getCurrentUserId(): Promise<string | null> {
    const token = await getAuthToken()
    if (!token) return null

    const payload = verifyToken(token)
    return payload?.userId ?? null
}
