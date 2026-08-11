import { cp, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = process.cwd()
const standalone = resolve(root, '.next', 'standalone')

await rm(resolve(standalone, 'data'), { recursive: true, force: true })
await mkdir(resolve(standalone, '.next'), { recursive: true })
await cp(resolve(root, '.next', 'static'), resolve(standalone, '.next', 'static'), { recursive: true, force: true })
await cp(resolve(root, 'public'), resolve(standalone, 'public'), { recursive: true, force: true })
await cp(resolve(root, 'db'), resolve(standalone, 'db'), { recursive: true, force: true })
