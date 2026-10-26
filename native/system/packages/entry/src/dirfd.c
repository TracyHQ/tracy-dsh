/*
 * Node-API v8 binding for descriptor-relative file calls: openat, mkdirat,
 * renameat, linkat and unlinkat. Each name is resolved relative to a directory
 * descriptor the caller already holds, so a directory on the caller's path
 * swapped for a symlink after the caller checked its descriptor cannot redirect
 * the call: no path above the named entry is looked up again.
 *
 * Every name must be one path component: non-empty, no '/', no NUL, and neither
 * "." nor "..". Directory descriptors must be non-negative, so AT_FDCWD (and a
 * lookup relative to the process working directory) is unreachable. openat
 * always adds O_CLOEXEC. The caller owns every descriptor passed in, and owns
 * the descriptor openat returns; this module closes only a descriptor it opened
 * for an environment that terminated before the result could be delivered.
 *
 * Each syscall runs in asynchronous work and captures errno on that worker. The
 * callback receives (errno, result): errno is zero or positive, result is the
 * new descriptor for openat and zero otherwise. JavaScript owns the promise and
 * syscall error construction.
 */

#define _POSIX_C_SOURCE 200809L

#include "system.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h> /* renameat */
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

typedef enum {
  OP_OPENAT,
  OP_MKDIRAT,
  OP_RENAMEAT,
  OP_LINKAT,
  OP_UNLINKAT,
} dirfd_op;

typedef struct {
  napi_env env;
  napi_ref callback;
  napi_async_work work;
  napi_async_cleanup_hook_handle cleanup;
  dirfd_op op;
  int dirfd;
  int new_dirfd;
  char *name;
  char *new_name;
  int flags;
  int mode;
  int result;
  int error;
  bool closing;
} dirfd_request;

static const char *const OP_NAMES[] = { "openat", "mkdirat", "renameat", "linkat", "unlinkat" };

static void check_status(napi_status status, const char *message) {
  if (status != napi_ok) {
    napi_fatal_error("dirfd", NAPI_AUTO_LENGTH, message, NAPI_AUTO_LENGTH);
  }
}

static void release_request(dirfd_request *request) {
  if (request->callback != NULL) {
    (void)napi_delete_reference(request->env, request->callback);
  }
  if (request->work != NULL) {
    (void)napi_delete_async_work(request->env, request->work);
  }
  if (request->cleanup != NULL) {
    (void)napi_remove_async_cleanup_hook(request->cleanup);
  }
  free(request->name);
  free(request->new_name);
  free(request);
}

static napi_value throw_setup_error(napi_env env, napi_status status, const char *message) {
  if (status != napi_pending_exception) {
    status = napi_throw_error(env, "ERR_DIRFD_ASYNC_WORK", message);
    bool pending;
    /* Error construction can fail with both generic_failure and a JS exception. */
    check_status(napi_is_exception_pending(env, &pending), "Cannot inspect dirfd setup exception");
    if (!pending && status != napi_pending_exception) check_status(status, message);
  }
  return NULL;
}

static void execute_call(napi_env env, void *data) {
  (void)env;
  dirfd_request *request = data;
  int rc = 0;
  switch (request->op) {
    case OP_OPENAT:
      rc = openat(request->dirfd, request->name, request->flags | O_CLOEXEC, (mode_t)request->mode);
      break;
    case OP_MKDIRAT:
      rc = mkdirat(request->dirfd, request->name, (mode_t)request->mode);
      break;
    case OP_RENAMEAT:
      rc = renameat(request->dirfd, request->name, request->new_dirfd, request->new_name);
      break;
    case OP_LINKAT:
      /* No AT_SYMLINK_FOLLOW: a symlink at the old name is linked as itself. */
      rc = linkat(request->dirfd, request->name, request->new_dirfd, request->new_name, 0);
      break;
    case OP_UNLINKAT:
      rc = unlinkat(request->dirfd, request->name, request->flags ? AT_REMOVEDIR : 0);
      break;
  }
  if (rc < 0) {
    request->error = errno;
    request->result = 0;
  } else {
    request->error = 0;
    request->result = request->op == OP_OPENAT ? rc : 0;
  }
}

static void complete_call(napi_env env, napi_status status, void *data) {
  dirfd_request *request = data;
  if (env != NULL && !request->closing) {
    napi_value callback;
    napi_value receiver;
    napi_value results[2];
    check_status(status, "dirfd async work did not complete");
    check_status(napi_get_reference_value(env, request->callback, &callback),
                 "Cannot retrieve dirfd callback");
    check_status(napi_get_undefined(env, &receiver), "Cannot create dirfd receiver");
    check_status(napi_create_int32(env, request->error, &results[0]), "Cannot create dirfd errno");
    check_status(napi_create_int32(env, request->result, &results[1]), "Cannot create dirfd result");
    status = napi_call_function(env, receiver, callback, 2, results, NULL);
  } else {
    /* Nobody can receive the descriptor; do not leak it past the environment. */
    if (request->op == OP_OPENAT && request->error == 0 && request->result >= 0 && status == napi_ok) {
      (void)close(request->result);
    }
    status = napi_ok;
  }
  release_request(request);
  /* Node's async-work dispatcher reports callback exceptions and handles termination. */
  if (status != napi_pending_exception) {
    check_status(status, "Cannot invoke dirfd callback");
  }
}

static void cleanup_call(napi_async_cleanup_hook_handle handle, void *data) {
  (void)handle;
  dirfd_request *request = data;
  request->closing = true;
  /* Running work cannot be cancelled; completion releases both the work and this hook. */
  (void)napi_cancel_async_work(request->env, request->work);
}

/* Read a non-negative C int descriptor; throws and returns false otherwise. */
static bool read_dirfd(napi_env env, napi_value value, int *out) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok) {
    (void)napi_throw_type_error(env, NULL, "dirfd must be a number");
    return false;
  }
  if (!(number >= 0 && number <= INT_MAX) || number != (int)number) {
    (void)napi_throw_range_error(env, NULL, "dirfd must be a non-negative C int");
    return false;
  }
  *out = (int)number;
  return true;
}

/* Read a C int within [min, max]; throws and returns false otherwise. */
static bool read_int(napi_env env, napi_value value, double min, double max, const char *what, int *out) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok) {
    (void)napi_throw_type_error(env, NULL, what);
    return false;
  }
  if (!(number >= min && number <= max) || number != (int)number) {
    (void)napi_throw_range_error(env, NULL, what);
    return false;
  }
  *out = (int)number;
  return true;
}

/*
 * Read one path component into a heap string the request owns. Rejects
 * anything that would make the kernel walk more than the one named entry.
 */
static bool read_name(napi_env env, napi_value value, char **out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    (void)napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "name must be a string");
    return false;
  }
  size_t length;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) {
    (void)napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "name must be a string");
    return false;
  }
  char *name = malloc(length + 1);
  if (name == NULL) {
    (void)napi_throw_error(env, "ENOMEM", "Cannot allocate dirfd name");
    return false;
  }
  size_t copied;
  if (napi_get_value_string_utf8(env, value, name, length + 1, &copied) != napi_ok || copied != length) {
    free(name);
    (void)napi_throw_type_error(env, "ERR_INVALID_ARG_TYPE", "name must be a string");
    return false;
  }
  if (length == 0 || strlen(name) != length || strchr(name, '/') != NULL ||
      strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
    free(name);
    (void)napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE",
                                "name must be one path component (not empty, '.', '..', or containing '/' or NUL)");
    return false;
  }
  *out = name;
  return true;
}

/* Queue one request; takes ownership of `request` in every outcome. */
static napi_value queue_request(napi_env env, dirfd_request *request, napi_value callback) {
  napi_status status = napi_create_reference(env, callback, 1, &request->callback);
  if (status != napi_ok) {
    release_request(request);
    return throw_setup_error(env, status, "Cannot retain dirfd callback");
  }
  napi_value name;
  status = napi_create_string_utf8(env, OP_NAMES[request->op], NAPI_AUTO_LENGTH, &name);
  if (status == napi_ok) {
    status = napi_create_async_work(env, NULL, name, execute_call, complete_call, request, &request->work);
  }
  if (status != napi_ok) {
    release_request(request);
    return throw_setup_error(env, status, "Cannot create dirfd async work");
  }
  status = napi_add_async_cleanup_hook(env, cleanup_call, request, &request->cleanup);
  if (status != napi_ok) {
    release_request(request);
    return throw_setup_error(env, status, "Cannot register dirfd environment cleanup");
  }
  status = napi_queue_async_work(env, request->work);
  if (status != napi_ok) {
    /* Queue failure schedules no completion callback. */
    release_request(request);
    return throw_setup_error(env, status, "Cannot queue dirfd async work");
  }
  return NULL;
}

/*
 * Shared argument reader. `shape` lists the arguments before the callback:
 * 'd' directory descriptor, 'n' name, 'f' flags (C int), 'm' mode (0..07777),
 * 'b' boolean.
 */
static napi_value start_call(napi_env env, napi_callback_info info, dirfd_op op, const char *shape) {
  size_t expected = strlen(shape) + 1;
  size_t argc = 6;
  napi_value argv[6];
  napi_status status = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (status != napi_ok) return throw_setup_error(env, status, "Cannot read dirfd arguments");
  if (argc < expected) {
    (void)napi_throw_type_error(env, NULL, "missing dirfd arguments");
    return NULL;
  }
  napi_valuetype callback_type;
  if (napi_typeof(env, argv[expected - 1], &callback_type) != napi_ok || callback_type != napi_function) {
    (void)napi_throw_type_error(env, NULL, "callback must be a function");
    return NULL;
  }

  dirfd_request *request = calloc(1, sizeof(*request));
  if (request == NULL) {
    (void)napi_throw_error(env, "ENOMEM", "Cannot allocate dirfd async work");
    return NULL;
  }
  request->env = env;
  request->op = op;
  int dirfds = 0;
  int names = 0;
  for (size_t index = 0; index + 1 < expected; index++) {
    bool ok = true;
    switch (shape[index]) {
      case 'd':
        ok = read_dirfd(env, argv[index], dirfds++ == 0 ? &request->dirfd : &request->new_dirfd);
        break;
      case 'n':
        ok = read_name(env, argv[index], names++ == 0 ? &request->name : &request->new_name);
        break;
      case 'f':
        ok = read_int(env, argv[index], INT_MIN, INT_MAX, "flags must be a C int", &request->flags);
        break;
      case 'm':
        ok = read_int(env, argv[index], 0, 07777, "mode must be an integer in 0..0o7777", &request->mode);
        break;
      case 'b': {
        bool value = false;
        ok = napi_get_value_bool(env, argv[index], &value) == napi_ok;
        if (!ok) (void)napi_throw_type_error(env, NULL, "directory must be a boolean");
        request->flags = value ? 1 : 0;
        break;
      }
    }
    if (!ok) {
      release_request(request);
      return NULL;
    }
  }
  return queue_request(env, request, argv[expected - 1]);
}

static napi_value call_openat(napi_env env, napi_callback_info info) {
  return start_call(env, info, OP_OPENAT, "dnfm");
}

static napi_value call_mkdirat(napi_env env, napi_callback_info info) {
  return start_call(env, info, OP_MKDIRAT, "dnm");
}

static napi_value call_renameat(napi_env env, napi_callback_info info) {
  return start_call(env, info, OP_RENAMEAT, "dndn");
}

static napi_value call_linkat(napi_env env, napi_callback_info info) {
  return start_call(env, info, OP_LINKAT, "dndn");
}

static napi_value call_unlinkat(napi_env env, napi_callback_info info) {
  return start_call(env, info, OP_UNLINKAT, "dnb");
}

napi_status dirfd_register(napi_env env, napi_value exports) {
  static const struct {
    const char *name;
    napi_callback callback;
  } functions[] = {
    { "openat", call_openat },
    { "mkdirat", call_mkdirat },
    { "renameat", call_renameat },
    { "linkat", call_linkat },
    { "unlinkat", call_unlinkat },
  };
  for (size_t index = 0; index < sizeof(functions) / sizeof(functions[0]); index++) {
    napi_value function;
    napi_status status = napi_create_function(env, functions[index].name, NAPI_AUTO_LENGTH,
                                              functions[index].callback, NULL, &function);
    if (status != napi_ok) return status;
    status = napi_set_named_property(env, exports, functions[index].name, function);
    if (status != napi_ok) return status;
  }
  return napi_ok;
}
