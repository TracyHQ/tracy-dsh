/** Kernel behavior through the built dirfd entry; each case owns its directory tree. */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import {
  closeSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dirfdSupported, linkat, mkdirat, openat, renameat, unlinkat } from '../packages/entry/lib/dirfd.js';
import { loadFlockBinding } from './fixtures/flock-binding.js';

const posix = process.platform === 'linux' || process.platform === 'darwin';
const timeout = 120_000;
const nativeOnly = { timeout, skip: posix ? false : 'The dirfd addon requires Linux or macOS' };
const { O_CREAT, O_EXCL, O_WRONLY, O_RDONLY, O_NOFOLLOW, O_DIRECTORY } = fsConstants;
const CREATE_NEW = O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW;
const OPEN_DIR = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
// A descriptor number no test process holds.
const UNUSED_FD = 2 ** 30;

function scope(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'node-addon-system-dirfd-')));
  const fds = [];
  t.after(() => {
    for (const fd of fds.reverse()) {
      try { closeSync(fd); } catch { /* already closed by the case */ }
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    dir(name) {
      const path = join(root, name);
      mkdirSync(path, { recursive: true });
      return path;
    },
    openDir(path) {
      const fd = openSync(path, OPEN_DIR);
      fds.push(fd);
      return fd;
    },
    own(fd) {
      fds.push(fd);
      return fd;
    },
  };
}

function syscallError(syscall, codes) {
  return (error) => {
    assert.ok(codes.includes(error.code), `Unexpected ${syscall} error: ${error.code}`);
    assert.equal(error.errno, constants.errno[error.code]);
    assert.ok(error.errno > 0);
    assert.equal(error.syscall, syscall);
    return true;
  };
}

async function childFixture(t, fixture, args, execArgv) {
  const child = fork(new URL(`./fixtures/${fixture}`, import.meta.url), args, {
    execArgv,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD/i.test(name))),
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'close');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [code, signal] = await exited;
  return { code, signal, stderr };
}

test('import succeeds with native addons disabled, and every call rejects', { timeout }, async (t) => {
  const exit = await childFixture(t, 'dirfd-import.js', [], ['--no-addons']);
  assert.equal(exit.signal, null, exit.stderr);
  assert.equal(exit.code, 0, exit.stderr);
});

for (const platform of ['win32', 'freebsd']) {
  test(`calling dirfd on ${platform} rejects without loading an addon`, { timeout }, async (t) => {
    const exit = await childFixture(t, 'dirfd-import.js', [platform], ['--no-addons']);
    assert.equal(exit.signal, null, exit.stderr);
    assert.equal(exit.code, 0, exit.stderr);
  });
}

test('the built addon carries the dirfd calls', nativeOnly, () => {
  assert.equal(dirfdSupported(), true);
});

test('openat creates a new file exclusively with the requested mode and refuses a second create', nativeOnly, async (t) => {
  const s = scope(t);
  const dir = s.dir('d');
  const dirfd = s.openDir(dir);
  const fd = s.own(await openat(dirfd, 'f.tmp', CREATE_NEW, 0o600));
  assert.ok(Number.isInteger(fd) && fd >= 0);
  writeFileSync(fd, 'through the descriptor');
  assert.equal(readFileSync(join(dir, 'f.tmp'), 'utf8'), 'through the descriptor');
  assert.equal(statSync(join(dir, 'f.tmp')).mode & 0o777, 0o600);
  await assert.rejects(openat(dirfd, 'f.tmp', CREATE_NEW, 0o600), (error) => {
    syscallError('openat', ['EEXIST'])(error);
    assert.equal(error.path, 'f.tmp');
    return true;
  });
});

test('openat with O_NOFOLLOW refuses a final symlink', nativeOnly, async (t) => {
  const s = scope(t);
  const dir = s.dir('d');
  const outside = s.dir('outside');
  writeFileSync(join(outside, 'secret'), 'outside');
  symlinkSync(join(outside, 'secret'), join(dir, 'link'));
  const dirfd = s.openDir(dir);
  await assert.rejects(openat(dirfd, 'link', O_RDONLY | O_NOFOLLOW), syscallError('openat', ['ELOOP']));
  await assert.rejects(openat(dirfd, 'link', CREATE_NEW, 0o600), syscallError('openat', ['EEXIST', 'ELOOP']));
  assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'outside');
});

test('openat opens a child directory as a descriptor for further relative calls', nativeOnly, async (t) => {
  const s = scope(t);
  const dir = s.dir('d');
  mkdirSync(join(dir, 'child'));
  const dirfd = s.openDir(dir);
  const childfd = s.own(await openat(dirfd, 'child', OPEN_DIR));
  s.own(await openat(childfd, 'inner', CREATE_NEW, 0o600));
  assert.deepEqual(readdirSync(join(dir, 'child')), ['inner']);
});

test('names must be one path component, checked before any syscall', nativeOnly, async (t) => {
  const s = scope(t);
  const dir = s.dir('d');
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'file'), 'kept');
  const dirfd = s.openDir(dir);
  const invalid = { name: 'TypeError', code: 'ERR_INVALID_ARG_VALUE' };
  for (const name of ['', '.', '..', 'sub/x', '/abs', 'a\0b', '../file']) {
    await assert.rejects(openat(dirfd, name, CREATE_NEW, 0o600), invalid, JSON.stringify(name));
    await assert.rejects(mkdirat(dirfd, name, 0o700), invalid, JSON.stringify(name));
    await assert.rejects(renameat(dirfd, 'file', dirfd, name), invalid, JSON.stringify(name));
    await assert.rejects(renameat(dirfd, name, dirfd, 'other'), invalid, JSON.stringify(name));
    await assert.rejects(linkat(dirfd, 'file', dirfd, name), invalid, JSON.stringify(name));
    await assert.rejects(unlinkat(dirfd, name), invalid, JSON.stringify(name));
    await assert.rejects(unlinkat(dirfd, name, { directory: true }), invalid, JSON.stringify(name));
  }
  await assert.rejects(openat(dirfd, 42, CREATE_NEW, 0o600), { name: 'TypeError', code: 'ERR_INVALID_ARG_TYPE' });
  assert.deepEqual(readdirSync(dir).sort(), ['file', 'sub']);
  assert.deepEqual(readdirSync(join(dir, 'sub')), []);
  assert.equal(readFileSync(join(dir, 'file'), 'utf8'), 'kept');
});

test('directory descriptors must be non-negative C ints; AT_FDCWD is unreachable', nativeOnly, async (t) => {
  const s = scope(t);
  const range = { name: 'RangeError', message: 'dirfd must be a non-negative C int' };
  for (const fd of [-1, -100, 2 ** 31, 1.5, Number.NaN]) {
    await assert.rejects(openat(fd, 'x', CREATE_NEW, 0o600), range, String(fd));
    await assert.rejects(renameat(0, 'x', fd, 'y'), range, String(fd));
  }
  await assert.rejects(openat('3', 'x', CREATE_NEW, 0o600), { name: 'TypeError', message: 'dirfd must be a number' });
  await assert.rejects(openat(s.openDir(s.root), 'x', CREATE_NEW, 0o70000), { name: 'RangeError' });
  assert.equal(existsSync(join(process.cwd(), 'x')), false);
});

test('a descriptor that is not open rejects with EBADF and positive errno', nativeOnly, async () => {
  await assert.rejects(openat(UNUSED_FD, 'x', CREATE_NEW, 0o600), syscallError('openat', ['EBADF']));
  await assert.rejects(mkdirat(UNUSED_FD, 'x', 0o700), syscallError('mkdirat', ['EBADF']));
  await assert.rejects(renameat(UNUSED_FD, 'x', UNUSED_FD, 'y'), syscallError('renameat', ['EBADF']));
  await assert.rejects(linkat(UNUSED_FD, 'x', UNUSED_FD, 'y'), syscallError('linkat', ['EBADF']));
  await assert.rejects(unlinkat(UNUSED_FD, 'x'), syscallError('unlinkat', ['EBADF']));
});

test('renameat publishes into the directory the descriptor holds after its path became a symlink', nativeOnly, async (t) => {
  const s = scope(t);
  const dir = s.dir('site/d');
  const parked = join(s.root, 'site', 'd.parked');
  const outside = s.dir('outside');
  writeFileSync(join(outside, 'f.txt'), 'OUTSIDE');
  const dirfd = s.openDir(dir);
  // The directory moves away and its path now leads outside; the held descriptor does not follow.
  renameSync(dir, parked);
  symlinkSync(outside, dir);
  const fd = await openat(dirfd, 'f.tmp', CREATE_NEW, 0o600);
  writeFileSync(fd, 'published');
  closeSync(fd);
  await renameat(dirfd, 'f.tmp', dirfd, 'f.txt');
  assert.equal(readFileSync(join(parked, 'f.txt'), 'utf8'), 'published');
  assert.deepEqual(readdirSync(parked), ['f.txt']);
  assert.deepEqual(readdirSync(outside), ['f.txt']);
  assert.equal(readFileSync(join(outside, 'f.txt'), 'utf8'), 'OUTSIDE');
});

test('renameat moves between two held directories and replaces an existing file', nativeOnly, async (t) => {
  const s = scope(t);
  const from = s.dir('from');
  const to = s.dir('to');
  writeFileSync(join(from, 'a'), 'new');
  writeFileSync(join(to, 'b'), 'old');
  await renameat(s.openDir(from), 'a', s.openDir(to), 'b');
  assert.deepEqual(readdirSync(from), []);
  assert.equal(readFileSync(join(to, 'b'), 'utf8'), 'new');
  await assert.rejects(renameat(s.openDir(from), 'a', s.openDir(to), 'c'), (error) => {
    syscallError('renameat', ['ENOENT'])(error);
    assert.equal(error.path, 'a');
    assert.equal(error.dest, 'c');
    return true;
  });
});

test('linkat never replaces an existing entry and links a symlink as itself', nativeOnly, async (t) => {
  const s = scope(t);
  const dir = s.dir('d');
  const outside = s.dir('outside');
  writeFileSync(join(dir, 'src'), 'ours');
  writeFileSync(join(dir, 'taken'), 'theirs');
  writeFileSync(join(outside, 'secret'), 'outside');
  symlinkSync(join(outside, 'secret'), join(dir, 'link'));
  const dirfd = s.openDir(dir);
  await linkat(dirfd, 'src', dirfd, 'dst');
  assert.equal(statSync(join(dir, 'dst')).ino, statSync(join(dir, 'src')).ino);
  await assert.rejects(linkat(dirfd, 'src', dirfd, 'taken'), syscallError('linkat', ['EEXIST']));
  assert.equal(readFileSync(join(dir, 'taken'), 'utf8'), 'theirs');
  await linkat(dirfd, 'link', dirfd, 'link2');
  assert.equal(lstatSync(join(dir, 'link2')).isSymbolicLink(), true);
  assert.notEqual(lstatSync(join(dir, 'link2')).ino, statSync(join(outside, 'secret')).ino);
});

test('mkdirat creates a directory with the requested mode and refuses an existing name', nativeOnly, async (t) => {
  const s = scope(t);
  const dir = s.dir('d');
  const dirfd = s.openDir(dir);
  await mkdirat(dirfd, 'staging', 0o700);
  assert.equal(statSync(join(dir, 'staging')).isDirectory(), true);
  assert.equal(statSync(join(dir, 'staging')).mode & 0o777, 0o700);
  await assert.rejects(mkdirat(dirfd, 'staging', 0o700), syscallError('mkdirat', ['EEXIST']));
});

test('unlinkat removes a file, an empty directory only with the directory option, and reports errno', nativeOnly, async (t) => {
  const s = scope(t);
  const dir = s.dir('d');
  writeFileSync(join(dir, 'file'), 'x');
  mkdirSync(join(dir, 'empty'));
  mkdirSync(join(dir, 'full'));
  writeFileSync(join(dir, 'full', 'inner'), 'x');
  const dirfd = s.openDir(dir);
  await unlinkat(dirfd, 'file');
  await assert.rejects(unlinkat(dirfd, 'file'), syscallError('unlinkat', ['ENOENT']));
  await assert.rejects(unlinkat(dirfd, 'empty'), syscallError('unlinkat', ['EISDIR', 'EPERM']));
  await unlinkat(dirfd, 'empty', { directory: true });
  await assert.rejects(unlinkat(dirfd, 'full', { directory: true }), syscallError('unlinkat', ['ENOTEMPTY', 'EEXIST']));
  assert.deepEqual(readdirSync(dir), ['full']);
});

test('concurrent calls retain their own syscall errno and result', nativeOnly, async (t) => {
  const s = scope(t);
  const dir = s.dir('d');
  writeFileSync(join(dir, 'exists'), 'x');
  const dirfd = s.openDir(dir);
  const [first, , second] = await Promise.all([
    openat(dirfd, 'one', CREATE_NEW, 0o600),
    assert.rejects(openat(dirfd, 'exists', CREATE_NEW, 0o600), syscallError('openat', ['EEXIST'])),
    openat(dirfd, 'two', CREATE_NEW, 0o600),
    assert.rejects(unlinkat(dirfd, 'missing'), syscallError('unlinkat', ['ENOENT'])),
    assert.rejects(openat(UNUSED_FD, 'x', CREATE_NEW, 0o600), syscallError('openat', ['EBADF'])),
  ]);
  s.own(first);
  s.own(second);
  assert.notEqual(first, second);
  assert.deepEqual(readdirSync(dir).sort(), ['exists', 'one', 'two']);
});

test('native callbacks receive asynchronous (errno, result) pairs', nativeOnly, async (t) => {
  const s = scope(t);
  const dirfd = s.openDir(s.dir('d'));
  const binding = loadFlockBinding();
  const [opened, missing] = await Promise.all([
    new Promise((resolve) => {
      let returned = false;
      assert.equal(binding.openat(dirfd, 'f', CREATE_NEW, 0o600, (errno, fd) => {
        assert.equal(returned, true);
        resolve([errno, fd]);
      }), undefined);
      returned = true;
    }),
    new Promise((resolve) => binding.unlinkat(dirfd, 'missing', false, (errno, result) => resolve([errno, result]))),
  ]);
  assert.equal(opened[0], 0);
  s.own(opened[1]);
  assert.ok(opened[1] >= 0);
  assert.deepEqual(missing, [constants.errno.ENOENT, 0]);
});

test('an exception in the native completion callback is reported as uncaught', nativeOnly, async (t) => {
  const exit = await childFixture(t, 'dirfd-callback-throws.js', [], []);
  assert.equal(exit.signal, null, exit.stderr);
  assert.equal(exit.code, 1, exit.stderr);
  assert.match(exit.stderr, /Error: dirfd callback failure/);
});
