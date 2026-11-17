import { posix } from 'node:path'
import { stateKeyFor } from '../compose-override'
import { parseComposeYaml } from '../compose-safety'
import { atomicWriteShell, atomicWriteShellRaw, noSymlinkBelowShell } from '../repo-symlinks'
import type { ServerConfig } from '../servers'
import { explainSshError } from '../ssh-host-keys'
import { SAFE_NAME, shq } from '../shell'
import { randomTempPath } from '../temp-path'
import { runCommand, withConnection } from './connection'
import { inspectContainer } from './discovery'

// Ordered candidates we try when looking for an env file for a given container.
// First match wins; if none exist, the FIRST candidate is the "preferred" path
// where a new env file would be created.
//
// Real-world patterns we've seen:
//   - host-nginx convention: /opt/apps/<container>.env or /opt/apps/<project>.env
//   - shared-compose convention: <workingDir>/env/<service>.env (shared compose project, per-service file)
//   - default compose: <workingDir>/.env (variable substitution file)
// `env_file:` paths from a compose file, in file order. Handles all three forms:
//   env_file: /path/a.env
//   env_file: [/path/a.env, /path/b.env]       (inline flow list)
//   env_file:\n  - /path/a.env\n  - /path/b.env (block list)
// The inline form must not come back as the literal "[a, b]": the DB render
// would then write to that bogus path and the app would never see its env
// changes.
//
// A relative `env_file: .env` is relative to the COMPOSE FILE's dir (compose
// semantics), not the ssh cwd (/root). With `configFile` it is resolved against
// dirname(configFile); without a base it is dropped. Every result is normalised; powder
// writes the rendered env there as root, so system locations are refused (deny-list).
// Other absolute paths stay allowed on purpose: a stack can keep app env
// files in a shared env dir of its own.
const ENV_FILE_DENY = ['/root', '/etc', '/var/lib/powder', '/proc', '/sys', '/dev', '/boot', '/usr', '/bin', '/sbin'] as const

export function isDeniedEnvPath(abs: string): boolean {
	if (abs === '/' || /^\/lib[^/]*(\/|$)/.test(abs)) return true
	return ENV_FILE_DENY.some((d) => abs === d || abs.startsWith(`${d}/`))
}

export function composeEnvFilePaths(compose: string, configFile?: string): string[] {
	const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '').trim()
	const out: string[] = []
	const lines = compose.split('\n')
	for (let i = 0; i < lines.length; i++) {
		const m = (lines[i] ?? '').match(/^(\s*)env_file:\s*(.*?)\s*(#.*)?$/)
		if (!m) continue
		const indent = (m[1] ?? '').length
		const rest = m[2] ?? ''
		if (rest.startsWith('[')) {
			out.push(...rest.replace(/^\[|\]$/g, '').split(',').map(unquote))
		} else if (rest) {
			out.push(unquote(rest))
		} else {
			for (let j = i + 1; j < lines.length; j++) {
				const line = lines[j] ?? ''
				if (!line.trim() || line.trim().startsWith('#')) continue
				const item = line.match(/^(\s*)-\s+(.*?)\s*(#.*)?$/)
				const lineIndent = line.length - line.trimStart().length
				// `required: false` etc. under a long-form item
				if (!item && lineIndent > indent) continue
				if (!item || (item[1] ?? '').length < indent) break
				// long form `- path: /x.env` (compose ≥2.24)
				out.push(unquote((item[2] ?? '').replace(/^path:\s*/, '')))
			}
		}
	}
	return resolveEnvFilePaths(out, configFile)
}

/** Absolute, normalised env_file paths (relative to the compose file's dir); drops
 *  interpolated, ~, URL-ish and denied system paths. */
function resolveEnvFilePaths(out: string[], configFile?: string): string[] {
	const base = configFile?.startsWith('/') ? posix.dirname(configFile) : null
	const resolved: string[] = []
	for (const p of out) {
		if (!p || p.startsWith('-') || p.includes(':') || p.includes('$') || p.startsWith('~')) continue
		const abs = p.startsWith('/') ? posix.normalize(p) : base ? posix.resolve(base, p) : null
		if (!abs || isDeniedEnvPath(abs)) continue
		resolved.push(abs)
	}
	return resolved
}

/** the env_file paths of ONE service of a compose file (YAML parsed, merge
 *  keys applied), so another service a repo adds to the compose can never put its
 *  env_file first in line for powder's root write. `service` null: the service whose
 *  key or container_name is `containerName`, else the only service. [] when the
 *  file does not parse or names no such service. */
export function composeServiceEnvFilePaths(
	compose: string,
	service: string | null,
	containerName: string,
	configFile?: string,
): string[] {
	let doc: unknown
	try {
		doc = parseComposeYaml(compose)
	} catch {
		return []
	}
	const services = (doc as { services?: Record<string, unknown> } | null)?.services
	if (!services || typeof services !== 'object') return []
	let key = service && service in services ? service : null
	if (!key && !service) {
		const entries = Object.entries(services)
		key =
			(containerName in services ? containerName : null) ??
			entries.find(([, v]) => (v as { container_name?: unknown } | null)?.container_name === containerName)?.[0] ??
			(entries.length === 1 ? (entries[0]?.[0] ?? null) : null)
	}
	if (!key) return []
	const ef = (services[key] as { env_file?: unknown } | null)?.env_file
	const list = ef === undefined || ef === null ? [] : Array.isArray(ef) ? ef : [ef]
	const raw = list
		.map((e) => (typeof e === 'string' ? e : typeof (e as { path?: unknown })?.path === 'string' ? (e as { path: string }).path : ''))
		.map((e) => e.trim())
	return resolveEnvFilePaths(raw, configFile)
}

/** Candidates when the container does not exist yet: the compose file's env_file:
 *  entries (/opt/apps/<name>/docker-compose.yml), then /opt/apps/<name>.env. */
async function noContainerEnvCandidates(server: ServerConfig, containerName: string): Promise<string[]> {
	const out: string[] = []
	const configFile = `/opt/apps/${containerName}/docker-compose.yml`
	try {
		const { stdout, code } = await runCommand(server, `cat ${shq(configFile)}`, 5_000)
		if (code === 0) {
			for (const p of composeServiceEnvFilePaths(stdout, null, containerName, configFile))
				if (!out.includes(p)) out.push(p)
		}
	} catch {
		// no compose file either: just the convention path
	}
	const conv = `/opt/apps/${containerName}.env`
	if (!out.includes(conv)) out.push(conv)
	return out
}

export async function envFileCandidatesFor(
	server: ServerConfig,
	containerName: string,
): Promise<string[]> {
	let detail: Awaited<ReturnType<typeof inspectContainer>> | null = null
	try {
		detail = await inspectContainer(server, containerName)
	} catch (err) {
		// First deploy of a hand-registered app: the container never existed. Mirror
		// resolveComposeFacts (deploy-runner.ts): fall back to the /opt/apps/<name>
		// convention ONLY for "no such container"; anything else is a real failure.
		const msg = err instanceof Error ? err.message : String(err)
		if (!/no such (object|container)/i.test(msg)) throw err
	}
	if (!detail) return noContainerEnvCandidates(server, containerName)
	const project = detail.compose.project
	const service = detail.compose.service
	const workingDir = detail.compose.workingDir
	const configFile = detail.compose.configFile
	const candidates: string[] = []

	// Highest priority: parse `env_file:` directly from the compose file. This is
	// what the running container actually uses. Without this, we'd happily edit
	// /opt/apps/<name>.env even when compose points elsewhere — and the changes
	// would never take effect.
	if (configFile) {
		try {
			const { stdout, code } = await runCommand(server, `cat ${shq(configFile)}`, 5_000)
			if (code === 0) {
				// Only the app's OWN service's env_file, never another service's.
				for (const p of composeServiceEnvFilePaths(stdout, service, containerName, configFile)) {
					if (!candidates.includes(p)) candidates.push(p)
				}
			}
		} catch {
			// fall through to heuristic candidates
		}
	}

	candidates.push(`/opt/apps/${containerName}.env`)
	if (project && project !== containerName) {
		candidates.push(`/opt/apps/${project}.env`)
	}
	if (workingDir && service) {
		candidates.push(`${workingDir}/env/${service}.env`)
		candidates.push(`${workingDir}/${service}.env`)
		candidates.push(`${workingDir}/${service}/.env`)
	}
	if (workingDir) {
		candidates.push(`${workingDir}/.env`)
		candidates.push(`${workingDir}/.env.production`)
	}
	return candidates
}

export async function findEnvFile(
	server: ServerConfig,
	containerName: string,
): Promise<{ path: string; exists: boolean; contents: string; candidates: string[] }> {
	const candidates = await envFileCandidatesFor(server, containerName)
	for (const path of candidates) {
		const { exists, contents } = await readEnvFile(server, path)
		if (exists) return { path, exists: true, contents, candidates }
	}
	// none exist — caller can create one at the preferred (first) candidate
	return { path: candidates[0] ?? '', exists: false, contents: '', candidates }
}

/** Shell function `envread_ok <path>` (read side): true when reading the
 *  path as root cannot land in another app's env file. A path with no symlink in it
 *  (readlink -f gives the path back) passes. Otherwise the fully resolved target must
 *  be the owner's own /opt/apps/<X>.env or inside the owner's dir: X is taken from the
 *  path (/opt/apps/<X>.env, /opt/apps/<X>/...); any other path's owner dir is its own
 *  directory. So `/opt/apps/<app>/.env -> /opt/apps/<app>.env` reads, and a link a
 *  container planted to /opt/apps/<other>.env does not. */
export const ENV_READ_GUARD_FN =
	`envread_ok() { ER_P="$1"; ER_T=$(readlink -f -- "$ER_P" 2>/dev/null) || return 1; [ -n "$ER_T" ] || return 1; [ "$ER_T" = "$ER_P" ] && return 0; ` +
	`case "$ER_P" in /opt/apps/*/*) ER_X=\${ER_P#/opt/apps/}; ER_X=\${ER_X%%/*};; /opt/apps/*.env) ER_X=\${ER_P#/opt/apps/}; ER_X=\${ER_X%.env};; *) ER_X="";; esac; ` +
	`if [ -n "$ER_X" ] && [ "$ER_X" != "." ] && [ "$ER_X" != ".." ]; then ER_R="/opt/apps/$ER_X"; ER_O=$(readlink -f -- "/opt/apps/$ER_X.env" 2>/dev/null || true); [ -n "$ER_O" ] && [ "$ER_T" = "$ER_O" ] && return 0; else ER_R="\${ER_P%/*}"; fi; ` +
	`ER_RR=$(readlink -f -- "$ER_R" 2>/dev/null || true); [ -n "$ER_RR" ] && [ "$ER_RR" != / ] && case "$ER_T" in "$ER_RR"/*) return 0;; esac; return 1; }; `

const ENV_READ_REFUSED = '__LINK_OUTSIDE__'

export async function readEnvFile(
	server: ServerConfig,
	path: string,
): Promise<{ exists: boolean; contents: string }> {
	const { stdout, stderr, code } = await runCommand(
		server,
		`${ENV_READ_GUARD_FN}if [ -f ${shq(path)} ]; then if envread_ok ${shq(path)}; then base64 < ${shq(path)}; else echo ${ENV_READ_REFUSED}; fi; else echo __MISSING__; fi`,
	)
	// A failed read is NOT an empty file. Callers (the deploy-time drift guard
	// above all) treat "empty" as "nothing on disk to protect" — an SSH blip
	// read as empty would let the DB render overwrite disk-only secrets.
	if (code !== 0) throw new Error(`could not read ${path} on ${server.host} (exit ${code}): ${stderr.trim().slice(0, 200)}`)
	const trimmed = stdout.trim()
	if (trimmed === '__MISSING__') return { exists: false, contents: '' }
	if (trimmed === ENV_READ_REFUSED)
		throw new Error(
			`refusing to read ${path} on ${server.host}: it is a symlink (or under one) that resolves outside this app, possibly planted to read another app's env file. Remove the link on the server.`,
		)
	const decoded = Buffer.from(trimmed, 'base64').toString('utf8')
	return { exists: true, contents: decoded }
}

// Bulk env-file fetch: a single SSH that, for each container, tries the standard
// `/opt/apps/<name>.env` path first, then falls back to `<workingDir>/.env` when
// that's recorded by compose. Returns a map of containerName → {path, contents}.
// Designed for the global env-vars dashboard: one SSH per server per render
// instead of one round trip per app.
export async function bulkReadAppEnvFiles(
	server: ServerConfig,
	containerNames: string[],
): Promise<Map<string, { path: string | null; exists: boolean; contents: string; error?: string }>> {
	const result = new Map<string, { path: string | null; exists: boolean; contents: string; error?: string }>()
	const safe = containerNames.filter((n) => SAFE_NAME.test(n))
	if (safe.length === 0) return result

	// Build a single bash script:
	//   for each container, try /opt/apps/<name>.env, then fallback to compose-
	//   declared env_file via `docker inspect`. Output is delimited so we can
	//   parse it back deterministically.
	// Layout per container:
	//   __NAME__\n<containerName>\n
	//   __PATH__\n<resolvedPath or empty>\n
	//   __EXISTS__\n[01]\n
	//   __DATA__\n<base64 contents (may be empty)>\n
	//   __END__\n
	const script =
		ENV_READ_GUARD_FN +
		safe
		.map((n) => {
			const q = shq(n)
			return `
NAME=${q}
PRIMARY=/opt/apps/$NAME.env
PATH_RES=""
EXISTS=0
DATA=""
ERR=""
if [ -f "$PRIMARY" ]; then
  PATH_RES="$PRIMARY"; if envread_ok "$PRIMARY"; then EXISTS=1; DATA=$(base64 < "$PRIMARY"); else ERR=link; fi
else
  ENV_FROM_INSPECT=$(docker inspect ${q} --format '{{range .HostConfig.Mounts}}{{end}}{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)
  WD=$(echo "$ENV_FROM_INSPECT" | awk -F'|' '{print $3}')
  if [ -n "$WD" ] && [ -f "$WD/.env" ]; then
    PATH_RES="$WD/.env"; if envread_ok "$WD/.env"; then EXISTS=1; DATA=$(base64 < "$WD/.env"); else ERR=link; fi
  fi
fi
printf '__NAME__\n%s\n__PATH__\n%s\n__EXISTS__\n%s\n__ERR__\n%s\n__DATA__\n%s\n__END__\n' \
  "$NAME" "$PATH_RES" "$EXISTS" "$ERR" "$DATA"
`
		})
		.join('')

	const { stdout } = await runCommand(server, script, 20_000)

	// Parse the marker-delimited stream back into per-container records.
	const records = stdout.split('__END__\n')
	for (const rec of records) {
		const m = rec.match(
			/__NAME__\n([\s\S]*?)\n__PATH__\n([\s\S]*?)\n__EXISTS__\n([01])\n(?:__ERR__\n([a-z]*)\n)?__DATA__\n([\s\S]*)$/,
		)
		if (!m) continue
		const [, name, pathRes, existsFlag, errFlag, dataB64] = m
		const exists = existsFlag === '1'
		const contents = exists && dataB64 ? Buffer.from(dataB64.trim(), 'base64').toString('utf8') : ''
		result.set((name ?? '').trim(), {
			path: pathRes?.trim() ? pathRes.trim() : null,
			exists,
			contents,
			// the file is a symlink that resolves outside the app; not read.
			...(errFlag === 'link'
				? { error: 'the env file is a symlink that resolves outside this app; not read (remove the link on the server)' }
				: {}),
		})
	}
	return result
}

/** THE way powder copies an env file (backups, snapshots, the pre-render copy,
 *  restores). Only a regular file that is not a symlink is copied, and the copy itself
 *  never follows a link (`cp -P`): a container that can write next to the env file
 *  could swap it for a link to another app's env file, and a copy that followed it would
 *  later be restored INTO this app. The result is checked again (a regular file, not a
 *  link), so a swap between the check and the copy is caught. Fails (non-zero, a line on
 *  stderr, the destination removed) otherwise. `srcWord` / `dstWord` are shell words
 *  (quoted or "$VAR"). `replaceDst` (default): remove the destination first, for a
 *  destination in powder's own state dir; false for a temp file the caller just created
 *  with mktemp. */
export function envCopyShell(srcWord: string, dstWord: string, opts: { replaceDst?: boolean } = {}): string {
	const rm = opts.replaceDst === false ? '' : `rm -f -- ${dstWord} && `
	return (
		`{ { [ ! -L ${srcWord} ] && [ -f ${srcWord} ] && ${rm}cp -P -p -- ${srcWord} ${dstWord} && [ ! -L ${dstWord} ] && [ -f ${dstWord} ]; } || ` +
		`{ ${opts.replaceDst === false ? '' : `rm -f -- ${dstWord}; `}echo "[env] refusing to copy "${srcWord}": not a regular file (a symlink, or it changed during the copy); powder copies env files only when they are regular files" >&2; false; }; }`
	)
}

/** a path exists in any form (a dangling link included). */
const envPresent = (w: string) => `{ [ -e ${w} ] || [ -L ${w} ]; }`

export async function writeEnvFile(
	server: ServerConfig,
	path: string,
	contents: string,
	/** refuse (before mkdir and again right before the rename) when a component
	 *  of the path below this root is a symlink. Set for targets inside an app dir. */
	opts: { noSymlinkBelow?: string } = {},
): Promise<void> {
	const tmp = randomTempPath(path)
	// the FULL path (the env file itself included), not just its folder.
	const linkGuard = opts.noSymlinkBelow ? `${noSymlinkBelowShell(opts.noSymlinkBelow, path)} && ` : ''
	// Lock the rendered env (DB passwords + API keys) so it's NOT world-readable
	// (a plain write inherits root's umask, 0644).
	// BUT a server may run per-app crons as a `deploy` user that reads this file for
	// its secrets, so root-only 600 would break them. Correct posture: `root:deploy 640` where a deploy group
	// exists (the app-runner group reads its own secrets; still not world-readable),
	// else 600. Same for the .bak.
	//
	// The contents travel over SFTP into a 0600 temp file — NOT as base64 in
	// the exec'd command line, where every secret sat in `ps`/`/proc/*/cmdline`
	// on the server for the duration of the write.
	const mk = await runCommand(server, `${linkGuard}mkdir -p "$(dirname ${shq(path)})"`, 10_000)
	if (mk.code !== 0) throw new Error(mk.stderr || 'mkdir failed')
	await writeFileViaSftp(server, tmp, contents, 0o600, 30_000, true, true)
	const cmd =
		linkGuard +
		`if getent group deploy >/dev/null 2>&1; then OWN=root:deploy; MODE=640; else OWN=root:root; MODE=600; fi && ` +
		// the temp was written over SFTP in an earlier call; before its owner and
		// mode change, in this same command, it must still be a regular root-owned file with
		// one link (not a link or hard link something swapped in), and chown never follows.
		`{ [ -f ${shq(tmp)} ] && [ ! -L ${shq(tmp)} ] && [ "$(stat -c '%u %h' -- ${shq(tmp)} 2>/dev/null)" = '0 1' ]; } || { echo ${shq(`refusing: the env temp file ${tmp} is not the regular file powder wrote`)} >&2; exit 1; } && ` +
		`chown -h "$OWN" ${shq(tmp)} && [ ! -L ${shq(tmp)} ] && chmod "$MODE" ${shq(tmp)} && ` +
		// rm -f first so a planted .bak symlink is replaced, never written through; chown -h never follows.
		// The .bak lives in the powder env state dir, not next to the file (a repo can
		// not plant a link there); written via atomicWriteShell.
		`${envStateSetupShell(path)} && ` +
		// the .bak only from a regular file, never through a link (envCopyShell).
		`if ${envPresent(shq(path))}; then ${envCopyShell(shq(path), '"$ES/.bak.tmp"')} && chown -h "$OWN" "$ES/.bak.tmp" && chmod "$MODE" "$ES/.bak.tmp" && ${atomicWriteShellRaw('"$ES/bak"', '"$ES/.bak.tmp"')}; fi && ` +
		// the link check once more, right before the rm / mv of the rename.
		linkGuard +
		atomicWriteShell(path, tmp)
	const { code, stderr } = await runCommand(server, cmd, 15_000)
	if (code !== 0) {
		await runCommand(server, `rm -f ${shq(tmp)}`, 5_000).catch(() => {})
		throw new Error(stderr || 'write failed')
	}
}

// Upload `contents` to `remotePath` using the SFTP subsystem.
//
// Why this exists separately from writeEnvFile/writeFileSecret: those embed
// the file contents in a single SSH exec command (`printf '<base64>' | base64
// -d > file`). That goes through the SSH_MSG_CHANNEL_REQUEST exec channel,
// whose per-message payload is bounded by the server's max_packet_size
// (commonly 32 KB). Files larger than that fail mid-transmit with EPIPE /
// ECONNRESET (e.g. the multipart-backup script with 500 presigned URLs is
// ~440 KB).
//
// SFTP runs on its own subsystem channel with proper windowing + chunking, so
// arbitrary-size files transfer reliably. Use this any time the content
// might exceed ~30 KB.
export async function writeFileViaSftp(
	server: ServerConfig,
	remotePath: string,
	contents: string,
	mode = 0o600,
	timeoutMs = 30_000,
	quiet = false,
	/** open with O_CREAT|O_EXCL ('wx'): fails when anything (a file, a planted
	 *  symlink) already sits at the path, instead of writing through it. For temp files. */
	exclusive = false,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const tag = `[sftp ${server.host} ${remotePath.slice(-40)}]`
		const t0 = Date.now()
		// Step tracing is for debugging large uploads; failures always log.
		const log = (...args: unknown[]) => {
			const failure = typeof args[0] === 'string' && /ERR|TIMEOUT/.test(args[0])
			if (!quiet || failure) console.error(tag, `+${Date.now() - t0}ms`, ...args)
		}
		log('start; size=' + contents.length)
		const conn = withConnection(server, {
			onReady: (conn) => {
				log('conn ready, opening sftp')
				conn.sftp((err, sftp) => {
					if (err) {
						log('SFTP_INIT_ERR', err.message)
						clearTimeout(timer)
						conn.end()
						return reject(err)
					}
					log('sftp ready, creating write stream')
					const stream = sftp.createWriteStream(remotePath, { mode, flags: exclusive ? 'wx' : 'w' })
					stream.on('close', () => {
						log('stream close → OK')
						clearTimeout(timer)
						conn.end()
						resolve()
					})
					stream.on('error', (e: Error & { code?: string }) => {
						log(
							'STREAM_ERR',
							e.message,
							'code=' + e.code,
							e.stack?.split('\n').slice(0, 5).join(' | '),
						)
						clearTimeout(timer)
						conn.end()
						reject(e)
					})
					log('stream.end called')
					stream.end(contents)
				})
			},
			onError: (err: Error & { code?: string }) => {
				log('CONN_ERR', err.message, 'code=' + err.code)
				clearTimeout(timer)
				reject(explainSshError(server.host, err, server.port ?? 22))
			},
		})
		// After withConnection: a synchronous connect failure rejects cleanly.
		const timer = setTimeout(() => {
			log('TIMEOUT after', timeoutMs, 'ms')
			conn.end()
			reject(new Error(`SFTP timeout to ${server.host}`))
		}, timeoutMs)
	})
}

// Writes a private SSH key to the remote server, 0600 from the first byte. No
// backup. Used to plant deploy keys for git operations. Contents go over SFTP
// (created 0600), never through the exec'd command line (`ps`-visible).
export async function writeFileSecret(
	server: ServerConfig,
	path: string,
	contents: string,
): Promise<void> {
	const tmp = randomTempPath(path)
	const mk = await runCommand(server, `mkdir -p "$(dirname ${shq(path)})"`, 10_000)
	if (mk.code !== 0) throw new Error(mk.stderr || 'mkdir failed')
	await writeFileViaSftp(server, tmp, contents, 0o600, 30_000, true, true)
	const { code, stderr } = await runCommand(server, `chmod 600 ${shq(tmp)} && mv ${shq(tmp)} ${shq(path)}`, 10_000)
	if (code !== 0) {
		await runCommand(server, `rm -f ${shq(tmp)}`, 5_000).catch(() => {})
		throw new Error(stderr || 'write failed')
	}
}

export async function deleteRemoteFile(server: ServerConfig, path: string): Promise<void> {
	await runCommand(server, `rm -f ${shq(path)}`, 5_000)
}

const ENV_SNAPSHOT_KEEP = 5

// Env snapshots, the pre-render copy, the .bak and the restore marker
// live OUTSIDE any repo checkout, in a powder-owned 0700 dir per env file:
//   ${POWDER_ENV_STATE:-/var/lib/powder/env}/<hash>-<basename>/
//     deploy-<id>   snapshot of the env a deploy ran with
//     pre-<id>      copy taken right before the render
//     bak           the env file before the last write
//     powder-restored   sha256 marker for the drift guard
// A repo cannot plant names there, and every write goes through
// atomicWriteShell so a leftover link is replaced, never followed. The in-place
// names next to the env file (`<env>.deploy-<id>`, `<env>.pre-<id>`,
// `<env>.powder-restored`) are only READ (regular files only, never links), so a
// restore recorded under those names is honoured; nothing writes to them.
export function envStateDirName(envPath: string): string {
	return stateKeyFor(envPath)
}

/** Shell that sets $ES to the state dir for `envPath` (created 0700). */
function envStateSetupShell(envPath: string): string {
	return `ES="\${POWDER_ENV_STATE:-/var/lib/powder/env}"/${shq(envStateDirName(envPath))}; (umask 077; mkdir -p "$ES") && [ ! -L "$ES" ]`
}

const safeId = (deployId: string) => deployId.replace(/^dep_/, '').replace(/[^A-Za-z0-9_-]/g, '')

/** In-place snapshot name next to the env file (read-only fallback). */
export function envSnapshotPath(envPath: string, deployId: string): string {
	return `${envPath}.deploy-${safeId(deployId)}`
}

export async function snapshotEnvForDeploy(
	server: ServerConfig,
	envPath: string,
	deployId: string,
): Promise<void> {
	const id = safeId(deployId)
	const cmd =
		`${envStateSetupShell(envPath)} && ` +
		`if ${envPresent(shq(envPath))}; then { ${envCopyShell(shq(envPath), '"$ES/.snap.tmp"')} && ${atomicWriteShellRaw('"$ES/deploy-' + id + '"', '"$ES/.snap.tmp"')}; } || exit 1; fi; ` +
		`find "$ES" -maxdepth 1 -type f -name 'deploy-*' -print0 | xargs -0r ls -1td -- | tail -n +${ENV_SNAPSHOT_KEEP + 1} | tr '\\n' '\\0' | xargs -0r rm -f --`
	await runCommand(server, cmd, 15_000)
}

// ── pre-render copy (restore the env when a deploy dies BEFORE the swap) ─────
//
// The env file is rendered DB -> disk before the build. A build / test gate /
// migrate failure leaves the OLD container serving, but the file on disk is
// already the NEW env: the next plain recreate (restart, domain apply, a crash
// restart policy) would boot old code on new env. Copy the file aside right
// before the render writes it, restore it on a pre-swap failure.
function envPreRenderPath(envPath: string, deployId: string): string {
	return `${envPath}.pre-${safeId(deployId)}`
}

/** Shell that replaces envPath with the file named by shell word `fromWord`
 *  (temp next to envPath, then atomicWriteShell), refusing when envPath is a link. */
function restoreIntoEnvShell(envPath: string, fromWord: string): string {
	return (
		`{ if [ -L ${shq(envPath)} ]; then echo "[env] refusing to restore: ${envPath} is a symlink"; exit 1; fi; ` +
		`RT=$(mktemp "$(dirname ${shq(envPath)})/.env-restore.XXXXXX") && ${envCopyShell(fromWord, '"$RT"', { replaceDst: false })} && ${atomicWriteShellRaw(shq(envPath), '"$RT"')} || { rm -f "$RT"; exit 1; }; ` +
		`sha256sum ${shq(envPath)} | cut -d' ' -f1 > "$ES/.marker.tmp" && ${atomicWriteShellRaw('"$ES/powder-restored"', '"$ES/.marker.tmp"')}; }`
	)
}

export async function backupEnvBeforeRender(server: ServerConfig, envPath: string, deployId: string): Promise<void> {
	const id = safeId(deployId)
	const { code, stderr } = await runCommand(
		server,
		`${envStateSetupShell(envPath)} && rm -f "$ES/pre-${id}"; if ${envPresent(shq(envPath))}; then ${envCopyShell(shq(envPath), `"$ES/pre-${id}"`)}; fi`,
		15_000,
	)
	if (code !== 0) throw new Error(`env pre-render copy failed: ${stderr.trim().slice(0, 200)}`)
}

/** shell that lists powder's own env snapshots for `envPath`: `deploy-<id>`
 *  regular files in the env state dir (written after each successful rendering
 *  deploy, newest 5 kept), and in-place `<envPath>.deploy-<id>` regular
 *  files (never links) as `inplace-<id> <mtime epoch>`. Never creates anything. */
export function envSnapshotListShell(envPath: string): string {
	const dir = posix.dirname(envPath)
	const base = posix.basename(envPath)
	return [
		`ES="\${POWDER_ENV_STATE:-/var/lib/powder/env}"/${shq(envStateDirName(envPath))};`,
		'if [ -d "$ES" ] && [ ! -L "$ES" ]; then for f in "$ES"/deploy-*; do if [ -f "$f" ] && [ ! -L "$f" ]; then echo "deploy-${f##*/deploy-}"; fi; done; fi;',
		// in-place snapshots sit next to the env file (a repo checkout can hold one):
		// printed with their mtime, accepted only when older than the cutoff
		`for f in ${shq(dir)}/${shq(base)}.deploy-*; do if [ -f "$f" ] && [ ! -L "$f" ]; then echo "inplace-\${f##*.deploy-} $(date -r "$f" +%s)"; fi; done; true`,
	].join(' ')
}

export async function listEnvSnapshots(server: ServerConfig, envPath: string): Promise<string> {
	const r = await runCommand(server, envSnapshotListShell(envPath), 15_000)
	if (r.code !== 0) throw new Error(`could not list env snapshots on ${server.host}: ${r.stderr.trim().slice(0, 200)}`)
	return r.stdout
}

/** Remember the sha256 of the env file this deploy just rendered. A later restore
 *  (after a reap, in in-web mode) only puts the pre-render copy back while the file still
 *  has this hash; if a newer deploy rendered since, its env must not be overwritten. */
export async function recordEnvRender(server: ServerConfig, envPath: string, deployId: string): Promise<void> {
	const id = safeId(deployId)
	await runCommand(
		server,
		`${envStateSetupShell(envPath)} && sha256sum ${shq(envPath)} | cut -d' ' -f1 > "$ES/.render.tmp" && ${atomicWriteShellRaw(`"$ES/render-${id}"`, '"$ES/.render.tmp"')}`,
		15_000,
	)
}

/** Put the pre-render env back. Writes the restore marker (sha256) so the next
 *  deploy's drift guard treats the file as powder's own, like a rollback restore. */
export async function restoreEnvBeforeRender(
	server: ServerConfig,
	envPath: string,
	deployId: string,
): Promise<{ restored: boolean; output: string }> {
	const id = safeId(deployId)
	const old = envPreRenderPath(envPath, deployId)
	const cmd =
		`${envStateSetupShell(envPath)} || exit 1; ` +
		`PRE="$ES/pre-${id}"; if [ ! -f "$PRE" ] && [ -f ${shq(old)} ] && [ ! -L ${shq(old)} ]; then PRE=${shq(old)}; fi; ` +
		`if [ ! -f "$PRE" ]; then echo "[env] no pre-render copy - keeping the current env file"; exit 0; fi; ` +
		`RS="$ES/render-${id}"; if [ -f "$RS" ] && [ "$(sha256sum ${shq(envPath)} 2>/dev/null | cut -d' ' -f1)" != "$(cat "$RS")" ]; then ` +
		`rm -f "$ES/pre-${id}" "$RS"; echo "[env] the env file changed since this deploy rendered it (a newer deploy or an edit) - not restoring"; exit 0; fi; ` +
		`${restoreIntoEnvShell(envPath, '"$PRE"')} && rm -f "$ES/pre-${id}" "$RS" ${shq(old)} && ` +
		`echo "[env] deploy failed before the swap: env file restored to what the running version uses" && echo "__ENV_RESTORED__"`
	const { stdout, code, stderr } = await runCommand(server, cmd, 15_000)
	if (code !== 0) throw new Error(stderr || stdout || 'env restore failed')
	return { restored: stdout.includes('__ENV_RESTORED__'), output: stdout.replace('__ENV_RESTORED__\n', '') }
}

export async function dropEnvPreRender(server: ServerConfig, envPath: string, deployId: string): Promise<void> {
	await runCommand(
		server,
		`${envStateSetupShell(envPath)} && rm -f "$ES/pre-${safeId(deployId)}" "$ES/render-${safeId(deployId)}" ${shq(envPreRenderPath(envPath, deployId))}`,
		10_000,
	)
}

export async function restoreEnvSnapshot(
	server: ServerConfig,
	envPath: string,
	deployId: string,
): Promise<{ restored: boolean; output: string }> {
	const id = safeId(deployId)
	const old = envSnapshotPath(envPath, deployId)
	const cmd =
		`${envStateSetupShell(envPath)} || exit 1; ` +
		`SNAP="$ES/deploy-${id}"; if [ ! -f "$SNAP" ] && [ -f ${shq(old)} ] && [ ! -L ${shq(old)} ]; then SNAP=${shq(old)}; fi; ` +
		`if [ ! -f "$SNAP" ]; then echo "[env] no env snapshot for that deploy - keeping the current env file"; exit 0; fi; ` +
		`if cmp -s "$SNAP" ${shq(envPath)}; then echo "[env] env unchanged since that deploy"; exit 0; fi; ` +
		`if ${envPresent(shq(envPath))}; then ${envCopyShell(shq(envPath), '"$ES/.bak.tmp"')} && ${atomicWriteShellRaw('"$ES/bak"', '"$ES/.bak.tmp"')} || true; fi; ` +
		`${restoreIntoEnvShell(envPath, '"$SNAP"')} && ` +
		`echo "[env] restored the env file this image last ran with (${id}); previous kept in the powder env state dir (bak)" && echo "__ENV_RESTORED__"`
	const { stdout, code, stderr } = await runCommand(server, cmd, 15_000)
	if (code !== 0) throw new Error(stderr || stdout || 'env restore failed')
	return { restored: stdout.includes('__ENV_RESTORED__'), output: stdout.replace('__ENV_RESTORED__\n', '') }
}

/** sha256 recorded by the last restoreEnvSnapshot for this env file, or null (no
 *  marker). Reads the state dir, else the in-place marker (regular file only).
 *  'unreadable' (fail closed) when the read itself failed (non-zero exit: the
 *  state dir could not be set up or read), never null: callers treat 'unreadable' as a
 *  restored file for the token rule and as no powder restore for the render guard. */
export async function readEnvRestoreMarker(server: ServerConfig, envPath: string): Promise<string | 'unreadable' | null> {
	const old = `${envPath}.powder-restored`
	const { stdout, code } = await runCommand(
		server,
		`${envStateSetupShell(envPath)} || exit 1; ` +
			`if [ -f "$ES/powder-restored" ]; then cat "$ES/powder-restored"; elif [ -f ${shq(old)} ] && [ ! -L ${shq(old)} ]; then cat ${shq(old)}; fi 2>/dev/null`,
		10_000,
	)
	if (code !== 0) return 'unreadable'
	const v = stdout.trim()
	if (v === '') return null
	return /^[0-9a-f]{64}$/.test(v) ? v : 'unreadable'
}

export async function clearEnvRestoreMarker(server: ServerConfig, envPath: string): Promise<void> {
	await runCommand(
		server,
		`${envStateSetupShell(envPath)} && rm -f "$ES/powder-restored" ${shq(`${envPath}.powder-restored`)}`,
		10_000,
	)
}
