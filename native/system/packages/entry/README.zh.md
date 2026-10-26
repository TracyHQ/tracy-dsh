---
description: "预编译 Landlock 启动器、异步 POSIX flock 与基于描述符的文件调用的 JavaScript 入口。"
kind: "package-library"
---
# @deepseek-ai/node-addon-system

[English](README.md) | 中文

`./landlock-run` 入口导出 Landlock 启动器路径、强制执行探测、授权参数和协议常量。独立的 `./flock` 入口导出 `tryLockExclusive(fd): Promise<void>`，`./dirfd` 入口导出基于描述符的 `openat`、`mkdirat`、`renameat`、`linkat`、`unlinkat` 和 `dirfdSupported()`；导入任何入口都不会加载 `system.node`。包不提供根导出。

锁操作异步尝试 `LOCK_EX | LOCK_NB`。在完成前保持调用方拥有的描述符打开；竞争以 `EAGAIN`/`EWOULDBLOCK` 拒绝，其他系统调用失败也会拒绝，错误携带 code、值为正数的 errno 和 `syscall: 'flock'`。原生调用准备阶段的错误也会拒绝同一个 promise。关闭指向该打开文件描述的最后一个描述符即释放锁。绑定不打开、复制、关闭或显式解锁描述符。

每个 dirfd 调用都相对于非负目录描述符命名单个路径组件（不能为空、`.`、`..`，也不能包含 `/` 或 NUL），由 C 代码校验，并在异步任务中执行。`openat` 总是附加 `O_CLOEXEC`，返回的描述符归调用方所有。系统调用失败时以携带 code、值为正数的 errno、`syscall` 和 `path`（`renameat`/`linkat` 另有 `dest`）的错误拒绝。绑定缺失时每个调用都会拒绝，且 `dirfdSupported()` 为 false。参见 [dirfd 约定](../../docs/dirfd-contract.md)。

可选操作系统/CPU 平台包携带二进制。它们的 `~x.y.z` 依赖范围允许同一次版本内的后续补丁版本。Linux 包含 `bin/landlock-run` 和分别用于两种 libc 的 `bin/glibc/system.node` / `bin/musl/system.node`；macOS 包含 `bin/system.node`。绑定缺失或无法加载时，flock 获取请求和 dirfd 调用都会被拒绝，不在安装时编译。Landlock 仍是遵循既有失败关闭协议的独立可执行文件；不支持的内核或平台探测结果为不可用。

C 源文件（Landlock 的 `main.c`；`system.node` 的 `addon.c`、`system.h`、`flock.c` 和 `dirfd.c`）随包分发以供审计。参见工作区[架构](../../docs/architecture.md)、[支持矩阵](../../docs/support-matrix.md)和 [CLI 约定](../../docs/cli-contract.md)。
