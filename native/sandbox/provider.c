/*
 * libbugent-sandbox
 *
 * Linux implementation of the Bun.spawn native sandbox-provider ABI.
 *
 * Security model:
 *   - Landlock filesystem allowlist (deny by default).
 *   - seccomp network deny for network=none.
 *   - no_new_privs.
 *   - optional rlimits.
 *   - close all inherited descriptors except stdin/stdout/stderr.
 *
 * prepare() runs in the Bun parent and may allocate. apply() runs in the
 * spawned child immediately before execve() and must only use async-signal-safe
 * operations. In particular it must not allocate, lock, dlopen, or use stdio.
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#endif
#ifndef SYS_landlock_add_rule
#define SYS_landlock_add_rule 445
#endif
#ifndef SYS_landlock_restrict_self
#define SYS_landlock_restrict_self 446
#endif
#ifndef SYS_close_range
#define SYS_close_range 436
#endif
#ifndef SYS_seccomp
#error "libbugent-sandbox requires a Linux target with SYS_seccomp"
#endif
#ifndef SYS_prlimit64
#error "libbugent-sandbox requires a Linux target with SYS_prlimit64"
#endif

#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef CLOSE_RANGE_UNSHARE
#define CLOSE_RANGE_UNSHARE (1U << 1)
#endif

#define BUGENT_MAX_PATHS 256
#define BUGENT_MAX_CONFIG_BYTES (1024U * 1024U)
#define BUGENT_MAX_JSON_DEPTH 16

typedef struct {
  const char *cur;
  const char *end;
  unsigned depth;
} json_parser;

typedef struct {
  char **items;
  size_t len;
  size_t cap;
} string_list;

typedef struct {
  int has_cpu;
  uint64_t cpu_seconds;
  int has_address_space;
  uint64_t address_space_bytes;
  int has_file_size;
  uint64_t file_size_bytes;
  int has_open_files;
  uint64_t open_files;
  int has_processes;
  uint64_t processes;
} limit_config;

typedef struct {
  string_list read;
  string_list write;
  string_list exec;
  int network_none;
  limit_config limits;
} parsed_config;

typedef struct {
  int ruleset_fd;
  int network_none;
  int close_extra_fds;
  struct sock_filter *filter;
  size_t filter_len;
  limit_config limits;
} sandbox_state;

static int json_fail(json_parser *p) {
  (void)p;
  errno = EINVAL;
  return -1;
}

static void json_skip_ws(json_parser *p) {
  while (p->cur < p->end) {
    const unsigned char c = (unsigned char)*p->cur;
    if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
    p->cur++;
  }
}

static int json_take(json_parser *p, char expected) {
  json_skip_ws(p);
  if (p->cur >= p->end || *p->cur != expected) return json_fail(p);
  p->cur++;
  return 0;
}

static int hex_value(unsigned char c) {
  if (c >= '0' && c <= '9') return (int)(c - '0');
  if (c >= 'a' && c <= 'f') return (int)(c - 'a' + 10);
  if (c >= 'A' && c <= 'F') return (int)(c - 'A' + 10);
  return -1;
}

static int json_hex4(json_parser *p, uint32_t *out) {
  if ((size_t)(p->end - p->cur) < 4) return json_fail(p);
  uint32_t value = 0;
  for (int i = 0; i < 4; i++) {
    const int digit = hex_value((unsigned char)p->cur[i]);
    if (digit < 0) return json_fail(p);
    value = (value << 4) | (uint32_t)digit;
  }
  p->cur += 4;
  *out = value;
  return 0;
}

static size_t utf8_encode(uint32_t codepoint, char out[4]) {
  if (codepoint <= 0x7f) {
    out[0] = (char)codepoint;
    return 1;
  }
  if (codepoint <= 0x7ff) {
    out[0] = (char)(0xc0 | (codepoint >> 6));
    out[1] = (char)(0x80 | (codepoint & 0x3f));
    return 2;
  }
  if (codepoint <= 0xffff) {
    out[0] = (char)(0xe0 | (codepoint >> 12));
    out[1] = (char)(0x80 | ((codepoint >> 6) & 0x3f));
    out[2] = (char)(0x80 | (codepoint & 0x3f));
    return 3;
  }
  out[0] = (char)(0xf0 | (codepoint >> 18));
  out[1] = (char)(0x80 | ((codepoint >> 12) & 0x3f));
  out[2] = (char)(0x80 | ((codepoint >> 6) & 0x3f));
  out[3] = (char)(0x80 | (codepoint & 0x3f));
  return 4;
}

static int json_string(json_parser *p, char **out) {
  json_skip_ws(p);
  if (p->cur >= p->end || *p->cur != '"') return json_fail(p);
  p->cur++;

  const size_t capacity = (size_t)(p->end - p->cur) + 1;
  char *value = (char *)malloc(capacity);
  if (value == NULL) {
    errno = ENOMEM;
    return -1;
  }

  size_t written = 0;
  while (p->cur < p->end) {
    unsigned char c = (unsigned char)*p->cur++;
    if (c == '"') {
      value[written] = '\0';
      *out = value;
      return 0;
    }
    if (c < 0x20) {
      free(value);
      return json_fail(p);
    }
    if (c != '\\') {
      value[written++] = (char)c;
      continue;
    }

    if (p->cur >= p->end) {
      free(value);
      return json_fail(p);
    }
    const unsigned char escaped = (unsigned char)*p->cur++;
    switch (escaped) {
      case '"':
      case '\\':
      case '/':
        value[written++] = (char)escaped;
        break;
      case 'b':
        value[written++] = '\b';
        break;
      case 'f':
        value[written++] = '\f';
        break;
      case 'n':
        value[written++] = '\n';
        break;
      case 'r':
        value[written++] = '\r';
        break;
      case 't':
        value[written++] = '\t';
        break;
      case 'u': {
        uint32_t codepoint = 0;
        if (json_hex4(p, &codepoint) != 0) {
          free(value);
          return -1;
        }
        if (codepoint >= 0xd800 && codepoint <= 0xdbff) {
          if ((size_t)(p->end - p->cur) < 6 || p->cur[0] != '\\' || p->cur[1] != 'u') {
            free(value);
            return json_fail(p);
          }
          p->cur += 2;
          uint32_t low = 0;
          if (json_hex4(p, &low) != 0) {
            free(value);
            return -1;
          }
          if (low < 0xdc00 || low > 0xdfff) {
            free(value);
            return json_fail(p);
          }
          codepoint = 0x10000u + ((codepoint - 0xd800u) << 10) + (low - 0xdc00u);
        } else if (codepoint >= 0xdc00 && codepoint <= 0xdfff) {
          free(value);
          return json_fail(p);
        }
        char encoded[4];
        const size_t encoded_len = utf8_encode(codepoint, encoded);
        memcpy(value + written, encoded, encoded_len);
        written += encoded_len;
        break;
      }
      default:
        free(value);
        return json_fail(p);
    }
  }

  free(value);
  return json_fail(p);
}

static int string_list_push(string_list *list, char *value) {
  if (list->len >= BUGENT_MAX_PATHS) {
    free(value);
    errno = E2BIG;
    return -1;
  }
  if (list->len == list->cap) {
    const size_t next_cap = list->cap == 0 ? 8 : list->cap * 2;
    char **next = (char **)realloc(list->items, next_cap * sizeof(*next));
    if (next == NULL) {
      free(value);
      errno = ENOMEM;
      return -1;
    }
    list->items = next;
    list->cap = next_cap;
  }
  list->items[list->len++] = value;
  return 0;
}

static void string_list_free(string_list *list) {
  for (size_t i = 0; i < list->len; i++) free(list->items[i]);
  free(list->items);
  list->items = NULL;
  list->len = 0;
  list->cap = 0;
}

static int json_skip_value(json_parser *p);

static int json_string_array(json_parser *p, string_list *out) {
  if (json_take(p, '[') != 0) return -1;
  json_skip_ws(p);
  if (p->cur < p->end && *p->cur == ']') {
    p->cur++;
    return 0;
  }

  for (;;) {
    char *value = NULL;
    if (json_string(p, &value) != 0) return -1;
    if (string_list_push(out, value) != 0) return -1;

    json_skip_ws(p);
    if (p->cur >= p->end) return json_fail(p);
    if (*p->cur == ']') {
      p->cur++;
      return 0;
    }
    if (*p->cur != ',') return json_fail(p);
    p->cur++;
  }
}

static int json_u64(json_parser *p, uint64_t *out) {
  json_skip_ws(p);
  if (p->cur >= p->end || *p->cur < '0' || *p->cur > '9') return json_fail(p);
  uint64_t value = 0;
  while (p->cur < p->end && *p->cur >= '0' && *p->cur <= '9') {
    const uint64_t digit = (uint64_t)(*p->cur - '0');
    if (value > (UINT64_MAX - digit) / 10) return json_fail(p);
    value = value * 10 + digit;
    p->cur++;
  }
  *out = value;
  return 0;
}

static int json_skip_object(json_parser *p) {
  if (p->depth++ >= BUGENT_MAX_JSON_DEPTH) return json_fail(p);
  if (json_take(p, '{') != 0) return -1;
  json_skip_ws(p);
  if (p->cur < p->end && *p->cur == '}') {
    p->cur++;
    p->depth--;
    return 0;
  }
  for (;;) {
    char *key = NULL;
    if (json_string(p, &key) != 0) return -1;
    free(key);
    if (json_take(p, ':') != 0) return -1;
    if (json_skip_value(p) != 0) return -1;
    json_skip_ws(p);
    if (p->cur >= p->end) return json_fail(p);
    if (*p->cur == '}') {
      p->cur++;
      p->depth--;
      return 0;
    }
    if (*p->cur != ',') return json_fail(p);
    p->cur++;
  }
}

static int json_skip_array(json_parser *p) {
  if (p->depth++ >= BUGENT_MAX_JSON_DEPTH) return json_fail(p);
  if (json_take(p, '[') != 0) return -1;
  json_skip_ws(p);
  if (p->cur < p->end && *p->cur == ']') {
    p->cur++;
    p->depth--;
    return 0;
  }
  for (;;) {
    if (json_skip_value(p) != 0) return -1;
    json_skip_ws(p);
    if (p->cur >= p->end) return json_fail(p);
    if (*p->cur == ']') {
      p->cur++;
      p->depth--;
      return 0;
    }
    if (*p->cur != ',') return json_fail(p);
    p->cur++;
  }
}

static int json_skip_value(json_parser *p) {
  json_skip_ws(p);
  if (p->cur >= p->end) return json_fail(p);
  if (*p->cur == '"') {
    char *value = NULL;
    const int rc = json_string(p, &value);
    free(value);
    return rc;
  }
  if (*p->cur == '{') return json_skip_object(p);
  if (*p->cur == '[') return json_skip_array(p);
  if (strncmp(p->cur, "true", 4) == 0) {
    p->cur += 4;
    return 0;
  }
  if (strncmp(p->cur, "false", 5) == 0) {
    p->cur += 5;
    return 0;
  }
  if (strncmp(p->cur, "null", 4) == 0) {
    p->cur += 4;
    return 0;
  }
  if (*p->cur == '-' || (*p->cur >= '0' && *p->cur <= '9')) {
    const char *start = p->cur++;
    while (p->cur < p->end) {
      const unsigned char c = (unsigned char)*p->cur;
      if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
        p->cur++;
      } else {
        break;
      }
    }
    return p->cur > start ? 0 : json_fail(p);
  }
  return json_fail(p);
}

static int json_limits(json_parser *p, limit_config *limits) {
  if (json_take(p, '{') != 0) return -1;
  json_skip_ws(p);
  if (p->cur < p->end && *p->cur == '}') {
    p->cur++;
    return 0;
  }

  for (;;) {
    char *key = NULL;
    if (json_string(p, &key) != 0) return -1;
    if (json_take(p, ':') != 0) {
      free(key);
      return -1;
    }

    uint64_t value = 0;
    if (json_u64(p, &value) != 0) {
      free(key);
      return -1;
    }

    if (strcmp(key, "cpuSeconds") == 0) {
      limits->has_cpu = 1;
      limits->cpu_seconds = value;
    } else if (strcmp(key, "addressSpaceBytes") == 0) {
      limits->has_address_space = 1;
      limits->address_space_bytes = value;
    } else if (strcmp(key, "fileSizeBytes") == 0) {
      limits->has_file_size = 1;
      limits->file_size_bytes = value;
    } else if (strcmp(key, "openFiles") == 0) {
      limits->has_open_files = 1;
      limits->open_files = value;
    } else if (strcmp(key, "processes") == 0) {
      limits->has_processes = 1;
      limits->processes = value;
    }
    free(key);

    json_skip_ws(p);
    if (p->cur >= p->end) return json_fail(p);
    if (*p->cur == '}') {
      p->cur++;
      return 0;
    }
    if (*p->cur != ',') return json_fail(p);
    p->cur++;
  }
}

static int json_config(const char *data, size_t len, parsed_config *out) {
  json_parser p = {.cur = data, .end = data + len, .depth = 0};
  if (json_take(&p, '{') != 0) return -1;

  json_skip_ws(&p);
  if (p.cur < p.end && *p.cur == '}') {
    p.cur++;
  } else {
    for (;;) {
      char *key = NULL;
      if (json_string(&p, &key) != 0) return -1;
      if (json_take(&p, ':') != 0) {
        free(key);
        return -1;
      }

      if (strcmp(key, "read") == 0) {
        if (json_string_array(&p, &out->read) != 0) {
          free(key);
          return -1;
        }
      } else if (strcmp(key, "write") == 0) {
        if (json_string_array(&p, &out->write) != 0) {
          free(key);
          return -1;
        }
      } else if (strcmp(key, "exec") == 0) {
        if (json_string_array(&p, &out->exec) != 0) {
          free(key);
          return -1;
        }
      } else if (strcmp(key, "network") == 0) {
        char *network = NULL;
        if (json_string(&p, &network) != 0) {
          free(key);
          return -1;
        }
        if (strcmp(network, "none") == 0) {
          out->network_none = 1;
        } else if (strcmp(network, "all") == 0) {
          out->network_none = 0;
        } else {
          free(network);
          free(key);
          errno = ENOTSUP;
          return -1;
        }
        free(network);
      } else if (strcmp(key, "limits") == 0) {
        if (json_limits(&p, &out->limits) != 0) {
          free(key);
          return -1;
        }
      } else {
        if (json_skip_value(&p) != 0) {
          free(key);
          return -1;
        }
      }
      free(key);

      json_skip_ws(&p);
      if (p.cur >= p.end) return json_fail(&p);
      if (*p.cur == '}') {
        p.cur++;
        break;
      }
      if (*p.cur != ',') return json_fail(&p);
      p.cur++;
    }
  }

  json_skip_ws(&p);
  if (p.cur != p.end) return json_fail(&p);
  return 0;
}

static uint64_t landlock_access_mask(int abi) {
  uint64_t mask =
      LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
      LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
      LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
      LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
      LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
      LANDLOCK_ACCESS_FS_MAKE_SYM;
  if (abi >= 2) mask |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) mask |= LANDLOCK_ACCESS_FS_TRUNCATE;
  if (abi >= 5) mask |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
  return mask;
}

static uint64_t read_access(void) {
  return LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR;
}

static uint64_t write_access(int abi) {
  uint64_t access =
      LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
      LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
      LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |
      LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
      LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
      LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM;
  if (abi >= 2) access |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) access |= LANDLOCK_ACCESS_FS_TRUNCATE;
  if (abi >= 5) access |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
  return access;
}

static int add_landlock_path_rule(int ruleset_fd, const char *path, uint64_t access) {
  char *canonical = realpath(path, NULL);
  if (canonical == NULL) return -1;

  int path_fd = open(canonical, O_PATH | O_CLOEXEC);
  if (path_fd < 0) {
    free(canonical);
    return -1;
  }

  struct stat st;
  if (fstat(path_fd, &st) != 0) {
    const int saved = errno;
    close(path_fd);
    free(canonical);
    errno = saved;
    return -1;
  }

  if (!S_ISDIR(st.st_mode)) {
    /*
     * Landlock's path-beneath rule for an exact regular file is not portable
     * for execute checks: the kernel may still deny execve() before the final
     * file rule is consulted. Execute grants are therefore directory grants.
     * Read/write grants may still target exact files.
     */
    if (access == LANDLOCK_ACCESS_FS_EXECUTE) {
      close(path_fd);
      char *slash = strrchr(canonical, '/');
      if (slash == NULL) {
        free(canonical);
        errno = EINVAL;
        return -1;
      }
      if (slash == canonical) {
        slash[1] = '\0';
      } else {
        *slash = '\0';
      }
      path_fd = open(canonical, O_PATH | O_CLOEXEC);
      if (path_fd < 0) {
        free(canonical);
        return -1;
      }
      if (fstat(path_fd, &st) != 0 || !S_ISDIR(st.st_mode)) {
        const int saved = errno == 0 ? ENOTDIR : errno;
        close(path_fd);
        free(canonical);
        errno = saved;
        return -1;
      }
    } else {
      access &= ~(LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR |
                  LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |
                  LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
                  LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
                  LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM |
                  LANDLOCK_ACCESS_FS_REFER);
    }
  }

  struct landlock_path_beneath_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.allowed_access = access;
  attr.parent_fd = path_fd;

  const int rc = (int)syscall(SYS_landlock_add_rule, ruleset_fd,
                               LANDLOCK_RULE_PATH_BENEATH, &attr, 0);
  const int saved = errno;
  close(path_fd);
  free(canonical);
  errno = saved;
  return rc;
}

static int append_filter(struct sock_filter *filter, size_t *len, struct sock_filter insn) {
  if (*len >= 128) {
    errno = E2BIG;
    return -1;
  }
  filter[(*len)++] = insn;
  return 0;
}

static int build_network_filter(sandbox_state *state) {
  struct sock_filter *filter =
      (struct sock_filter *)calloc(128, sizeof(struct sock_filter));
  if (filter == NULL) {
    errno = ENOMEM;
    return -1;
  }

  size_t len = 0;
#if defined(__x86_64__)
  const uint32_t expected_arch = AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
  const uint32_t expected_arch = AUDIT_ARCH_AARCH64;
#else
#error "libbugent-sandbox currently supports x86_64 and aarch64 Linux"
#endif

  if (append_filter(filter, &len,
                    (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                                                 (uint32_t)offsetof(struct seccomp_data, arch))) != 0 ||
      append_filter(filter, &len,
                    (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K,
                                                 expected_arch, 1, 0)) != 0 ||
      append_filter(filter, &len,
                    (struct sock_filter)BPF_STMT(BPF_RET | BPF_K,
                                                 SECCOMP_RET_KILL_PROCESS)) != 0 ||
      append_filter(filter, &len,
                    (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                                                 (uint32_t)offsetof(struct seccomp_data, nr))) != 0) {
    free(filter);
    return -1;
  }

  static const int denied_syscalls[] = {
#ifdef __NR_socket
      __NR_socket,
#endif
#ifdef __NR_socketpair
      __NR_socketpair,
#endif
#ifdef __NR_connect
      __NR_connect,
#endif
#ifdef __NR_bind
      __NR_bind,
#endif
#ifdef __NR_listen
      __NR_listen,
#endif
#ifdef __NR_accept
      __NR_accept,
#endif
#ifdef __NR_accept4
      __NR_accept4,
#endif
#ifdef __NR_socketcall
      __NR_socketcall,
#endif
#ifdef __NR_io_uring_setup
      __NR_io_uring_setup,
#endif
  };

  for (size_t i = 0; i < sizeof(denied_syscalls) / sizeof(denied_syscalls[0]); i++) {
    if (append_filter(filter, &len,
                      (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K,
                                                   (uint32_t)denied_syscalls[i], 0, 1)) != 0 ||
        append_filter(filter, &len,
                      (struct sock_filter)BPF_STMT(
                          BPF_RET | BPF_K,
                          SECCOMP_RET_ERRNO | (uint32_t)(EPERM & SECCOMP_RET_DATA))) != 0) {
      free(filter);
      return -1;
    }
  }

  if (append_filter(filter, &len,
                    (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)) != 0) {
    free(filter);
    return -1;
  }

  state->filter = filter;
  state->filter_len = len;
  return 0;
}

static void free_parsed_config(parsed_config *config) {
  string_list_free(&config->read);
  string_list_free(&config->write);
  string_list_free(&config->exec);
}

void *bun_spawn_sandbox_prepare(const char *config_data, size_t config_len,
                                int *errno_out) {
  if (errno_out != NULL) *errno_out = 0;
  if (config_data == NULL || config_len > BUGENT_MAX_CONFIG_BYTES) {
    if (errno_out != NULL) *errno_out = EINVAL;
    return NULL;
  }

  parsed_config config;
  memset(&config, 0, sizeof(config));
  config.network_none = 1;

  char *copy = (char *)malloc(config_len + 1);
  if (copy == NULL) {
    if (errno_out != NULL) *errno_out = ENOMEM;
    return NULL;
  }
  memcpy(copy, config_data, config_len);
  copy[config_len] = '\0';

  if (json_config(copy, config_len, &config) != 0) {
    const int saved = errno;
    free(copy);
    free_parsed_config(&config);
    if (errno_out != NULL) *errno_out = saved == 0 ? EINVAL : saved;
    return NULL;
  }
  free(copy);

  sandbox_state *state = (sandbox_state *)calloc(1, sizeof(*state));
  if (state == NULL) {
    free_parsed_config(&config);
    if (errno_out != NULL) *errno_out = ENOMEM;
    return NULL;
  }
  state->ruleset_fd = -1;
  state->network_none = config.network_none;
  state->close_extra_fds = 1;
  state->limits = config.limits;

  const int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0,
                               LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) {
    const int saved = errno;
    free_parsed_config(&config);
    free(state);
    if (errno_out != NULL) *errno_out = saved == 0 ? ENOTSUP : saved;
    return NULL;
  }

  struct landlock_ruleset_attr_v1 {
    uint64_t handled_access_fs;
  } ruleset_attr;
  memset(&ruleset_attr, 0, sizeof(ruleset_attr));
  ruleset_attr.handled_access_fs = landlock_access_mask(abi);

  state->ruleset_fd =
      (int)syscall(SYS_landlock_create_ruleset, &ruleset_attr,
                   sizeof(ruleset_attr), 0);
  if (state->ruleset_fd < 0) {
    const int saved = errno;
    free_parsed_config(&config);
    free(state);
    if (errno_out != NULL) *errno_out = saved;
    return NULL;
  }

  for (size_t i = 0; i < config.read.len; i++) {
    if (add_landlock_path_rule(state->ruleset_fd, config.read.items[i],
                               read_access()) != 0) {
      goto fail;
    }
  }
  for (size_t i = 0; i < config.write.len; i++) {
    if (add_landlock_path_rule(state->ruleset_fd, config.write.items[i],
                               write_access(abi)) != 0) {
      goto fail;
    }
  }
  for (size_t i = 0; i < config.exec.len; i++) {
    if (add_landlock_path_rule(state->ruleset_fd, config.exec.items[i],
                               LANDLOCK_ACCESS_FS_EXECUTE) != 0) {
      goto fail;
    }
  }

  if (state->network_none && build_network_filter(state) != 0) goto fail;

  free_parsed_config(&config);
  return state;

fail: {
    const int saved = errno;
    if (state->ruleset_fd >= 0) close(state->ruleset_fd);
    free(state->filter);
    free(state);
    free_parsed_config(&config);
    if (errno_out != NULL) *errno_out = saved == 0 ? EINVAL : saved;
    return NULL;
  }
}

static int apply_rlimit(uint64_t value, int resource) {
  struct rlimit limit;
  limit.rlim_cur = (rlim_t)value;
  limit.rlim_max = (rlim_t)value;
  return (int)syscall(SYS_prlimit64, 0, resource, &limit, NULL);
}

int bun_spawn_sandbox_apply(void *opaque) {
  sandbox_state *state = (sandbox_state *)opaque;
  if (state == NULL) return EINVAL;

  if (state->ruleset_fd >= 0) {
    if (syscall(SYS_prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return errno;
    if (syscall(SYS_landlock_restrict_self, state->ruleset_fd, 0) != 0) return errno;
  }

  if (state->network_none) {
    if (syscall(SYS_prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return errno;
    struct sock_fprog program;
    program.len = (unsigned short)state->filter_len;
    program.filter = state->filter;
    if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program) != 0) return errno;
  }

  if (state->limits.has_cpu &&
      apply_rlimit(state->limits.cpu_seconds, RLIMIT_CPU) != 0) return errno;
  if (state->limits.has_address_space &&
      apply_rlimit(state->limits.address_space_bytes, RLIMIT_AS) != 0) return errno;
  if (state->limits.has_file_size &&
      apply_rlimit(state->limits.file_size_bytes, RLIMIT_FSIZE) != 0) return errno;
  if (state->limits.has_open_files &&
      apply_rlimit(state->limits.open_files, RLIMIT_NOFILE) != 0) return errno;
  if (state->limits.has_processes &&
      apply_rlimit(state->limits.processes, RLIMIT_NPROC) != 0) return errno;

  if (state->close_extra_fds) {
    if (syscall(SYS_close_range, 3U, ~0U, CLOSE_RANGE_UNSHARE) != 0) {
      return errno;
    }
  }

  return 0;
}

void bun_spawn_sandbox_destroy(void *opaque) {
  sandbox_state *state = (sandbox_state *)opaque;
  if (state == NULL) return;
  if (state->ruleset_fd >= 0) close(state->ruleset_fd);
  free(state->filter);
  free(state);
}
