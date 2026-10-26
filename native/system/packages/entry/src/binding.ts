/** Lazy loader for this host's `system.node`, shared by the capability entries. */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

let binding: Record<string, unknown> | undefined

/**
 * Load the platform package's `system.node` once per process.
 * @param capability - entry name used in the unsupported-platform error code (`ERR_<NAME>_UNSUPPORTED_PLATFORM`).
 * @param syscall - syscall name the unsupported-platform error carries.
 * @returns the addon's exports.
 * @throws on Windows and other hosts without a platform package, or when the
 *   platform package or its addon cannot be resolved or loaded.
 */
export function loadSystemBinding(capability: string, syscall: string): Record<string, unknown> {
  const { platform, arch } = process
  if (platform !== 'linux' && platform !== 'darwin') {
    throw Object.assign(new Error(`${capability} is not supported on ${platform}-${arch}`), {
      code: `ERR_${capability.toUpperCase()}_UNSUPPORTED_PLATFORM`,
      syscall,
    })
  }
  if (binding) return binding

  let filename = 'system.node'
  if (platform === 'linux') {
    // Node's report types omit the libc field supplied by Linux reports.
    const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } }
    filename = join(report.header.glibcVersionRuntime ? 'glibc' : 'musl', filename)
  }
  const require = createRequire(import.meta.url)
  const manifest = require.resolve(`@deepseek-ai/node-addon-system-${platform}-${arch}/package.json`)
  binding = require(join(dirname(manifest), 'bin', filename)) as Record<string, unknown>
  return binding
}
