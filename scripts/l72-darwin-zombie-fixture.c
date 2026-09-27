#define _DARWIN_C_SOURCE 1
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

struct identity { int pid, ppid, pgid, sid, uid, error; };

static int transfer(int fd, void *bytes, size_t count, int writing) {
  char *cursor = bytes;
  while (count) {
    ssize_t n = writing ? write(fd, cursor, count) : read(fd, cursor, count);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return -1;
    cursor += n;
    count -= (size_t)n;
  }
  return 0;
}

static int fixture_error(const char *stage) {
  int saved = errno;
  printf("{\"event\":\"fixture-error\",\"stage\":\"%s\",\"errno\":%d}\n", stage, saved);
  fflush(stdout);
  return 70;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = SIG_DFL;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGCHLD, &action, NULL) || setpgid(0, 0)) return fixture_error("own-group");
  setvbuf(stdout, NULL, _IOLBF, 0);
  if (argc == 2 && !strcmp(argv[1], "leader")) {
    printf("{\"event\":\"leader-ready\",\"pid\":%d,\"ppid\":%d,\"pgid\":%d,\"sid\":%d,\"uid\":%d}\n",
      getpid(), getppid(), getpgrp(), getsid(0), (int)getuid());
    char command[32];
    (void)fgets(command, sizeof(command), stdin);
    return 0;
  }
  if (argc != 4 || strcmp(argv[1], "holder") ||
      (strcmp(argv[3], "zombie") && strcmp(argv[3], "live"))) return fixture_error("arguments");
  char *end = NULL;
  errno = 0;
  long requested = strtol(argv[2], &end, 10);
  if (errno || !end || *end || requested <= 1 || requested > INT_MAX) return fixture_error("target-pgid");
  pid_t target = (pid_t)requested;
  if (getpgid(target) != target || getsid(target) != getsid(0)) return fixture_error("same-session");
  int joined[2], release[2];
  if (pipe(joined) || pipe(release)) return fixture_error("pipes");
  pid_t child = fork();
  if (child < 0) return fixture_error("fork");
  if (child == 0) {
    close(joined[0]); close(release[1]);
    close(STDIN_FILENO); close(STDOUT_FILENO); close(STDERR_FILENO);
    int failed = setpgid(0, target);
    struct identity receipt = { getpid(), getppid(), getpgrp(), getsid(0), getuid(), failed ? errno : 0 };
    if (transfer(joined[1], &receipt, sizeof(receipt), 1)) _exit(71);
    close(joined[1]);
    if (failed) _exit(72);
    if (!strcmp(argv[3], "live")) {
      char value;
      while (read(release[0], &value, 1) < 0 && errno == EINTR) {}
    }
    close(release[0]);
    _exit(0);
  }
  close(joined[1]); close(release[0]);
  struct identity receipt;
  memset(&receipt, 0, sizeof(receipt));
  int failed = transfer(joined[0], &receipt, sizeof(receipt), 0);
  close(joined[0]);
  if (receipt.pid != child || receipt.ppid != getpid() || receipt.pgid != target ||
      receipt.sid != getsid(0) || receipt.uid != (int)getuid() || receipt.error) failed = 1;
  siginfo_t info;
  memset(&info, 0, sizeof(info));
  int zombie = !strcmp(argv[3], "zombie");
  if (!failed && zombie) {
    int result;
    do { result = waitid(P_PID, (id_t)child, &info, WEXITED | WNOWAIT); } while (result < 0 && errno == EINTR);
    if (result || info.si_pid != child || info.si_code != CLD_EXITED || info.si_status != 0) failed = 1;
  }
  if (!failed) {
    int printed = printf("{\"event\":\"holder-ready\",\"pid\":%d,\"ppid\":%d,\"pgid\":%d,\"sid\":%d,\"uid\":%d,\"p2\":%d,\"p2ppid\":%d,\"p2pgid\":%d,\"p2sid\":%d,\"p2uid\":%d,\"zombie\":%s,\"waitidPid\":%d,\"waitidCode\":%d,\"waitidStatus\":%d}\n",
      getpid(), getppid(), getpgrp(), getsid(0), (int)getuid(), child,
      receipt.ppid, receipt.pgid, receipt.sid, receipt.uid, zombie ? "true" : "false",
      info.si_pid, info.si_code, info.si_status);
    if (printed < 0 || fflush(stdout)) failed = 1;
  }
  if (!failed) {
    char command[32];
    (void)fgets(command, sizeof(command), stdin);
  }
  // EOF is also cleanup: release a live P2, then reap this exact direct child.
  close(release[1]);
  int child_status = 0;
  pid_t reaped;
  do { reaped = waitpid(child, &child_status, 0); } while (reaped < 0 && errno == EINTR);
  printf("{\"event\":\"reaped\",\"holder\":%d,\"pid\":%d,\"rawStatus\":%d,\"exitCode\":%d,\"signal\":%d,\"setupFailed\":%s}\n",
    getpid(), reaped, child_status, WIFEXITED(child_status) ? WEXITSTATUS(child_status) : -1,
    WIFSIGNALED(child_status) ? WTERMSIG(child_status) : 0, failed ? "true" : "false");
  fflush(stdout);
  return failed || reaped != child ? 70 : 0;
}
