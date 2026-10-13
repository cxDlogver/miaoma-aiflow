/*
 *   Copyright (c) 2026 妙码学院 @Heyi
 *   All rights reserved.
 *   妙码学院官方出品，作者 @Heyi，供学员学习使用，可用作练习，可用作美化简历，不可开源。
 */

import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const canonical = await readFile(new URL('apps/workflow/prisma/schema.prisma', root), 'utf8')
const check = process.argv.includes('--check')
for (const [path, output] of [
    ['apps/webapp/prisma/schema.prisma', '../app/generated/prisma'],
    ['apps/api-server/prisma/schema.prisma', '../src/generated/prisma'],
]) {
    const expected = canonical.replace(/output\s*=\s*"[^"]+"/, 'output = "' + output + '"')
    const current = await readFile(new URL(path, root), 'utf8')
    // 忽略 Prisma formatter 对 output 行的对齐和 CRLF，其余契约必须一致。
    const normalize = text => text.replace(/\r\n/g, '\n').replace(/output\s*=\s*"([^"]+)"/, 'output = "$1"')
    if (normalize(current) !== normalize(expected)) {
        if (check) throw new Error('Prisma schema drift: ' + path + '. Run pnpm schema:sync')
        await writeFile(new URL(path, root), expected)
    }
}
console.log(check ? 'Prisma schemas match' : 'Prisma schemas synchronized')
