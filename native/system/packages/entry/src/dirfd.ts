/**
 * Lazy descriptor-relative file calls; importing this entry does not load a native addon.
 *
 * Each call names one entry relative to a directory descriptor the caller holds, so the
 * kernel looks up nothing above that entry: a directory on the caller's path swapped for a
 * symlink after the caller verified the descriptor cannot redirect the call. Names must be one
 * path component (not empty, `.`, `..`, or containing `/` or NUL) and directory descriptors must
 * be non-negative; both are checked in C. The caller owns every descriptor, including the one
 * {@link openat} returns.
 */
import { getSystemErrorName } from 'node:util'
import { loadSystemBinding } from './binding.js'

type Callback = (errno: number, result: number) => void

interface DirfdBinding {
  openat(dirfd: number, name: string, flags: number, mode: number, callback: Callback): void
  mkdirat(dirfd: number, name: string, mode: number, callback: Callback): void
  renameat(oldDirfd: number, oldName: string, newDirfd: number, newName: string, callback: Callback): void
  linkat(oldDirfd: number, oldName: string, newDirfd: number, newName: string, callback: Callback): void
  unlinkat(dirfd: number, name: string, directory: boolean, callback: Callback): void
}

function loadBinding(): DirfdBinding {
  const binding = loadSystemBinding('dirfd', 'openat')
  if (typeof binding.openat !== 'function') {
    throw Object.assign(new Error('system.node predates the dirfd calls'), {
      code: 'ERR_DIRFD_BINDING_OUTDATED',
      syscall: 'openat',
    })
  }
  return binding as unknown as DirfdBinding
}

/**
 * Whether this host can make the descriptor-relative calls: a supported platform whose
 * `system.node` loads and carries them. Callers keep their path-based behaviour otherwise.
 * @returns true when every call in this entry can reach the kernel.
 */
export function dirfdSupported(): boolean {
  try {
    loadBinding()
    return true
  } catch (_unavailable) {
    return false
  }
}

async function call(
  syscall: string,
  paths: { path: string; dest?: string },
  start: (binding: DirfdBinding, callback: Callback) => void,
): Promise<number> {
  const [errno, result] = await new Promise<[number, number]>((resolve) => {
    start(loadBinding(), (code, value) => resolve([code, value]))
  })
  if (errno === 0) return result
  const code = getSystemErrorName(-errno)
  const spelled = paths.dest === undefined ? `'${paths.path}'` : `'${paths.path}' -> '${paths.dest}'`
  throw Object.assign(new Error(`${code}: ${syscall} failed, ${spelled}`), {
    code,
    errno,
    syscall,
    ...paths,
  })
}

/**
 * Open `name` relative to `dirfd`. The binding always adds `O_CLOEXEC`; pass `O_NOFOLLOW` to
 * refuse a final symlink and `O_CREAT | O_EXCL` to create a new file only.
 * @param dirfd - open directory descriptor; ownership stays with the caller.
 * @param name - one path component.
 * @param flags - `fs.constants` open flags for this host.
 * @param mode - permission bits for a created file (0..0o7777).
 * @returns a new descriptor the caller must close.
 */
export function openat(dirfd: number, name: string, flags: number, mode = 0o666): Promise<number> {
  return call('openat', { path: name }, (binding, callback) => binding.openat(dirfd, name, flags, mode, callback))
}

/**
 * Create directory `name` relative to `dirfd`.
 * @param dirfd - open directory descriptor; ownership stays with the caller.
 * @param name - one path component.
 * @param mode - permission bits before the process umask (0..0o7777).
 */
export async function mkdirat(dirfd: number, name: string, mode = 0o777): Promise<void> {
  await call('mkdirat', { path: name }, (binding, callback) => binding.mkdirat(dirfd, name, mode, callback))
}

/**
 * Atomically rename `oldName` under `oldDirfd` to `newName` under `newDirfd`, replacing an
 * existing non-directory entry there.
 * @param oldDirfd - directory descriptor holding the source entry.
 * @param oldName - one path component.
 * @param newDirfd - directory descriptor receiving the entry.
 * @param newName - one path component.
 */
export async function renameat(oldDirfd: number, oldName: string, newDirfd: number, newName: string): Promise<void> {
  await call('renameat', { path: oldName, dest: newName },
    (binding, callback) => binding.renameat(oldDirfd, oldName, newDirfd, newName, callback))
}

/**
 * Hard-link `oldName` under `oldDirfd` as `newName` under `newDirfd`; never replaces an
 * existing entry (`EEXIST`) and links a symlink as itself.
 * @param oldDirfd - directory descriptor holding the source entry.
 * @param oldName - one path component.
 * @param newDirfd - directory descriptor receiving the link.
 * @param newName - one path component.
 */
export async function linkat(oldDirfd: number, oldName: string, newDirfd: number, newName: string): Promise<void> {
  await call('linkat', { path: oldName, dest: newName },
    (binding, callback) => binding.linkat(oldDirfd, oldName, newDirfd, newName, callback))
}

/**
 * Remove `name` relative to `dirfd`: a non-directory entry, or with `directory` an empty directory.
 * @param dirfd - open directory descriptor; ownership stays with the caller.
 * @param name - one path component.
 * @param options - `directory: true` removes an empty directory (`AT_REMOVEDIR`).
 */
export async function unlinkat(dirfd: number, name: string, options: { directory?: boolean } = {}): Promise<void> {
  const directory = options.directory === true
  await call('unlinkat', { path: name }, (binding, callback) => binding.unlinkat(dirfd, name, directory, callback))
}
