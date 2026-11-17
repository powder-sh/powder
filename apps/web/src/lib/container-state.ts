import { redactSecrets, safeSlice } from './secret-text'

// What the app pages know about an app's container, in one shape. The four
// answers mean different things to the user and must not be collapsed:
//   running/stopped container  -> { reachable: true, exists: true, ... }
//   server answered, no container -> { reachable: true, exists: false }
//   SSH worked, docker failed (daemon down, no docker) -> { reachable: true, exists: false, dockerError }
//   SSH failed (timeout, refused, auth) -> { reachable: false, exists: false, error }
// "no container" is only claimed when docker actually answered. Error texts
// come from the server, so they are redacted and cut before they leave here.

export type ContainerState =
	| { reachable: true; exists: true; status: string; startedAt?: string; image?: string }
	| { reachable: true; exists: false }
	| { reachable: true; exists: false; dockerError: string }
	| { reachable: false; exists: false; error: string }

/** Thrown by inspectContainer when the remote command ran and failed (SSH itself worked). */
export class DockerCommandError extends Error {}

const ERROR_MAX = 300

function serverText(err: unknown, fallback: string): string {
	const raw = err instanceof Error ? err.message : ''
	return raw ? safeSlice(redactSecrets(raw), 0, ERROR_MAX) : fallback
}

export interface InspectResult {
	status: string
	startedAt?: string
	image?: string
}

export async function readContainerState(
	inspect: () => Promise<InspectResult>,
	missing: (err: unknown) => boolean,
	dockerFailed: (err: unknown) => boolean = (err) => err instanceof DockerCommandError,
): Promise<ContainerState> {
	try {
		const d = await inspect()
		return {
			reachable: true,
			exists: true,
			status: d.status,
			startedAt: d.startedAt,
			image: d.image,
		}
	} catch (err) {
		if (missing(err)) return { reachable: true, exists: false }
		if (dockerFailed(err)) {
			return { reachable: true, exists: false, dockerError: serverText(err, 'docker failed') }
		}
		return { reachable: false, exists: false, error: serverText(err, 'ssh failed') }
	}
}

// Missing only when docker itself said so: its stderr "No such object: <name>" /
// "No such container: <name>", or inspectContainer's own "container not found"
// (docker answered with an empty list). Anything else that ran and failed (a
// non-zero exit with empty stderr reads "docker inspect failed for <name>") is a
// docker error, never "no container": the header would claim the app is down.
export function isNoSuchContainer(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err)
	return /\bno such (object|container)\b/i.test(msg) || /^container not found$/i.test(msg.trim())
}

// ssh2 tags connection failures with a client-* level; the message covers
// errors raised before ssh2 (DNS, sockets) and wrapped ones.
function isSshConnectError(err: unknown): boolean {
	const level = (err as { level?: unknown } | null)?.level
	if (typeof level === 'string' && level.startsWith('client-')) return true
	const msg = err instanceof Error ? err.message : String(err)
	return /handshake|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|authentication methods failed|host key|connect/i.test(
		msg,
	)
}

/** The HTTP answer for a container read that threw. Never 500: the failure is
 *  on the server, not in powder. 404 when docker said the container is not
 *  there, 503 when the server did not answer over SSH, 502 when SSH worked and
 *  the remote command failed. The text comes from the server, so it is
 *  redacted and cut. */
export function containerReadError(err: unknown): Response {
	const error = serverText(err, 'ssh failed')
	if (isNoSuchContainer(err)) return Response.json({ error, code: 'no_container' }, { status: 404 })
	if (!(err instanceof DockerCommandError) && isSshConnectError(err))
		return Response.json({ error, code: 'server_unreachable' }, { status: 503 })
	return Response.json({ error, code: 'remote_failed' }, { status: 502 })
}
