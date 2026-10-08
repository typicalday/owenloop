/* A descriptor-relative, read-only file opener for routed artifact uploads.
 * fd 3 is the holder's pinned workdir; fd 4 carries one metadata line.
 * stdout carries only bytes read from the final held file descriptor. */
#define _POSIX_C_SOURCE 200809L
#define _DARWIN_C_SOURCE
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define MAX_PATH_BYTES 8192
#define MAX_PARTS 1024
#define MAX_SYMLINKS 40
#define MAX_FILE_BYTES 500000000

static int dirs[MAX_PARTS + 1];
static size_t depth;

static int write_all(int fd, const void *data, size_t length) {
  const char *p = data;
  while (length) {
    ssize_t n = write(fd, p, length);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    p += n;
    length -= (size_t)n;
  }
  return 0;
}

static int refuse(const char *code) {
  char line[96];
  int n = snprintf(line, sizeof line, "ERR %s\n", code);
  if (n > 0 && (size_t)n < sizeof line) (void)write_all(4, line, (size_t)n);
  return 1;
}

static int rooted_absolute(const char *path, const char *root, char *out) {
  size_t r = strlen(root);
  if (root[0] != '/' || (r > 1 && root[r - 1] == '/')) return -1;
  if (strncmp(path, root, r) != 0 || (r > 1 && path[r] != '/' && path[r] != '\0')) return -1;
  const char *suffix = path + r;
  while (*suffix == '/') suffix++;
  if (strlen(suffix) >= MAX_PATH_BYTES) return -1;
  strcpy(out, suffix);
  return 0;
}

/* Symlink targets are interpreted against the held parent-fd stack. Absolute
 * targets are accepted only when spelled beneath the holder's initial root
 * display path; that spelling is translated back to the pinned root FD. */
static int walk(char *path, const char *root_display) {
  int links = 0;
  for (;;) {
    if (path[0] == '/') {
      char mapped[MAX_PATH_BYTES];
      if (rooted_absolute(path, root_display, mapped) != 0) return -1;
      while (depth > 0) close(dirs[depth--]);
      strcpy(path, mapped);
    }
    char *slash = strchr(path, '/');
    size_t part_len = slash ? (size_t)(slash - path) : strlen(path);
    if (part_len == 0) return -1;
    if (part_len > NAME_MAX) return -1;
    char part[NAME_MAX + 1];
    memcpy(part, path, part_len);
    part[part_len] = '\0';
    const char *rest = slash ? slash + 1 : NULL;
    if (rest) while (*rest == '/') rest++;
    if (rest && *rest == '\0') return -1;
    if (strcmp(part, ".") == 0) {
      if (!rest) return -1;
      memmove(path, rest, strlen(rest) + 1);
      continue;
    }
    if (strcmp(part, "..") == 0) {
      if (depth == 0 || !rest) return -1;
      close(dirs[depth--]);
      memmove(path, rest, strlen(rest) + 1);
      continue;
    }
    int fd = openat(dirs[depth], part, O_RDONLY | O_NOFOLLOW | O_CLOEXEC
      | (rest ? O_DIRECTORY : O_NONBLOCK));
    if (fd >= 0) {
      if (!rest) return fd;
      if (depth >= MAX_PARTS) { close(fd); return -1; }
      dirs[++depth] = fd;
      memmove(path, rest, strlen(rest) + 1);
      continue;
    }
    if (errno != ELOOP && errno != ENOTDIR) return -1;
    /* A failed O_NOFOLLOW open may be a symlink; readlinkat never follows it.
     * A raced replacement is safe: the next openat still starts at a held fd. */
    char target[MAX_PATH_BYTES];
    ssize_t n = readlinkat(dirs[depth], part, target, sizeof target);
    if (n <= 0 || (size_t)n >= sizeof target || ++links > MAX_SYMLINKS) return -1;
    target[n] = '\0';
    size_t tail = rest ? strlen(rest) : 0;
    if ((size_t)n + (tail ? 1 + tail : 0) >= MAX_PATH_BYTES) return -1;
    char next[MAX_PATH_BYTES];
    memcpy(next, target, (size_t)n);
    if (tail) { next[n] = '/'; memcpy(next + n + 1, rest, tail + 1); }
    else next[n] = '\0';
    strcpy(path, next);
  }
}

int main(int argc, char **argv) {
  if (argc != 3 || !argv[1][0] || strlen(argv[1]) >= MAX_PATH_BYTES
      || strlen(argv[2]) >= MAX_PATH_BYTES) return refuse("path");
  struct stat root;
  if (fstat(3, &root) != 0 || !S_ISDIR(root.st_mode)) return refuse("root");
  dirs[0] = 3;
  char path[MAX_PATH_BYTES];
  strcpy(path, argv[1]);
  int fd = walk(path, argv[2]);
  if (fd < 0) return refuse("outside");
  struct stat file;
  if (fstat(fd, &file) != 0 || !S_ISREG(file.st_mode) || file.st_size <= 0
      || file.st_size > MAX_FILE_BYTES) {
    close(fd);
    return refuse("file");
  }
  char header[64];
  int n = snprintf(header, sizeof header, "OK %lld\n", (long long)file.st_size);
  if (n <= 0 || (size_t)n >= sizeof header || write_all(4, header, (size_t)n) != 0) {
    close(fd);
    return 1;
  }
  char buffer[65536];
  off_t remaining = file.st_size;
  while (remaining > 0) {
    size_t wanted = remaining < (off_t)sizeof buffer ? (size_t)remaining : sizeof buffer;
    ssize_t got = read(fd, buffer, wanted);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0 || write_all(STDOUT_FILENO, buffer, (size_t)got) != 0) {
      close(fd);
      return 1;
    }
    remaining -= got;
  }
  close(fd);
  return 0;
}
