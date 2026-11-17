import type { EnvScope } from './env-vars-db'

// one reading of the env `scope` input for the env routes. An absent scope is
// production; a scope that is present but not one of the three is an error (400), never
// silently production (a typo like `scope=preveiw` wrote or deleted production values).
const ENV_SCOPES: readonly EnvScope[] = ['production', 'preview', 'development']

/** `undefined` / `null` (absent): 'production'. A known scope: itself. Anything else: null. */
export function parseEnvScope(raw: unknown): EnvScope | null {
	if (raw === undefined || raw === null) return 'production'
	return typeof raw === 'string' && (ENV_SCOPES as readonly string[]).includes(raw) ? (raw as EnvScope) : null
}

export const UNKNOWN_SCOPE_ERROR = 'unknown scope (production, preview or development)'
