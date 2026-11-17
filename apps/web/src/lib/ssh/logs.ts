import type { ServerConfig } from '../servers'
import { composeFileArgs, onServerComposeGuardShell } from '../deploy/fragments'
import { redactSecrets } from '../secret-text'
import { assertSafeName, shq } from '../shell'
import { runCommand, withConnection } from './connection'
import { sshCommand } from '../docker-env'
import { inspectContainer } from './discovery'

export async function getContainerLogs(
	server: ServerConfig,
	name: string,
	tail = 200,
): Promise<string> {
	assertSafeName(name)
	const lines = Math.max(1, Math.min(5000, Math.floor(tail)))
	const { stdout, stderr } = await runCommand(
		server,
		`docker logs --tail=${lines} --timestamps -- ${name} 2>&1`,
		15_000,
	)
	return stdout || stderr
}

// Streams `docker logs --follow` chunks over a long-lived SSH exec.
// Caller invokes the returned cancel() when done (browser disconnect, etc).
export async function streamContainerLogs(
	server: ServerConfig,
	name: string,
	opts: {
		tail?: number
		onData: (chunk: string) => void
		onError?: (err: Error) => void
		onClose?: () => void
	},
): Promise<{ cancel: () => void }> {
	assertSafeName(name)
	const lines = Math.max(1, Math.min(5000, Math.floor(opts.tail ?? 200)))
	return new Promise((resolve, reject) => {
		let cancelled = false
		const cancel = () => {
			cancelled = true
			try {
				conn.end()
			} catch {
				// ignore
			}
		}
		const conn = withConnection(
			server,
			{
				onReady: (conn) => {
					conn.exec(sshCommand(`docker logs --follow --tail=${lines} --timestamps -- ${name} 2>&1`), (err, stream) => {
						if (err) {
							conn.end()
							reject(err)
							return
						}
						stream.on('close', () => {
							try {
								conn.end()
							} catch {
								// ignore
							}
							if (!cancelled) opts.onClose?.()
						})
						stream.on('data', (chunk: Buffer) => {
							if (!cancelled) opts.onData(chunk.toString('utf8'))
						})
						stream.stderr.on('data', (chunk: Buffer) => {
							if (!cancelled) opts.onData(chunk.toString('utf8'))
						})
						resolve({ cancel })
					})
				},
				onError: (err) => {
					if (cancelled) return
					opts.onError?.(err)
					reject(err)
				},
			},
			{ keepaliveInterval: 30_000 },
		)
	})
}

/** the restart command. `docker restart` re-resolves every mount source and
 *  starts a stopped container with the mounts it was created with, so:
 *  - a container that is not running is refused (a restart would bring back an exited,
 *    possibly stale container outside every guard; redeploy or apply it instead);
 *  - a container of a managed compose project (`guard`: its compose files, working dir
 *    and owning app) first runs the on-server compose guards a recreate runs
 *    (onServerComposeGuardShell: env file, profile and bind / volume link guards).
 *  Pure. */
export function restartCommand(
	name: string,
	guard: { cf: string; app: string; workingDir: string } | null,
): string {
	assertSafeName(name)
	// fail closed. Every step is joined with &&, so a failing running check,
	// cd or guard exits non-zero before `docker restart` runs.
	const running =
		`{ [ "$(docker inspect --format '{{.State.Running}}' -- ${name} 2>/dev/null)" = true ] || ` +
		`{ echo "restart refused: ${name} is not running. A restart starts a stopped container with the mounts it was created with, outside powder's checks. Redeploy the app (or apply the container) to start it."; exit 1; }; }`
	const pre = guard
		? `{ cd ${shq(guard.workingDir)} || { echo "restart refused: cannot enter the compose working dir "${shq(guard.workingDir)}", so the compose guards cannot run"; exit 1; }; } && ` +
			`{ ${onServerComposeGuardShell(guard.cf, guard.app, guard.workingDir)}; } && `
		: ''
	return `bash -o pipefail -c ${shq(`${running} && ${pre}docker restart -- ${name}`)}`
}

export async function restartContainer(server: ServerConfig, name: string): Promise<void> {
	assertSafeName(name)
	const detail = await inspectContainer(server, name)
	let guard: { cf: string; app: string; workingDir: string } | null = null
	const c = detail.compose
	if (c.project && c.workingDir && c.configFile) {
		const { owningAppFor } = await import('../recreate-guard')
		const app = await owningAppFor(server.id, name, c.project)
		if (app) guard = { cf: composeFileArgs(c.configFile, c.configFiles), app, workingDir: c.workingDir }
	}
	const { code, stdout, stderr } = await runCommand(server, restartCommand(name, guard), 60_000)
	// the guard output can quote config values; mask secret shapes before it
	// reaches an API body or the deploys row.
	if (code !== 0) throw new Error(redactSecrets((stdout.trim() || stderr || `docker restart failed for ${name}`).slice(0, 4000)))
}
