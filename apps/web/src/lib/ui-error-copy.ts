import { DEPLOY_SETTLE_MAX_SECONDS } from './deploy-settle'

// The API names its fields (deploySettleSeconds, containerPort…) for API clients.
// Forms show the message next to the control it is about, so they say it in UI
// words. Unknown messages pass through unchanged.

export const SETTLE_COPY = `enter a whole number from 0 to ${DEPLOY_SETTLE_MAX_SECONDS}, or leave it empty`
export const PORT_COPY = 'enter a port from 1 to 65535'
export const DOCKERFILE_COPY =
	'enter a relative path of letters, digits and . _ / - (at most 200 characters, no "..")'

export function uiErrorCopy(apiError: string): string {
	if (/\bdeploySettleSeconds\b/.test(apiError)) return SETTLE_COPY
	if (/\bcontainerPort\b/.test(apiError)) return PORT_COPY
	if (/\bdockerfilePath\b/.test(apiError)) return DOCKERFILE_COPY
	return apiError
		.replace(/\bhealthUrl\b/g, 'health URL')
		.replace(/\bbackupDbContainer\b/g, 'container')
		.replace(/\bbackupDbHost\b/g, 'host')
		.replace(/\bbackupDbName\b/g, 'database')
		.replace(/\bbackupDbUser\b/g, 'user')
		.replace(/\bbackupDbPassword\b/g, 'password')
}
