// Builder phase failures as the builder script printed them: the last lines of
// real deploy outputs, with app, org and host names
// replaced. `localBuild` is what the local fallback build then did for the same
// deploy; `kind` is the verdict classifyBuilderFailure must give.

export interface BuilderFailureCase {
	name: string
	exit: number
	kind: 'app' | 'builder'
	localBuild: 'failed' | 'passed'
	output: string
}

const HEAD = [
	'── builder phase (198.51.100.7) ──',
	'[builder] fresh clone of git@github.com:example-org/demoapp.git',
	'[builder] built-sha 1111111111111111111111111111111111111111',
	'[builder] docker build ghcr.io/example-org/demoapp:latest (context /opt/builds/0123456789abcdef-demoapp/src)',
].join('\n')

const runFailed = (cmd: string) => `ERROR: failed to build: failed to solve: process "/bin/sh -c ${cmd}" did not complete successfully: exit code: 1`

export const BUILDER_FAILURE_CASES: BuilderFailureCase[] = [
	{
		name: 'RUN npm test fails (the test output itself prints 502 and network words)',
		exit: 1,
		kind: 'app',
		localBuild: 'failed',
		output: `${HEAD}
#14 4.117 stderr | tests/mail-relay.test.ts > relay batch > batch partial SES failure returns 200 with data + errors
#14 4.117 [mail-relay] ses error name=MessageRejected message=rej
#14 5.902  ❯ tests/feedback-widget.test.ts (10 tests | 10 failed) 49ms
#14 6.310 AssertionError: expected 502 to be 200
#14 ERROR: process "/bin/sh -c npm test" did not complete successfully: exit code: 1
--------------------
  14 |     # the whole fleet's alerts. The old container keeps serving on failure.
  15 | >>> RUN npm test
  16 |     RUN npm run build
--------------------
${runFailed('npm test')}`,
	},
	{
		name: 'RUN lint && docs check && test fails, output cut in the middle',
		exit: 1,
		kind: 'app',
		localBuild: 'failed',
		output: `${HEAD}
#15 61.35     "            WHERE _sfr.user_id = s.user_id AND _sfr.role IN ('admin', 'moderator'))\\n"
[... output truncated ...]
: process "/bin/sh -c npm run lint && npm run docs:check && npm test" did not complete successfully: exit code: 1`,
	},
	{
		name: 'RUN yarn typecheck && formatcheck && lint fails',
		exit: 1,
		kind: 'app',
		localBuild: 'failed',
		output: `${HEAD}
#14 41.20 error Command failed with exit code 1.
#14 ERROR: process "/bin/sh -c yarn typecheck && yarn formatcheck && yarn lint" did not complete successfully: exit code: 1
--------------------
  37 | >>> RUN yarn typecheck && yarn formatcheck && yarn lint
  38 |     RUN yarn build
--------------------
${runFailed('yarn typecheck && yarn formatcheck && yarn lint')}`,
	},
	{
		name: 'RUN pnpm --filter <pkg> test fails',
		exit: 1,
		kind: 'app',
		localBuild: 'failed',
		output: `${HEAD}
--------------------
  40 | >>> RUN pnpm --filter @demoapp/api test
  41 |     RUN pnpm --filter @demoapp/web check-i18n
--------------------
${runFailed('pnpm --filter @demoapp/api test')}`,
	},
	{
		name: 'RUN npm run build fails on a type error',
		exit: 1,
		kind: 'app',
		localBuild: 'failed',
		output: `${HEAD}
#11 38.02 scripts/check-db-gate.ts(57,151): error TS2300: Duplicate identifier 'previousValueOf'.
#11 38.02 scripts/check-db-gate.ts(123,10): error TS2300: Duplicate identifier 'previousValueOf'.
#11 38.11 Failed to type check.
#11 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1
--------------------
  14 | >>> RUN npm run build
--------------------
${runFailed('npm run build')}`,
	},
	{
		name: 'RUN npm ci rejects the lockfile of the commit',
		exit: 1,
		kind: 'app',
		// the fallback passed here, but on another commit: the builder had built the branch
		// head, the fallback the older commit the deploy asked for (see the sha test).
		localBuild: 'passed',
		output: `${HEAD}
#8 1.130 npm error code EUSAGE
#8 1.130 npm error \`npm ci\` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with \`npm install\` before continuing.
#8 1.130 npm error Missing: @swc/helpers@0.5.23 from lock file
#8 ERROR: process "/bin/sh -c npm ci --ignore-scripts" did not complete successfully: exit code: 1
--------------------
   7 | >>> RUN npm ci --ignore-scripts
--------------------
${runFailed('npm ci --ignore-scripts')}`,
	},
	{
		name: 'the commit has no Dockerfile',
		exit: 1,
		kind: 'app',
		localBuild: 'failed',
		output: `${HEAD}
[build-cache] no Dockerfile at /opt/builds/0123456789abcdef-demoapp/src/Dockerfile`,
	},
	{
		name: 'the Dockerfile check refuses an ADD from a URL',
		exit: 1,
		kind: 'app',
		localBuild: 'failed',
		output: `${HEAD}
[build-cache] refusing /opt/builds/0123456789abcdef-demoapp/src/Dockerfile: an ADD source that is a URL is not supported (BuildKit fetches it inside dockerd as root on the host, with root's git and registry credentials); download it in a RUN step or COPY it from the repo: https://deb.debian.org/deb
[build-cache] 0 cache mount(s) in /opt/builds/0123456789abcdef-demoapp/src/Dockerfile isolated to this app`,
	},
	{
		name: 'COPY of a file the repo does not have',
		exit: 1,
		kind: 'app',
		localBuild: 'failed',
		output: `${HEAD}
--------------------
   7 | >>> COPY package.json package-lock.json ./
   8 |     RUN git init && npm ci
--------------------
ERROR: failed to build: failed to solve: failed to compute cache key: failed to calculate checksum of ref 0q15i10t0xhakd7w28jkl8p91::3qcq3fo3bamwpn371fgfq5i0p: "/package-lock.json": not found`,
	},
	{
		name: 'RUN npm run build: Turbopack could not download a Google font',
		exit: 1,
		kind: 'builder',
		localBuild: 'passed',
		output: `${HEAD}
#15 46.75 > Build error occurred
#15 46.76 Error: Turbopack build failed with 8 errors:
#15 46.76 [next]/internal/font/google/playfair_display_66e51319.module.css:8:9
#15 46.76 Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'
#15 46.76 next/font/google queries have exactly one entry
#15 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1
${runFailed('npm run build')}`,
	},
	{
		name: 'RUN npm run build: the webpack next/font loader got no font',
		exit: 1,
		kind: 'builder',
		localBuild: 'passed',
		output: `${HEAD}
#13 11.59 Failed to compile.
#13 11.59 An error occurred in \`next/font\`.
#13 11.59 TypeError: Cannot read properties of null (reading '1')
#13 11.59     at /app/node_modules/next/dist/compiled/@next/font/dist/google/loader.js:122:78
#13 11.59 > Build failed because of webpack errors
#13 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1
${runFailed('npm run build')}`,
	},
	{
		name: 'RUN corepack prepare: the npm registry answered 503',
		exit: 1,
		kind: 'builder',
		localBuild: 'passed',
		output: `${HEAD}
#8 121.8 Internal Error: Server answered with HTTP 503 when performing the request to https://registry.npmjs.org/pnpm/10.21.0; for troubleshooting help, see https://github.com/nodejs/corepack#troubleshooting
#8 ERROR: process "/bin/sh -c corepack enable && corepack prepare pnpm@10.21.0 --activate" did not complete successfully: exit code: 1
${runFailed('corepack enable && corepack prepare pnpm@10.21.0 --activate')}`,
	},
	{
		name: 'RUN npm run build needs a database that only the app server has',
		exit: 1,
		kind: 'builder',
		localBuild: 'passed',
		output: `${HEAD}
#15 49.73 Failed to fetch daily quote: Error: connect ECONNREFUSED 127.0.0.1:5435
#15 49.73   code: 'ECONNREFUSED',
#15 51.63 Export encountered an error on /quotes/archive/page: /quotes/archive, exiting the build.
#15 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1
${runFailed('npm run build')}`,
	},
	{
		name: 'RUN pnpm build ran out of heap',
		exit: 1,
		kind: 'builder',
		localBuild: 'failed',
		output: `${HEAD}
#26 88.40 FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
#26 ERROR: process "/bin/sh -c pnpm build" did not complete successfully: exit code: 1
${runFailed('pnpm build')}`,
	},
	{
		name: 'RUN npm run build killed (exit code 137)',
		exit: 1,
		kind: 'builder',
		localBuild: 'passed',
		output: `${HEAD}
#11 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 137
ERROR: failed to build: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 137`,
	},
	{
		name: 'the test gate image could not be pulled',
		exit: 1,
		kind: 'builder',
		localBuild: 'passed',
		output: `${HEAD}
#22 DONE 30.5s
── test gate ──
[builder test-gate] .powder/test.sh present - running in node:22-alpine (a non-zero exit blocks the swap)
[builder test-gate] refusing: the pull of node:22-alpine failed and no local copy can be trusted (a local tag may be another app's build: a RepoDigest is no proof of a pull; only a digest-pinned powder-test-image whose local copy has that digest and no compose labels runs without the registry). Retry when the registry answers, or pin the image by digest.`,
	},
	{
		name: 'the clone was refused (deploy key)',
		exit: 128,
		kind: 'builder',
		localBuild: 'failed',
		output: `── builder phase (198.51.100.7) ──
[builder] fresh clone of git@github.com:example-org/demoapp.git
[builder] clone attempt 2 failed, retrying
Cloning into '/opt/builds/0123456789abcdef-demoapp/src'...
git@github.com: Permission denied (publickey).
fatal: Could not read from remote repository.
Please make sure you have the correct access rights
and the repository exists.`,
	},
	{
		name: 'the ssh connection to the build host dropped mid-build',
		exit: 255,
		kind: 'builder',
		localBuild: 'passed',
		output: `${HEAD}
#9 12.01 npm notice To update run: npm install -g npm@12.2.1
#9 12.01 npm notice`,
	},
	{
		name: 'the builder script was killed at its deadline while a test step ran',
		exit: 124,
		kind: 'builder',
		localBuild: 'passed',
		output: `${HEAD}
#14 ERROR: process "/bin/sh -c npm test" did not complete successfully: exit code: 1`,
	},
]

/** A real build (names replaced) whose install step printed npm's lockfile error and
 *  PASSED (`npm ci || npm install`); a later step failed. `lastStep` is that step's
 *  output: the real one (type errors), or a build host fault put in its place. */
export const lockfileErrorInAPassedStep = (lastStep: string[]): string =>
	[
		'── builder phase (198.51.100.7) ──',
		'[builder] fresh clone of git@github.com:example-org/demoapp.git',
		'[builder] built-sha 1111111111111111111111111111111111111111',
		'#14 [deps 4/4] RUN git init && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund)',
		'#14 1.937 npm error code EUSAGE',
		'#14 1.937 npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.',
		'#14 1.937 npm error Missing: @opentelemetry/api@1.9.1 from lock file',
		'#14 1.937 npm error Missing: picomatch@2.3.2 from lock file',
		'#14 44.02 added 751 packages in 42s',
		'#14 DONE 44.6s',
		'#18 [builder 6/6] RUN npm run build',
		...lastStep.map((l) => `#18 18.23 ${l}`),
		'#18 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
		'--------------------',
		'  19 |     ENV DATABASE_URL=postgresql://[redacted]@localhost:5432/dummy',
		'  20 | >>> RUN npm run build',
		'--------------------',
		'ERROR: failed to build: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1',
	].join('\n')

/** What that build's last step really printed. */
export const LOCKFILE_CASE_REAL_LAST_STEP = [
	'tests/integration/api-profile.test.ts(47,25): error TS2554: Expected 1 arguments, but got 0.',
	'tests/integration/api-profile.test.ts(65,25): error TS2554: Expected 1 arguments, but got 0.',
	'Failed to type check.',
]

/** A real check-only step (names replaced) that died on the Node heap limit on the
 *  build host; the local fallback build of the same deploy passed. */
export const CHECK_STEP_HEAP_OOM = [
	'── builder phase (198.51.100.7) ──',
	'[builder] built-sha 1111111111111111111111111111111111111111',
	'#15 [builder 6/7] RUN yarn typecheck && yarn formatcheck && yarn lint',
	'#15 0.462 $ tsc --noEmit',
	'#15 44.70 FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',
	'#15 45.21 error Command failed with signal "SIGABRT".',
	'#15 ERROR: process "/bin/sh -c yarn typecheck && yarn formatcheck && yarn lint" did not complete successfully: exit code: 1',
	'ERROR: failed to build: failed to solve: process "/bin/sh -c yarn typecheck && yarn formatcheck && yarn lint" did not complete successfully: exit code: 1',
].join('\n')
