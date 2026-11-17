import { type ComposeGuardContext, checkComposeConfig, parseComposeYaml } from './compose-safety'

// User-supplied values (dockerfilePath, containerPort) are rendered
// into a compose file that powder runs as root. Validate the inputs, then parse
// the rendered YAML and refuse anything that escapes the app's sandbox.

export type AppInputs =
	| { ok: true; dockerfilePath: string; containerPort: number }
	| { ok: false; error: string }

const DOCKERFILE_RE = /^[A-Za-z0-9._/-]+$/

export function validateAppInputs(raw: {
	dockerfilePath?: unknown
	containerPort?: unknown
}): AppInputs {
	const dockerfilePath = raw.dockerfilePath ?? './Dockerfile'
	if (dockerfilePath === '') {
		return validateAppInputs({ ...raw, dockerfilePath: undefined })
	}
	if (
		typeof dockerfilePath !== 'string' ||
		dockerfilePath.length > 200 ||
		!DOCKERFILE_RE.test(dockerfilePath) ||
		dockerfilePath.startsWith('/') ||
		dockerfilePath.split('/').includes('..')
	) {
		return {
			ok: false,
			error:
				'invalid dockerfilePath: use a relative path of letters, digits, . _ / - (max 200, no "..")',
		}
	}
	const containerPort = raw.containerPort ?? 3000
	if (
		typeof containerPort !== 'number' ||
		!Number.isInteger(containerPort) ||
		containerPort < 1 ||
		containerPort > 65535
	) {
		return { ok: false, error: 'invalid containerPort: integer 1-65535 required' }
	}
	return { ok: true, dockerfilePath, containerPort }
}

// Returns null when safe, else a human-readable reason. The rule set is the ONE
// compose authority (compose-safety.ts); this entry point takes a raw YAML file
// (what powder renders before writing it), parsed with merge keys applied so a
// key hidden behind `<<: *anchor` is seen. Unresolved extends/include are refused.
export function checkComposeSafe(
	yamlText: string,
	appName: string,
	extra: Omit<ComposeGuardContext, 'appName' | 'resolved'> = {},
): string | null {
	let doc: unknown
	try {
		doc = parseComposeYaml(yamlText)
	} catch (err) {
		return `compose YAML does not parse: ${err instanceof Error ? err.message : err}`
	}
	return checkComposeConfig(doc, { ...extra, appName, resolved: false })
}
