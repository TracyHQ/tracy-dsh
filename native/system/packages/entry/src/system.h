/*
 * Capabilities linked into the one `system.node` addon. Each source registers
 * its own functions on the module's exports; `addon.c` owns module init.
 */

#ifndef NODE_ADDON_SYSTEM_H
#define NODE_ADDON_SYSTEM_H

#include <node_api.h>

/* Register `tryLock` (flock.c). Returns napi_ok or the failing status. */
napi_status flock_register(napi_env env, napi_value exports);

/* Register the descriptor-relative calls (dirfd.c). Returns napi_ok or the failing status. */
napi_status dirfd_register(napi_env env, napi_value exports);

#endif
