/** A separate process keeps unsupported-platform and no-addon simulation away from other tests. */
import assert from 'node:assert/strict';

const platform = process.argv[2];
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
try {
  if (platform) Object.defineProperty(process, 'platform', { value: platform });
  const dirfd = await import('../../packages/entry/lib/dirfd.js');
  for (const name of ['openat', 'mkdirat', 'renameat', 'linkat', 'unlinkat', 'dirfdSupported']) {
    assert.equal(typeof dirfd[name], 'function');
  }
  // Without a loadable binding every call rejects and callers keep their path-based behaviour.
  assert.equal(dirfd.dirfdSupported(), false);
  const rejected = platform
    ? { code: 'ERR_DIRFD_UNSUPPORTED_PLATFORM', syscall: 'openat' }
    : (error) => error instanceof Error;
  await assert.rejects(dirfd.openat(0, 'name', 0), rejected);
  await assert.rejects(dirfd.renameat(0, 'a', 0, 'b'), rejected);
  await assert.rejects(dirfd.unlinkat(0, 'a'), rejected);
} finally {
  Object.defineProperty(process, 'platform', descriptor);
}
await new Promise((resolve, reject) => {
  process.send({ type: 'ready' }, (error) => error ? reject(error) : resolve());
});
process.disconnect();
