// Build host failures inside a Dockerfile RUN step that is not a test, lint or
// type check step: the disk, memory, DNS, registries, downloads in install
// scripts, services only the app's server reaches, a damaged cache mount. Each
// is [label, RUN command, output lines of the step]. None is proof against the
// commit, so classifyBuilderFailure must keep the local fallback for every one.

/** The builder script's output for a RUN step that printed `lines` and exited `code`. */
export const runStepFailure = (cmd: string, lines: string[], code = 1): string =>
	`── builder phase (198.51.100.7) ──\n[builder] fresh clone of git@github.com:example-org/demoapp.git\n[builder] built-sha ${'a'.repeat(40)}\n#0 building with "default" instance using docker driver\n#8 [deps 3/3] RUN ${cmd}\n` +
	lines.map((l) => `#8 12.34 ${l}`).join('\n') +
	`\n#8 ERROR: process "/bin/sh -c ${cmd}" did not complete successfully: exit code: ${code}\n------\nERROR: failed to build: failed to solve: process "/bin/sh -c ${cmd}" did not complete successfully: exit code: ${code}\n`

export const BUILD_HOST_RUN_FAILURES: [string, string, string[]][] = [
	['npm ECONNRESET', 'npm ci', ['npm error code ECONNRESET', 'npm error network aborted']],
	['npm Exit handler never called', 'npm ci', ['npm error Exit handler never called!', 'npm error This is an error with npm itself. Please report this error at:', 'npm error   <https://github.com/npm/cli/issues>']],
	['npm zlib truncated tarball', 'npm ci', ['npm warn tarball tarball data for typescript@5.6.3 (sha512-abc) seems to be corrupted. Trying again.', 'npm error code Z_BUF_ERROR', 'npm error errno -5', 'npm error zlib: unexpected end of file']],
	['npm E401 private registry', 'npm ci', ['npm error code E401', 'npm error Incorrect or missing password.']],
	['npm E403 mirror', 'npm ci', ['npm error code E403', 'npm error 403 403 Forbidden - GET https://npm.pkg.github.com/@org/pkg']],
	['npm EIDLETIMEOUT code only', 'npm ci', ['npm error code EIDLETIMEOUT']],
	['npm ERR_SSL', 'npm ci', ['npm error code ERR_SSL_WRONG_VERSION_NUMBER', 'npm error errno ERR_SSL_WRONG_VERSION_NUMBER']],
	['pnpm FETCH_503 (mirror url)', 'pnpm install --frozen-lockfile', [' ERR_PNPM_FETCH_503  GET https://npm.example-mirror.dev/react: Service Unavailable - 503']],
	['pnpm ERR_PNPM_FETCH_403', 'pnpm install --frozen-lockfile', [' ERR_PNPM_FETCH_403  GET https://npm.pkg.github.com/@org/x: Forbidden - 403']],
	['pnpm bad tarball size', 'pnpm install --frozen-lockfile', [' ERR_PNPM_BAD_TARBALL_SIZE  Actual size (1048576) of tarball (https://npm.example-mirror.dev/x.tgz) did not match the one specified in \'Content-Length\' header (2097152)']],
	['pnpm recursive OOM (exit status 137)', 'pnpm -r build', ['apps/web build: Failed', ' ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  web@0.1.0 build: `next build`', 'Exit status 137']],
	['turbo task exited 137', 'pnpm turbo run build', ['web:build: ERROR: command finished with error: command (/app/apps/web) /usr/local/bin/pnpm run build exited (137)', ' ERROR  run failed: command  exited (137)']],
	['yarn v1 exit 137 wrapped by sh', 'yarn install && yarn build', ['error Command failed with exit code 137.', 'info Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.']],
	['bun ConnectionRefused', 'bun install --frozen-lockfile', ['error: ConnectionRefused downloading tarball left-pad@1.3.0']],
	['bun ConnectionClosed', 'bun install --frozen-lockfile', ['error: ConnectionClosed downloading package manifest react']],
	['go compile killed (lowercase)', 'go build -o /app ./cmd/server', ['go build github.com/x/y/internal/gen: /usr/local/go/pkg/tool/linux_amd64/compile: signal: killed']],
	['go DNS server misbehaving', 'go mod download', ['go: github.com/a/b@v1.2.3: Get "https://proxy.golang.org/github.com/a/b/@v/v1.2.3.mod": dial tcp: lookup proxy.golang.org on 127.0.0.11:53: server misbehaving']],
	['apk temporary error (DNS)', 'apk add --no-cache git', ['fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz', 'WARNING: fetching https://dl-cdn.alpinelinux.org/alpine/v3.20/main: temporary error (try again later)', 'ERROR: unable to select packages:', '  git (no such package):', '    required by: world[git]']],
	['apk DNS lookup error', 'apk add --no-cache libc6-compat', ['WARNING: updating and opening https://dl-cdn.alpinelinux.org/alpine/v3.21/main: DNS lookup error', 'ERROR: unable to select packages:', '  libc6-compat (no such package):']],
	['apk could not connect (lowercase)', 'apk add --no-cache curl', ['WARNING: fetching https://dl-cdn.alpinelinux.org/alpine/v3.20/main: could not connect to server (check repositories file)', 'ERROR: unable to select packages:']],
	['apk disk full (capital N)', 'apk add --no-cache python3 make g++', ['ERROR: Failed to create usr/lib/libstdc++.so.6.0.33: No space left on device', 'ERROR: gcc-13.2.1_git20240309-r0: No space left on device']],
	['apt disk full', 'apt-get update && apt-get install -y openssl', ['E: You don\'t have enough free space in /var/cache/apt/archives/.']],
	['dpkg disk full', 'apt-get install -y build-essential', ['dpkg: error processing archive /var/cache/apt/archives/x.deb (--unpack):', ' cannot copy extracted data for \'./usr/bin/x\' to \'/usr/bin/x.dpkg-new\': failed to write (No space left on device)']],
	['cp/tar disk full', 'cp -r .next/standalone ./out', ['cp: error writing \'./out/server.js\': No space left on device']],
	['pip disk full', 'pip install -r requirements.txt', ['ERROR: Could not install packages due to an OSError: [Errno 28] No space left on device']],
	['node ENOSPC', 'npm run build', ['Error: ENOSPC: no space left on device, write']],
	['curl failed to connect', 'curl -fsSL https://example.com/install.sh | sh', ['curl: (7) Failed to connect to example.com port 443 after 130312 ms: Couldn\'t connect to server']],
	['curl 403 github rate limit', 'curl -fsSLO https://github.com/x/y/releases/download/v1/bin.tgz', ['curl: (22) The requested URL returned error: 403']],
	['curl SSL syscall', 'curl -fsSL https://example.com/x -o x', ['curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL in connection to example.com:443']],
	['curl partial transfer', 'curl -fsSL https://example.com/x -o x', ['curl: (18) transfer closed with 81203 bytes remaining to read']],
	['busybox wget bad address', 'wget -qO- https://example.com/x.tgz | tar xz', ['wget: bad address \'example.com\'', 'tar: short read']],
	['prisma P1001 DB unreachable from builder', 'npx prisma migrate deploy && npm run build', ['Error: P1001: Can\'t reach database server at `127.0.0.1:5435`', 'Please make sure your database server is running at `127.0.0.1:5435`.']],
	['prisma engines download', 'npx prisma generate', ['Error: request to https://binaries.prisma.sh/all_commits/abc/linux-musl-openssl-3.0.x/libquery_engine.so.node.gz failed, reason: ', 'Error: aborted']],
	['pg hostname not known', 'npm run build', ['error: could not translate host name "db" to address: Name does not resolve']],
	['pg Connection terminated', 'npm run build', ['Error: Connection terminated unexpectedly', '    at Connection.<anonymous> (/app/node_modules/pg/lib/client.js:136:73)']],
	['pg_hba builder IP not allowed', 'npm run build', ['error: no pg_hba.conf entry for host "198.51.100.7", user "app", database "app", no encryption']],
	['build-time API returns HTML error page', 'npm run build', ['SyntaxError: Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON', 'Error occurred prerendering page "/blog". Read more: https://nextjs.org/docs/messages/prerender-error']],
	['build-time API 403 (IP allowlist)', 'npm run build', ['Error: Request failed with status code 403', 'Export encountered an error on /page: /, exiting the build.']],
	['playwright download failed', 'npx playwright install --with-deps chromium', ['Error: Download failure, code=1', 'Failed to install browsers', 'Error: Failed to download Chromium 131.0.6778.33 (playwright build v1148), caused by', 'Error: Download failure, code=1']],
	['sharp install aborted', 'npm ci', ['npm error sharp: Installation error: aborted', 'npm error sharp: Please see https://sharp.pixelplumbing.com/install for required dependencies']],
	['node-gyp 403 headers', 'npm ci', ['npm error gyp ERR! stack Error: 403 status code downloading tarball https://unofficial-builds.nodejs.org/download/release/v22.11.0/node-v22.11.0-headers.tar.gz']],
	['next worker SIGKILL', 'npm run build', ['Next.js build worker exited with code: null and signal: SIGKILL']],
	['sh Killed', 'npm run build', ['Killed']],
	['heap OOM', 'npm run build', ['FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory']],
	['next: build worker exited code 137 no signal text', 'npm run build', ['Error: Static worker exited with code: 137 and signal: null']],
	['bun segfault', 'bun run build', ['panic(main thread): Segmentation fault at address 0x0', 'oh no: Bun has crashed. This indicates a bug in Bun, not your code.']],
	['EMFILE / ENFILE', 'npm run build', ['Error: EMFILE: too many open files, open \'/app/node_modules/x/index.js\'']],
	['EAGAIN spawn / pids limit', 'npm run build', ['Error: spawn /bin/sh EAGAIN']],
	['pthread_create resource', 'npm run build', ['node[1]: pthread_create: Resource temporarily unavailable']],
	['cannot allocate memory', 'npm ci', ['npm error errno -12', 'npm error spawn E_NOMEM_x', 'sh: can\'t fork: Cannot allocate memory']],
	['I/O error (disk)', 'npm ci', ['npm error code EIO', 'npm error EIO: i/o error, write']],
	['Read-only file system', 'npm ci', ['npm error code EROFS', 'npm error EROFS: read-only file system, mkdir \'/root/.npm/_cacache\'']],
	['cache mount corrupted', 'npm ci', ['npm error code ENOENT', 'npm error syscall open', 'npm error path /root/.npm/_cacache/content-v2/sha512/ab/cd/ef', 'npm error enoent ENOENT: no such file or directory, open \'/root/.npm/_cacache/content-v2/sha512/ab/cd/ef\'']],
	['cache mount ENOTEMPTY', 'npm ci', ['npm error code ENOTEMPTY', 'npm error syscall rename', 'npm error ENOTEMPTY: directory not empty, rename \'/root/.npm/_cacache/tmp/x\' -> \'/root/.npm/_cacache/y\'']],
	['sentry upload 401', 'npm run build', ['error: API request failed', '  caused by: sentry reported an error: Invalid token (http status: 401)']],
	['git clone in RUN fails (auth/rate)', 'git clone https://github.com/x/y.git /opt/y', ['fatal: unable to access \'https://github.com/x/y.git/\': The requested URL returned error: 403']],
	['git RPC failed', 'npm ci', ['npm error code 128', 'npm error error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly: CANCEL (err 8)', 'npm error fatal: early EOF']],
	['docker hub in RUN skopeo denied', 'npm run build', ['Error: read ECONNRESET']],
]
