import { atomicWriteShell, repoSymlinkGuardShell } from './repo-symlinks'
import { shq } from './shell'
// Runtime files powder keeps next to (or, in the workdir layout, inside) an
// app's git checkout: the deploy key, the server-local compose, DB data dirs.
// none of these may ever reach a docker build context, so every app
// directory powder creates gets a .dockerignore that excludes them.

export const DOCKERIGNORE_LINES = [
	'.deploy-key',
	'docker-compose.yml',
	'pgdata/',
	'kvdata/',
	'*.env',
	'.env*',
	'.git',
	'.powder-*',
] as const

/** Header + entries, one per line, newline-terminated. powder.json is kept in
 *  the context on purpose (it is not secret). */
export function dockerignoreContent(): string {
	return `# Written by powder: keeps deploy keys, compose secrets and DB data out of image layers.\n${DOCKERIGNORE_LINES.join('\n')}\n`
}

/** the entries that keep powder's secrets out of a build. They go
 *  LAST in a repo-supplied ignore file: a later `!.deploy-key` / `!*.env` line
 *  would re-include them. `.git` is not a powder secret: it is written only when
 *  powder creates the file, never added to a repo's own one (some apps COPY
 *  .git, others read .git/HEAD for their build sha). */
export const PROTECTED_DOCKERIGNORE_LINES: readonly string[] = DOCKERIGNORE_LINES.filter(
	(l) => l !== '.git',
)

export const DOCKERIGNORE_PROTECTED_MARKER =
	'# powder: protected entries, kept last so no earlier !negation re-includes them'

/** Shell: rewrite an EXISTING ignore file so powder's protected entries are its
 *  last lines (earlier copies of them and of the marker are dropped; nothing else
 *  is added, never `.git`). Temp file + mv, refuses a symlink. Idempotent. */
export function protectExistingIgnoreShell(file: string): string {
	const f = shq(file)
	const lines = [DOCKERIGNORE_PROTECTED_MARKER, ...PROTECTED_DOCKERIGNORE_LINES]
	return (
		`if [ -L ${f} ]; then echo ${shq(`refusing: ${file} is a symlink`)} >&2; exit 1; fi; ` +
		// a tracked directory (or fifo, ...) of that name is refused, never skipped.
		`if [ -e ${f} ] && [ ! -f ${f} ]; then echo ${shq(`refusing: ${file} is not a regular file`)} >&2; exit 1; fi; ` +
		`{ DI_T=$(mktemp "$(dirname ${f})/.powder-di.XXXXXX") && ` +
		`awk -v L=${shq(lines.join('|'))} 'BEGIN{n=split(L,a,"|");for(i=1;i<=n;i++)d[a[i]]=1} {sub(/\\r$/,"")} !($0 in d)' ${f} > "$DI_T" && ` +
		`printf '%s\\n' ${lines.map((l) => shq(l)).join(' ')} >> "$DI_T" && chmod 644 "$DI_T" && mv -f "$DI_T" ${f}; } || { echo ${shq(`refusing: could not write powder's entries into ${file}`)} >&2; exit 1; }`
	)
}

/** BuildKit reads `<Dockerfile>.dockerignore` next to the Dockerfile INSTEAD of the
 *  context's .dockerignore. The path for a context-relative Dockerfile, or null
 *  when it would leave the directory. */
function dockerfileIgnorePath(dir: string, dockerfile: string): string | null {
	const rel = dockerfile.replace(/^\.\//, '')
	if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return null
	return `${dir}/${rel}.dockerignore`
}

/** The ignore files only bind Docker's own Dockerfile frontend: a custom `# syntax=`
 *  frontend receives the whole context. build-cache.ts therefore refuses every
 *  `# syntax=` other than docker/dockerfile, and the compose guard and the
 *  builder refuse a BUILDKIT_SYNTAX build arg. */
/** Shell that creates <dir>/.dockerignore, or rewrites an existing one from the
 *  repo with powder's protected entries LAST (so a repo-supplied ignore file
 *  keeps working but cannot negate them). A `<Dockerfile>.dockerignore` next to
 *  the Dockerfile (default `Dockerfile`, plus `dockerfile` when given) gets the
 *  same treatment. Idempotent. */
export function writeDockerignoreShell(dir: string, dockerfile?: string): string {
	const b64 = Buffer.from(dockerignoreContent(), 'utf8').toString('base64')
	const f = shq(`${dir}/.dockerignore`)
	const extra = [
		...new Set(
			['Dockerfile', dockerfile]
				.filter((d): d is string => !!d)
				.map((d) => dockerfileIgnorePath(dir, d))
				.filter((p): p is string => p !== null),
		),
	]
	return (
		`if [ -f ${f} ] || [ -L ${f} ]; then ${protectExistingIgnoreShell(`${dir}/.dockerignore`)}; ` +
		// a tracked `.dockerignore/` directory (or any other non-file) is refused,
		// and a failed write stops the script instead of letting the chain go on.
		`elif [ -e ${f} ]; then echo ${shq(`refusing: ${dir}/.dockerignore is not a regular file`)} >&2; exit 1; ` +
		`else printf %s ${shq(b64)} | base64 -d > ${f} || { echo ${shq(`refusing: could not write ${dir}/.dockerignore`)} >&2; exit 1; }; fi` +
		extra
			.map((p) => `; if [ -e ${shq(p)} ] || [ -L ${shq(p)} ]; then ${protectExistingIgnoreShell(p)}; fi`)
			.join('')
	)
}

/** (interim layout fix). /new and previews clone the repo INTO the app
 *  directory, so a hostile repo can commit docker-compose.yml, .powder-* lock
 *  files or .deploy-key as symlinks to host files, and powder's root-run
 *  `> docker-compose.yml` would write through them. This shell, run right after
 *  the clone: refuses when any of those is a symlink, then installs the deploy
 *  key and the compose via temp file + `mv -f` (rename replaces a symlink
 *  instead of following it), then writes the .dockerignore. Exits non-zero on
 *  refusal. `keyTmp` is the planted key (moved to <workdir>/.deploy-key, 0600). */
export function writeRuntimeFilesShell(opts: {
	workdir: string
	composeTmp: string
	keyTmp?: string
	/** Context-relative Dockerfile path: its `<Dockerfile>.dockerignore` is protected too. */
	dockerfile?: string
}): string {
	const w = shq(opts.workdir)
	return (
		`set -e; cd ${w} && ` +
		// One authority removes (and refuses on) every hostile tracked link first.
		`${repoSymlinkGuardShell(opts.workdir)} || { echo "refusing: the repo tracks hostile symlink(s) (removed)" >&2; exit 1; }; ` +
		`for f in docker-compose.yml powder.json .deploy-key .dockerignore .powder-*; do ` +
		`  if [ -L "$f" ]; then echo "refusing: $f in the app directory is a symlink (repo-controlled link into the host)" >&2; exit 1; fi; ` +
		`done; ` +
		(opts.keyTmp ? `rm -rf .deploy-key; mv -f ${shq(opts.keyTmp)} .deploy-key && chmod 600 .deploy-key; ` : '') +
		`rm -f .powder-compose.tmp; ` +
		// the compose (it carries POSTGRES_PASSWORD) arrives via SFTP at 0600 in
		// composeTmp, never as base64 in a command line. install -m 600 unlinks any
		// existing dest first, so it cannot write through a link; the result is 0600.
		`install -m 600 ${shq(opts.composeTmp)} .powder-compose.tmp && ${atomicWriteShell('docker-compose.yml', '.powder-compose.tmp')} && chmod 600 docker-compose.yml; ` +
		`rm -f ${shq(opts.composeTmp)}; ` +
		writeDockerignoreShell(opts.workdir, opts.dockerfile)
	)
}
