/**
 * Where dsh's root is, as seen from the page — the one place a browser-side
 * caller turns a root-relative dsh path (`/api/…`, `/plugins/…`) into a URL.
 *
 * dsh registers every route at its own root, but a reverse proxy may publish
 * that root under a path (`https://host/<site>/`). The served index says so
 * with a `<base href>` (see `@deepseek-ai/dsh-host-frontend-static`), and
 * that tag is the only thing that carries the mount to the browser: a URL
 * built from `location.origin` lands on the host's root, where nothing of
 * dsh's is listening. Without a `<base>` the page is at the root and the
 * origin is right, as it always was; without a page at all (a worker-less
 * test, a non-browser caller) the internal placeholder origin stands in.
 */

/** The origin used when no browser location is available. */
export const INTERNAL_BASE = 'http://dsh.internal'

/** The page's `<base href>` when it has one, else its origin — always ending in `/`. */
export function pageBase(): string {
  const base = (globalThis as { document?: { querySelector?: (selector: string) => { href?: string } | null } })
    .document?.querySelector?.('base[href]')?.href
  if (typeof base === 'string' && /^https?:\/\//.test(base)) return base.endsWith('/') ? base : `${base}/`
  const location = (globalThis as { location?: { origin?: string } }).location
  const origin = location?.origin !== undefined && location.origin !== 'null' ? location.origin : INTERNAL_BASE
  return `${origin}/`
}

/**
 * Resolve a root-relative dsh path against {@link pageBase}.
 * @param path - a path as dsh registers it, `/api/session.list` — leading slashes are dropped
 * so it resolves under the mount rather than at the host's root.
 * @returns the absolute URL to call.
 */
export function dshUrl(path: string): URL {
  return new URL(path.replace(/^\/+/, ''), pageBase())
}
