# Descriptor-relative file calls

`./dirfd` exports `openat`, `mkdirat`, `renameat`, `linkat`, and `unlinkat` as promises, plus `dirfdSupported()`. Each call names one entry relative to a directory descriptor the caller already holds. The kernel looks up nothing above that entry, so a directory on the caller's path swapped for a symlink after the caller verified its descriptor cannot redirect the call. Node's own `fs` has no directory-descriptor variants; `rename(2)` and `link(2)` look up the two parents separately by path, even inside one call.

The syscalls run off the JavaScript thread in asynchronous work that captures errno on the worker. The caller owns every descriptor passed in and the descriptor `openat` returns. The binding closes a descriptor only when it opened one for an environment that terminated before the result could be delivered.

## Inputs checked in C

| Input | Rule | Failure |
|---|---|---|
| Directory descriptor | Non-negative C int; `AT_FDCWD` and working-directory lookups are unreachable | `RangeError`, or `TypeError` for a non-number |
| Name | One path component: not empty, not `.` or `..`, no `/`, no NUL | `TypeError` with `code: 'ERR_INVALID_ARG_VALUE'` (`ERR_INVALID_ARG_TYPE` for a non-string) |
| `openat` flags | Host `fs.constants` values; `O_CLOEXEC` is always added | `RangeError` outside a C int |
| Mode | `0..0o7777` | `RangeError` |

Validation failures reject the returned promise; the entry never throws synchronously.

## Behavior tests

The [native tests](../test/dirfd.test.js) exercise real descriptors and directory trees.

| Condition | Required observation |
|---|---|
| Native addons disabled | Import succeeds; `dirfdSupported()` is false and every call rejects |
| Windows or another unsupported platform | Calls reject with `ERR_DIRFD_UNSUPPORTED_PLATFORM` without loading an addon |
| `openat` with `O_CREAT \| O_EXCL` | Creates the file with the requested mode; a second create rejects with `EEXIST` |
| `openat` with `O_NOFOLLOW` on a symlink | Rejects with `ELOOP` (or `EEXIST` with `O_EXCL`); the symlink target is untouched |
| `openat` of a child directory | The descriptor serves further relative calls |
| Invalid names, for every call | Rejected before any syscall; the directory is unchanged |
| Negative, `AT_FDCWD`, non-integer, or out-of-range descriptors | Rejected before any syscall |
| A descriptor that is not open | Rejects with `EBADF`, positive errno, and the call's `syscall` name |
| The held directory's path becomes a symlink to another directory | `openat` and `renameat` through the held descriptor land in the original directory; the other directory is unchanged |
| `renameat` between two held directories | Moves the entry and replaces an existing file; a missing source rejects with `ENOENT`, `path`, and `dest` |
| `linkat` onto an existing name | Rejects with `EEXIST` and leaves that entry; a symlink is linked as itself |
| `mkdirat` | Creates the directory with the requested mode; an existing name rejects with `EEXIST` |
| `unlinkat` | Removes a file; a directory needs `{ directory: true }` and must be empty |
| Concurrent calls | Each completion receives its own errno and result |
| Native completion callback | Receives `(errno, result)` asynchronously |
| Native completion callback throws | The exception reaches Node's uncaught-exception handler |

## Consumer

`@deepseek-ai/dsh-fs-local` publishes atomic writes through these calls on Linux: it opens the target's parent with `O_DIRECTORY | O_NOFOLLOW`, requires `/proc/self/fd/<fd>` to name the canonical parent, then creates the staging directory, the temp file, the published entry, and the cleanup relative to that descriptor. Without `/proc/self/fd` or a loadable binding it keeps its path-based publication.

## Limits

A held directory that is moved (not replaced by a symlink) takes the call with it: the descriptor names the directory object, not its former path. The calls are POSIX and build on macOS too; the Harness uses them only where `/proc/self/fd` can verify the descriptor first. Windows has no platform package for this addon.
