/*
 * Node-API v8 module init for `system.node`: one addon, one function table per
 * capability. Importing a JavaScript entry never loads it; each entry loads it
 * lazily on its first call.
 */

#include "system.h"

NAPI_MODULE_INIT() {
  if (flock_register(env, exports) != napi_ok || dirfd_register(env, exports) != napi_ok) {
    return NULL;
  }
  return exports;
}
