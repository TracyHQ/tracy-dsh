/**
 * The file the raw local I/O opens is the file `resolveLocalTarget` resolved. A target is
 * resolved (and judged by policy hooks) once, then opened again by name; a directory on the
 * path swapped for a symlink in between must not make a read return, or a write land in, a
 * file outside the resolved target. The descriptor check needs `/proc/self/fd` (Linux); the
 * final-component check (`O_NOFOLLOW`) holds on every POSIX host. On Linux, writes publish
 * relative to the verified parent descriptor through `@deepseek-ai/node-addon-system/dirfd`
 * (built by the root `build:native-system`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  readByteWindow,
  readForEdit,
  readTextForDiff,
  readWholeBytes,
  readWholeText,
  resolveLocalTarget,
  streamWholeText,
  writeFileAtomic,
} from '../src/fsio.ts'
import type { LocalTarget } from '../src/fsio.ts'

const INSIDE = 'inside content\n'
const OUTSIDE = 'OUTSIDE-SECRET\n'
const posix = process.platform !== 'win32'
// The descriptor check reads `/proc/self/fd/<fd>`; macOS and Windows have no such directory.
const procFd = existsSync('/proc/self/fd')
const RACE_ITERATIONS = 2000
const RACE_DEADLINE_MS = 30_000

let root: string
let site: string
let dir: string
let parked: string
let outside: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-opened-target-')))
  site = join(root, 'site')
  dir = join(site, 'd')
  parked = join(site, 'd.parked')
  outside = join(root, 'outside')
  await mkdir(dir, { recursive: true })
  await mkdir(outside)
  await writeFile(join(dir, 'f.txt'), INSIDE)
  await writeFile(join(outside, 'f.txt'), OUTSIDE)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let out = ''
  for await (const chunk of chunks) out += chunk
  return out
}

async function filesUnder(path: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`
    if (entry.isDirectory()) found.push(...await filesUnder(join(path, entry.name), `${name}/`))
    else found.push(name)
  }
  return found.sort()
}

async function swapDirForOutsideLink(): Promise<void> {
  await rename(dir, parked)
  await symlink(outside, dir)
}

/** Every read entry point, decoded to text; `null` stands for a refused diff basis. */
async function readEveryWay(target: LocalTarget): Promise<Array<string | null>> {
  const results: Array<string | null> = []
  const attempts: Array<() => Promise<string | null>> = [
    () => readWholeText(target),
    async () => (await readForEdit(target.targetKey, target.displayPath)).content,
    () => collect(streamWholeText(target)),
    async () => Buffer.from(await readWholeBytes(target, undefined, 1024)).toString('utf8'),
    async () => Buffer.from(await readByteWindow(target, { offset: 0, length: 1024 })).toString('utf8'),
    () => readTextForDiff(target.targetKey, 1024),
  ]
  for (const attempt of attempts) {
    try {
      results.push(await attempt())
    } catch (_refused) {
      // A refused or failed read returns nothing to the caller.
    }
  }
  return results
}

describe('opened target, ordinary files', () => {
  it('reads every way and writes a normal file', async () => {
    const target = await resolveLocalTarget(site, 'd/f.txt')
    expect(await readEveryWay(target)).toEqual([INSIDE, INSIDE, INSIDE, INSIDE, INSIDE, INSIDE])
    await writeFileAtomic(target.targetKey, 'replaced\n', 0o644, undefined)
    expect(await readFile(join(dir, 'f.txt'), 'utf8')).toBe('replaced\n')
    const created = await resolveLocalTarget(site, 'd/new/child.txt')
    await writeFileAtomic(created.targetKey, 'created\n', undefined, undefined, {}, { displayPath: created.displayPath })
    expect(await readFile(join(dir, 'new', 'child.txt'), 'utf8')).toBe('created\n')
    expect(await filesUnder(dir)).toEqual(['f.txt', 'new/child.txt'])
  })

  it.skipIf(!posix)('refuses a final component that became a symlink after resolution', async () => {
    const target = await resolveLocalTarget(site, 'd/f.txt')
    await unlink(join(dir, 'f.txt'))
    await symlink(join(outside, 'f.txt'), join(dir, 'f.txt'))
    const changed = { code: 'FS_IO_ERROR', message: `cannot read "${target.displayPath}": the path changed while it was being opened` }
    await expect(readWholeText(target)).rejects.toMatchObject(changed)
    await expect(collect(streamWholeText(target))).rejects.toMatchObject(changed)
    await expect(readWholeBytes(target, undefined, 1024)).rejects.toMatchObject(changed)
    await expect(readByteWindow(target, { offset: 0, length: 4 })).rejects.toMatchObject(changed)
    await expect(readForEdit(target.targetKey, target.displayPath)).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
      message: `cannot edit "${target.displayPath}": the path changed while it was being opened`,
    })
    expect(await readTextForDiff(target.targetKey, 1024)).toBeNull()
  })
})

// Skipped without `/proc/self/fd` (macOS, Windows): the descriptor check is Linux-only there.
describe.skipIf(!procFd)('opened target, directory swapped for a symlink (Linux /proc/self/fd)', () => {
  it('refuses reads that reach another directory', async () => {
    const target = await resolveLocalTarget(site, 'd/f.txt')
    await swapDirForOutsideLink()
    await expect(readWholeText(target)).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
      message: `cannot read "${target.displayPath}": the path changed while it was being opened`,
    })
    expect(await readEveryWay(target)).toEqual([null])
  })

  it.each([
    ['relative to the parent descriptor', {}],
    ['by path', { descriptorPublication: false }],
  ])('refuses a write that would land in another directory and leaves it unchanged (%s)', async (_publication, internals) => {
    const target = await resolveLocalTarget(site, 'd/f.txt')
    await swapDirForOutsideLink()
    await expect(writeFileAtomic(target.targetKey, 'dsh write\n', 0o644, undefined, internals)).rejects.toMatchObject({
      code: 'FS_IO_ERROR',
      message: `cannot write "${target.targetKey}": the path changed while it was being opened`,
    })
    expect(await filesUnder(outside)).toEqual(['f.txt'])
    expect(await readdir(outside)).toEqual(['f.txt'])
    expect(await readFile(join(outside, 'f.txt'), 'utf8')).toBe(OUTSIDE)
  })
})

/**
 * The parent is swapped while the staged temp file waits for publication. The symlink planted at
 * `outside/<staging dir>` stands in for the moment, inside one path-based `rename`/`link`, when the
 * kernel has looked up the temp's parent through the real directory and then looks up the target's
 * parent through the symlink: path-based publication follows it and places the file in `outside`.
 * Publication relative to the verified parent descriptor cannot.
 */
describe.skipIf(!procFd)('opened target, parent swapped during publication (Linux /proc/self/fd)', () => {
  async function swapDuringPublication(stagingDir: string): Promise<string> {
    const staging = basename(stagingDir)
    await swapDirForOutsideLink()
    await symlink(join(parked, staging), join(outside, staging))
    return staging
  }

  async function outsideFiles(planted: string | undefined): Promise<string[]> {
    return (await readdir(outside)).filter(name => name !== planted).sort()
  }

  it('cannot place a replacement outside the resolved directory', async () => {
    const target = await resolveLocalTarget(site, 'd/f.txt')
    let planted: string | undefined
    let outcome: 'written' | 'refused' = 'written'
    try {
      await writeFileAtomic(target.targetKey, 'dsh write\n', 0o644, undefined, {
        inspectTemp: async ({ stagingDir }) => { planted = await swapDuringPublication(stagingDir) },
      })
    } catch (_refused) {
      outcome = 'refused'
    }
    expect(planted).toBeDefined()
    expect(await readFile(join(outside, 'f.txt'), 'utf8')).toBe(OUTSIDE)
    expect(await outsideFiles(planted)).toEqual(['f.txt'])
    // The write lands in the directory that was resolved (now parked), or not at all.
    expect(await readFile(join(parked, 'f.txt'), 'utf8')).toBe(outcome === 'written' ? 'dsh write\n' : INSIDE)
    expect(outcome).toBe('written')
    expect(await filesUnder(parked)).toEqual(['f.txt'])
  })

  it('cannot place a new file outside the resolved directory', async () => {
    const target = await resolveLocalTarget(site, 'd/new.txt')
    let planted: string | undefined
    let outcome: 'written' | 'refused' = 'written'
    try {
      await writeFileAtomic(target.targetKey, 'dsh create\n', undefined, undefined, {
        inspectTemp: async ({ stagingDir }) => { planted = await swapDuringPublication(stagingDir) },
      }, { displayPath: target.displayPath })
    } catch (_refused) {
      outcome = 'refused'
    }
    expect(planted).toBeDefined()
    expect(await outsideFiles(planted)).toEqual(['f.txt'])
    expect(await readFile(join(outside, 'f.txt'), 'utf8')).toBe(OUTSIDE)
    if (outcome === 'written') expect(await readFile(join(parked, 'new.txt'), 'utf8')).toBe('dsh create\n')
    expect(outcome).toBe('written')
    expect(await filesUnder(parked)).toEqual(['f.txt', 'new.txt'])
  })
})

/**
 * A separate process flips `site/d` between the real directory and a symlink to `outside`
 * while this process reads or writes `site/d/f.txt`, resolved while `d` was real.
 */
const FLIPPER = `
const fs = require('node:fs')
const [dir, parked, outside] = process.argv.slice(1)
const hold = () => { const until = process.hrtime.bigint() + 100_000n; while (process.hrtime.bigint() < until); }
process.stdout.write('ready\\n')
for (;;) {
  try { fs.renameSync(dir, parked) } catch {}
  try { fs.symlinkSync(outside, dir) } catch {}
  hold()
  try { fs.unlinkSync(dir) } catch {}
  try { fs.renameSync(parked, dir) } catch {
    // A writer's recursive mkdir recreated the directory while it was parked.
    try { fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(parked, dir) } catch {}
  }
  hold()
}
`

async function startFlipper(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', FLIPPER, dir, parked, outside], { stdio: ['ignore', 'pipe', 'inherit'] })
  await once(child.stdout, 'data')
  return child
}

async function stopFlipper(child: ChildProcess): Promise<void> {
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  if ((await lstat(dir).catch(() => null))?.isSymbolicLink()) await unlink(dir)
  if (existsSync(parked)) {
    await rm(dir, { recursive: true, force: true })
    await rename(parked, dir)
  }
}

describe.skipIf(!procFd)('opened target under a concurrent directory swap (Linux /proc/self/fd)', () => {
  it('never returns the outside content from any read', async () => {
    const target = await resolveLocalTarget(site, 'd/f.txt')
    const flipper = await startFlipper()
    const seen = new Map<string, number>()
    const deadline = Date.now() + RACE_DEADLINE_MS
    try {
      for (let i = 0; i < RACE_ITERATIONS && Date.now() < deadline; i += 1) {
        for (const result of await readEveryWay(target)) {
          const key = result ?? 'null'
          seen.set(key, (seen.get(key) ?? 0) + 1)
        }
      }
    } finally {
      await stopFlipper(flipper)
    }
    expect(seen.get(OUTSIDE) ?? 0).toBe(0)
    expect([...seen.keys()].filter(key => key !== INSIDE && key !== 'null')).toEqual([])
    expect(seen.get(INSIDE) ?? 0).toBeGreaterThan(0)
  }, RACE_DEADLINE_MS + 15_000)

  it('never lands a write outside the resolved directory', async () => {
    const target = await resolveLocalTarget(site, 'd/f.txt')
    const flipper = await startFlipper()
    let written = 0
    const deadline = Date.now() + RACE_DEADLINE_MS
    try {
      for (let i = 0; i < RACE_ITERATIONS && Date.now() < deadline; i += 1) {
        try {
          await writeFileAtomic(target.targetKey, `dsh write ${i}\n`, 0o644, undefined)
          written += 1
        } catch (_refused) {
          // A refused or failed write publishes nothing.
        }
      }
    } finally {
      await stopFlipper(flipper)
    }
    expect(await readFile(join(outside, 'f.txt'), 'utf8')).toBe(OUTSIDE)
    // Empty staging directories may remain when `mkdir` crossed the symlink and the
    // following open did not; no file content may.
    expect(await filesUnder(outside)).toEqual(['f.txt'])
    expect(written).toBeGreaterThan(0)
  }, RACE_DEADLINE_MS + 15_000)
})
