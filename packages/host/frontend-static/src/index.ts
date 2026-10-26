/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: serves the built frontend directory with explicit index
 * entry points. A readable index renders at the dist root and configured index
 * path; missing paths return 404, traversal outside the dist root is 403,
 * unknown extensions ship as octet-stream, and non-GET/HEAD is 405. Every
 * index response first passes Connection's browser authentication, then the
 * webserver's index render (structured injection rows, then raw taps).
 * Non-index assets stay public. The dist location is workspace knowledge of
 * the composing application, so `distIndex` is typically supplied through a
 * `!!js` expression, never hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import type { ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Services required before the authenticated fallback seat can be claimed. */
export const inject = ['webServer', 'connection']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const HTML_MIME = 'text/html; charset=utf-8'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  // The packed VFS image. Served as its own bytes, never as a Content-Encoding:
  // the worker inflates the body itself, and a transport-level encoding would
  // leave it inflating an already-decoded archive.
  '.gz': 'application/gzip',
}

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param authorizeIndex - authenticates an index response before its bytes are read.
 * @param renderIndex - produces the index.html body (structured injection
 * rendering) for the dist root and configured index path.
 */
export async function serveStatic(
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  authorizeIndex: () => boolean,
  renderIndex: () => Promise<string>,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  let body: string | Buffer
  let type: string
  try {
    if (target === distRoot || target === distIndex) {
      if (!authorizeIndex()) return
      body = await renderIndex()
      type = HTML_MIME
    } else {
      body = await readFile(target)
      type = MIME[extname(target)] ?? 'application/octet-stream'
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the webserver's request-failure handling.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': type })
  res.end(body)
}

/**
 * Claim the webserver fallback seat and serve the dist.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  // Insert after all index transforms so the base precedes every resource reference.
  // Tracy: the base is the absolute mount (`/` at the root, `/site.example/` under a
  // prefix the webserver stripped), not upstream's `./`. Upstream freezes the entry
  // directory and supports only the dist root as an entry; Tracy also serves the
  // shell at `s/<id>` (the session on the address bar), and a reload there would
  // resolve `./` to `/s/`, where no route answers. Document-relative routes
  // (`api/x`, `plugins/x`) resolve against this base to the same place.
  /**
   * Brand the boot page from the served HTML, before any plugin exists.
   *
   * WHY IT CANNOT BE DONE FROM A PLUGIN. `BootPage` is painted by the kernel on the first frame,
   * and plugins load after it — a plugin stylesheet arrives when the splash is already on screen
   * and about to leave, so the wordmark still flashes. The only stylesheet early enough is one
   * inlined into the document itself.
   *
   * It restyles rather than replaces: the boot page keeps its element, its progress states and
   * its failure report, all of which the kernel still drives. Only the identity changes — the
   * DeepSeek wordmark and the "Loading plugins" hint are hidden, and the spinner becomes Tracy's
   * mark turning. `data-dsh-boot` and `data-dsh-boot-spinner` are the kernel's own attributes,
   * placed for exactly this, so nothing here depends on a hashed CSS-module class.
   *
   * The mark and its 9s turn match `@tracy/dsh-brand`'s boot cover, which takes over the instant
   * plugins mount: two layers, one continuous screen from F5 to a usable UI.
   */
  const BOOT_STYLE = [
    '<style data-tracy-boot>',
    '[data-dsh-boot] > * > :not([data-dsh-boot-spinner]) { display: none !important; }',
    '[data-dsh-boot] [data-dsh-boot-spinner] {',
    '  width: 40px; height: 40px; border: 0 !important; animation: tracy-boot-spin 9s linear infinite;',
    "  background: no-repeat center/contain url('data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%3E%3Cg%20stroke%3D%22%23BF5B3D%22%20stroke-width%3D%221.1%22%20stroke-linecap%3D%22round%22%3E%3Cpath%20d%3D%22M12%201.6v6M12%2016.4v6M1.6%2012h6M16.4%2012h6M4.6%204.6l4.3%204.3M15.1%2015.1l4.3%204.3M19.4%204.6l-4.3%204.3M8.9%2015.1l-4.3%204.3%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2212%22%20r%3D%221.5%22%20fill%3D%22%23BF5B3D%22%2F%3E%3C%2Fsvg%3E');",
    '}',
    '@keyframes tracy-boot-spin { to { transform: rotate(360deg) } }',
    '@media (prefers-reduced-motion: reduce) { [data-dsh-boot] [data-dsh-boot-spinner] { animation: none } }',
    '</style>'
  ].join('')

  const renderIndex = async (mount: string): Promise<string> => {
    const body = ctx.webServer.renderIndex(await readFile(distIndex, 'utf8'))
    return body.replace(
      /<head(?:\s[^>]*)?>/i,
      open => `${open}<base href="${mount}/">${BOOT_STYLE}`
    )
  }
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const mount = ctx.webServer.mountOf(req)
    // `s/<sessionId>` is the shell's own address space — the session on the address bar (see
    // ui-workspace's url-state). It is served as the index, so a pasted link, a reload or a
    // Back lands on the page that then selects the session it names. No dots in the segment: a
    // missing asset is still an empty 404, never the shell parsed as JavaScript.
    const shellAddress = /^\/s\/[A-Za-z0-9_-]+\/?$/.test(rawPath)
    await serveStatic(
      shellAddress ? '/' : decodeURIComponent(rawPath),
      res,
      distRoot,
      distIndex,
      () => ctx.connection.authorizeIndex(req, res, mount),
      () => renderIndex(mount),
    )
  }), 'frontend-static: fallback seat')
}
