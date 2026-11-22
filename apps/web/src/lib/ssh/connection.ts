import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'ssh2'
import type { ServerConfig } from '../servers'
import { CappedOutput } from '../capped-output'
import { explainSshError, hostVerifierFor } from '../ssh-host-keys'
import { sshCommand } from '../docker-env'

const DEFAULT_KEY_PATH = process.env.SSH_KEY_PATH ?? join(homedir(), '.ssh', 'id_ed25519')

let cachedKey: Buffer | null = null

function loadKey(): Buffer {
	if (!cachedKey) cachedKey = readFileSync(DEFAULT_KEY_PATH)
	return cachedKey
}

// ssh2 connect config for a managed server. Every connection pins the server's host
// key (lib/ssh-host-keys.ts) — without a hostVerifier ssh2 accepts ANY key.
export function sshConnectConfig(
	target: { host: string; port?: number | null; user: string },
	extra: { readyTimeout?: number; keepaliveInterval?: number } = {},
) {
	return {
		host: target.host,
		port: target.port ?? 22,
		username: target.user,
		privateKey: loadKey(),
		readyTimeout: extra.readyTimeout ?? 6000,
		...(extra.keepaliveInterval ? { keepaliveInterval: extra.keepaliveInterval } : {}),
		hostVerifier: hostVerifierFor(target.host, target.port ?? 22),
	}
}

/** Open an ssh2 connection to a managed server with the pinned-host-key config and
 *  wire the two events every caller needs. The caller owns timers, cleanup
 *  (conn.end()) and error mapping. */
export function withConnection(
	server: ServerConfig,
	handlers: { onReady: (conn: Client) => void; onError: (err: Error) => void },
	extra?: { readyTimeout?: number; keepaliveInterval?: number },
): Client {
	const conn = new Client()
	conn.on('ready', () => handlers.onReady(conn)).on('error', handlers.onError).connect(sshConnectConfig(server, extra))
	return conn
}

export async function runCommand(
	server: ServerConfig,
	command: string,
	timeoutMs = 10_000,
	/** Gets every chunk as it arrives, with the stream it came from. */
	onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void,
	/** stdin: written to the command, then closed (only when given; otherwise stdin is
	 *  left as before). For values a script must not carry in its command line. */
	opts?: { stdin?: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
	return new Promise((resolve, reject) => {
		const conn = withConnection(server, {
			onReady: (conn) => {
				// every remote command runs without root's registry logins (docker-env.ts).
				conn.exec(sshCommand(command), (err, stream) => {
					if (err) {
						clearTimeout(timer)
						conn.end()
						return reject(err)
					}
					// capped (head + tail) so a runaway command cannot OOM the worker.
					const out = new CappedOutput()
					const err2 = new CappedOutput()
					// Decode with a stateful decoder: chunk.toString('utf8') per chunk turns
					// a multibyte char (the banner "──") split across two chunks into U+FFFD,
					// so the banner regexes would miss it and git_sha would not be recorded.
					stream.setEncoding?.('utf8')
					stream.stderr?.setEncoding?.('utf8')
					stream
						.on('close', (code: number | null, signal?: string) => {
							clearTimeout(timer)
							conn.end()
							// A channel can close WITHOUT delivering an exit code
							// (connection torn down, remote killed by signal). That is
							// unknown, not success: reading it as exit 0 would let a
							// step that never finished pass as done upstream. Report
							// 255 like ssh(1) does.
							if (code == null) {
								err2.push(`\n[powder] ssh channel closed without exit code${signal ? ` (signal ${signal})` : ''} - treated as failure\n`)
								resolve({ stdout: out.toString(), stderr: err2.toString(), code: 255 })
								return
							}
							resolve({ stdout: out.toString(), stderr: err2.toString(), code })
						})
						.on('data', (chunk: Buffer | string) => {
							const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
							out.push(s)
							onChunk?.(s, 'stdout')
						})
					stream.stderr.on('data', (chunk: Buffer | string) => {
						const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
						err2.push(s)
						onChunk?.(s, 'stderr')
					})
					if (opts?.stdin !== undefined) stream.end(opts.stdin)
				})
			},
			onError: (err) => {
				clearTimeout(timer)
				reject(explainSshError(server.host, err, server.port ?? 22))
			},
		})
		// Created after withConnection so a synchronous connect failure (bad key
		// path) rejects the promise instead of leaving a timer on an unset conn.
		const timer = setTimeout(() => {
			conn.end()
			reject(new Error(`SSH timeout to ${server.host}`))
		}, timeoutMs)
	})
}
