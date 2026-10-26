---
description: "JavaScript entry for the prebuilt Landlock launcher, asynchronous POSIX flock, and descriptor-relative file calls."
kind: "package-library"
---
# @deepseek-ai/node-addon-system

English | [中文](README.zh.md)

The `./landlock-run` entry exports the Landlock launcher path, enforcement probe, grant arguments, and protocol constants. The independent `./flock` entry exports `tryLockExclusive(fd): Promise<void>`, and the `./dirfd` entry exports descriptor-relative `openat`, `mkdirat`, `renameat`, `linkat`, `unlinkat`, and `dirfdSupported()`; importing any entry does not load `system.node`. The package has no root export.

The lock operation attempts `LOCK_EX | LOCK_NB` asynchronously. Keep the caller-owned descriptor open until completion; contention rejects with `EAGAIN`/`EWOULDBLOCK`, other syscall failures also reject, and errors carry their code, positive errno, and `syscall: 'flock'`. Native setup errors reject the same promise. Closing the last descriptor for the open file description releases the lock. The binding does not open, duplicate, close, or explicitly unlock descriptors.

Each dirfd call names one path component (not empty, `.`, `..`, or containing `/` or NUL) relative to a non-negative directory descriptor, checked in C, and runs in asynchronous work. `openat` always adds `O_CLOEXEC` and returns a descriptor the caller owns. Syscall failures reject with code, positive errno, `syscall`, and `path` (plus `dest` for `renameat`/`linkat`). A missing binding rejects each call and makes `dirfdSupported()` false. See the [dirfd contract](../../docs/dirfd-contract.md).

Optional OS/CPU platform packages carry the binaries. Their `~x.y.z` dependency ranges allow later patches within the same minor version. Linux has `bin/landlock-run` and separate `bin/glibc/system.node` / `bin/musl/system.node`; macOS has `bin/system.node`. Missing or unloadable bindings reject flock acquisition and dirfd calls, without installation-time compilation. Landlock remains a separate executable with its existing fail-closed protocol; unsupported kernels/platforms probe unusable.

The C sources (`main.c` for Landlock; `addon.c`, `system.h`, `flock.c`, and `dirfd.c` for `system.node`) ship for auditability. See the workspace [architecture](../../docs/architecture.md), [support matrix](../../docs/support-matrix.md), and [CLI contract](../../docs/cli-contract.md).
