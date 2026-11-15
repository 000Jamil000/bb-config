/* Small Login Items launcher. Exec the original Node with unchanged arguments
 * and environment; do not replace its runtime or macOS privacy identity. */
#include <mach-o/dyld.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    char self[PATH_MAX], config[PATH_MAX], runtime[PATH_MAX];
    uint32_t length = sizeof(self);
    if (_NSGetExecutablePath(self, &length) != 0) return 126;
    char *separator = strrchr(self, '/');
    if (!separator) return 126;
    *separator = '\0'; /* Contents/MacOS */
    separator = strrchr(self, '/');
    if (!separator) return 126;
    *separator = '\0'; /* Contents */
    if (snprintf(config, sizeof(config), "%s/Resources/node-path.txt", self) >= sizeof(config)) return 126;
    FILE *file = fopen(config, "r");
    if (!file || !fgets(runtime, sizeof(runtime), file)) return 126;
    fclose(file);
    runtime[strcspn(runtime, "\r\n")] = '\0';
    if (runtime[0] != '/') return 126;
    argv[0] = runtime;
    execv(runtime, argv);
    fprintf(stderr, "Unable to start the existing service runtime: %s\n", strerror(errno));
    return 126;
}
