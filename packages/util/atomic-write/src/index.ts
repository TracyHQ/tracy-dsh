/**
 * Zero-dependency atomic file replacement and writer coordination.
 * `writeFileAtomic` writes a random-suffix sibling with exclusive create and
 * the caller's permission bits, then renames it over the target, so readers
 * observe either the old or the new complete content and a replaced file ends
 * up with exactly the stated mode. `withFileLock` serializes cross-process
 * writers of one file through a `wx`-created `<file>.lock` sibling, so a
 * read-modify-write cycle can never resurrect a state another writer just
 * replaced; readers stay lock-free because the rename commit is atomic. A lock
 * whose recorded holder process no longer exists is taken over, and so is one
 * that names this process's own PID but was written before this process
 * started (an earlier process with the same PID left it).
 * @module @deepseek-ai/dsh-atomic-write
 */

import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const WINDOWS_TRANSIENT_RENAME_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])
const WINDOWS_RENAME_RETRY_INITIAL_MS = 20
const WINDOWS_RENAME_RETRY_MAX_MS = 200
const WINDOWS_RENAME_RETRY_LIMIT = 8

/** Whether Windows reported temporary interference with an atomic replacement. */
function isTransientWindowsRenameError(error: unknown): boolean {
  if (process.platform !== 'win32') return false
  return WINDOWS_TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** Replace the target after bounded retries for transient Windows interference. */
async function renameAtomicTemp(temp: string, filename: string): Promise<void> {
  let delay = WINDOWS_RENAME_RETRY_INITIAL_MS
  for (let retries = 0;; retries += 1) {
    try {
      await rename(temp, filename)
      return
    } catch (error) {
      if (!isTransientWindowsRenameError(error)) throw error
      if (retries >= WINDOWS_RENAME_RETRY_LIMIT) throw error
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, WINDOWS_RENAME_RETRY_MAX_MS)
  }
}

/**
 * Filesystem options for {@link writeFileAtomic}; `mode` is required so the
 * permission decision stays visible at every call site.
 */
export interface WriteFileAtomicOptions {
  /**
   * Permission bits stamped on the fresh temp inode and carried through the
   * rename (subject to the process umask, like every fresh inode).
   */
  mode: number
  /**
   * Permission bits for parent directories this call creates (subject to the
   * umask; existing directories keep their mode). Omission uses the mkdir
   * default — pass `0o700` when the tree holds user-private data.
   */
  dirMode?: number
}

/**
 * Replace `filename` with `content` in one atomic step, creating parent
 * directories. The content is first written to a random-suffix sibling opened
 * with exclusive create (`wx`): the open refuses to follow a symlink planted
 * at the temp path, and the fresh inode carries `options.mode` through the
 * rename, so replacing a wider-permission file narrows it without a chmod
 * race. The rename also replaces a symlinked target itself instead of writing
 * through to its referent, and the same-directory sibling keeps the rename on
 * one filesystem. Windows replacement retries transient `EACCES`, `EBUSY`,
 * and `EPERM` failures for a bounded interval while the complete temp file
 * remains the rename source. On any remaining failure the temp file is
 * removed and the failure rethrown. Crash durability (fsync) is out of scope.
 * @param filename - final path receiving the content.
 * @param content - complete next file content.
 * @param options - permission bits for the replacement inode.
 */
export async function writeFileAtomic(filename: string, content: string, options: WriteFileAtomicOptions): Promise<void> {
  await mkdir(dirname(filename), {
    recursive: true,
    ...options.dirMode === undefined ? {} : { mode: options.dirMode },
  })
  // TODO(settings-atomic-durability): Use a replacement that fsyncs the file
  // and parent directory and preserves owner-only permissions on Windows.
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, content, { mode: options.mode, flag: 'wx' })
    await renameAtomicTemp(temp, filename)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Whether an exclusive create found an existing lock. */
async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    // Keep the original EPERM authoritative when lock existence is unproven.
    return false
  }
}

/** One read of a lock file: its content and when that file was last written. */
interface LockRecord {
  /** The lock file's content; a complete one is `<pid>\n`. */
  readonly text: string
  /** Last modification time of the file the content came from, in epoch milliseconds. */
  readonly modifiedAt: number
}

/**
 * Acquisitions of each lock in this module instance, keyed by the resolved lock
 * path: one count per {@link withFileLock} call from just before it tries to
 * create the lock until it has removed it, so a lock this instance is creating
 * or holds is never mistaken for one an earlier process left behind.
 */
const localAcquisitions = new Map<string, number>()

/** Count one acquisition of `key` in this module instance. */
function enterLocal(key: string): void {
  localAcquisitions.set(key, (localAcquisitions.get(key) ?? 0) + 1)
}

/** Drop one acquisition of `key` counted by {@link enterLocal}. */
function leaveLocal(key: string): void {
  const remaining = (localAcquisitions.get(key) ?? 0) - 1
  if (remaining > 0) localAcquisitions.set(key, remaining)
  else localAcquisitions.delete(key)
}

/** Wall-clock time this process started, in epoch milliseconds, or undefined when the runtime cannot tell. */
function processStartedAt(): number | undefined {
  if (typeof process.uptime !== 'function') return undefined
  const uptime = process.uptime()
  return Number.isFinite(uptime) && uptime >= 0 ? Date.now() - uptime * 1000 : undefined
}

/**
 * Whether a lock that names this process's own PID was left by an earlier
 * process that had the same PID. A container's PID 1 restarted after a crash
 * mid-write finds its predecessor's record under its own PID, and no probe can
 * tell the two apart, so every start used to wait out the deadline and fail
 * (TCH stand, 10/10/2026: dsh restart-looped on `.credentials.yaml.lock`
 * holding `1\n`). Both must hold: no acquisition in this module instance is
 * creating or holding the lock, and the lock file was last written before this
 * process started. The first covers every lock this instance takes whatever the
 * clocks say; the second, which no writer in this process can meet, keeps the
 * locks of another copy of this package or another thread of this process,
 * which this instance cannot see.
 */
function leftByEarlierProcess(lockPath: string, record: LockRecord): boolean {
  if (localAcquisitions.has(resolve(lockPath))) return false
  const startedAt = processStartedAt()
  return startedAt !== undefined && record.modifiedAt < startedAt
}

/**
 * Whether the holder a `<pid>\n` record names is proven gone: a signal probe
 * finds no such process, or the PID is this process's own and an earlier
 * process left the lock ({@link leftByEarlierProcess}).
 */
function holderExited(lockPath: string, record: LockRecord): boolean {
  // Any other content is being written or was cut short, which proves nothing about its holder.
  if (!/^\d+\n$/.test(record.text)) return false
  const pid = Number(record.text.trim())
  // PID 0 addresses the caller's process group, and the probe accepts only positive int32 PIDs.
  if (pid === 0 || pid > 0x7fffffff) return false
  // Never probe this process's own PID: it is running, and a runtime whose probe cannot see itself
  // (the browser Worker's process shim) would report every lock of its own as abandoned.
  if (pid === process.pid) return leftByEarlierProcess(lockPath, record)
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM means the process exists under another user.
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** The lock file's content and modification time, or undefined when it cannot be read. */
async function readLockRecord(lockPath: string): Promise<LockRecord | undefined> {
  let handle: FileHandle | undefined
  try {
    handle = await open(lockPath, 'r')
    // Read first: a complete record means its writer finished, so the time stated next is that write's.
    const text = await handle.readFile('utf8')
    return { text, modifiedAt: (await handle.stat()).mtimeMs }
  } catch (error) {
    // A lock that vanished, or that Windows is still deleting, proves nothing about a holder.
    void error
    return undefined
  } finally {
    await handle?.close().catch((error: unknown) => {
      // The record is already read; a failed close changes nothing about it.
      void error
    })
  }
}

/**
 * Remove the lock when its recorded holder exited. Contenders that read the
 * same record serialize on a claim file named after it. Under the claim, the
 * claimant re-reads the lock and judges its holder again, and removes it only
 * when it still holds that record and that holder is still gone: the record's
 * holder can no longer release it, and no other contender can remove it
 * without the claim, so a removal never deletes a lock another contender
 * acquired after the dead holder's, including one whose holder reused the PID
 * (a lock this process wrote since it started is never judged gone).
 * @returns Whether this call removed the dead holder's lock.
 */
async function takeOverExitedLock(lockPath: string): Promise<boolean> {
  const record = await readLockRecord(lockPath)
  if (record === undefined || !holderExited(lockPath, record)) return false
  const claim = `${lockPath}.takeover-${createHash('sha256').update(record.text).digest('hex').slice(0, 16)}`
  try {
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    // Another contender owns the claim for this record, or Windows still deletes the claim it released.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'EPERM') return false
    throw error
  }
  try {
    const current = await readLockRecord(lockPath)
    if (current?.text !== record.text || !holderExited(lockPath, current)) return false
    try {
      await rm(lockPath, { force: true })
    } catch (error) {
      // Windows can refuse the removal while other software briefly holds the file; the next attempt retries.
      void error
      return false
    }
    return true
  } finally {
    await rm(claim, { force: true }).catch((error: unknown) => {
      // A claim left behind names a record that is no longer the lock, so it blocks no later takeover.
      void error
    })
  }
}

/**
 * Retry cadence for a contended lock. These stay robustness invariants of the
 * cross-process write protocol rather than deployment tunables: they govern how
 * often a contender asks, which no caller has a reason to vary.
 */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 200

/**
 * How long a contender waits when the caller states no limit — sized for the
 * render-and-rename cycle every call site had when this package was written.
 * Expiry fails the contender rather than guessing whether the existing lock
 * still has an owner. How long is *worth* waiting is a property of the
 * operation the lock holder runs, which is why {@link FileLockOptions.waitMs}
 * exists; the value here is the floor for an operation that does file work
 * alone.
 */
const DEFAULT_LOCK_WAIT_MS = 2_000

/** Options for one {@link withFileLock} acquisition. */
export interface FileLockOptions {
  /**
   * Maximum time to wait for the lock, in milliseconds. State one when the
   * holder's operation legitimately runs longer than file work — a credential
   * mutation that refreshes a token performs a network round trip while
   * holding the lock, and leaving the default in place would fail every other
   * writer of the same file for the duration. Waiting is productive: a
   * contender that acquires the lock afterwards re-reads the committed state.
   */
  waitMs?: number
}

/**
 * Hold the cross-process writer lock for `filename` around one operation. The
 * lock is a `wx`-created sibling (`<filename>.lock`); paired with the
 * rename-based commit of {@link writeFileAtomic}, readers stay lock-free and
 * only writers contend. `EEXIST` is contention directly; an `EPERM` is
 * contention only when a fresh `lstat` confirms the lock path exists, covering
 * Windows exclusive-create behavior. Windows retries one unconfirmed EPERM
 * because the holder can release before the probe; a repeated unconfirmed
 * permission error is rethrown. The lock records its holder's PID. A contender
 * removes the lock and retries at once when no process with that PID exists
 * (`ESRCH`), or when the PID is the contender's own, no call in this module
 * instance is creating or holding that lock, and the lock file was last written
 * before this process started: an earlier process with the same PID left it,
 * typically the previous run of a container's PID 1 that ended mid-write. Any
 * other lock is waited for: one whose holder exists under another user
 * (`EPERM`), whose record is incomplete, that this module instance holds
 * (a nested call on the same file still times out), or that names this process
 * and was written since it started (another copy of this package or another
 * thread of this process holds it). Contention backs off exponentially and
 * times out after the deadline. A holder whose PID another live process reused
 * keeps its lock until an operator removes it; the own-PID rule judges by
 * wall-clock times, so a clock stepped back past the lock's write delays that
 * takeover until the clock passes it again. Takeover proves only that the
 * recorded process exited: an operation that starts other writers must stop
 * them with it or leave its successor a way to find them. PIDs are compared on
 * the contender's host, so writers on other hosts or in other PID namespaces
 * sharing the file are unsupported and could both hold the lock. The parent
 * directory must exist.
 * @param filename - the file whose writers this lock serializes.
 * @param operation - the read-render-commit cycle to run while holding the lock.
 * @param options - acquisition options; omitted waits {@link DEFAULT_LOCK_WAIT_MS}.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export async function withFileLock<T>(
  filename: string,
  operation: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  const lockPath = `${filename}.lock`
  const key = resolve(lockPath)
  const deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS)
  let delay = LOCK_RETRY_INITIAL_MS
  let retriedUnconfirmedPermissionError = false
  for (;;) {
    // Counted before the file can exist, so no contender in this module
    // instance judges a lock this call is still creating as left behind.
    enterLocal(key)
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      leaveLocal(key)
      if (!await isLockContention(error, lockPath)) {
        // Windows can release the competing lock between exclusive create and lstat.
        if (process.platform !== 'win32'
          || (error as NodeJS.ErrnoException | null)?.code !== 'EPERM'
          || retriedUnconfirmedPermissionError) throw error
        retriedUnconfirmedPermissionError = true
      } else if (await takeOverExitedLock(lockPath)) continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    try {
      await rm(lockPath, { force: true })
    } finally {
      leaveLocal(key)
    }
  }
}
