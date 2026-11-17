import { describe, expect, it, vi } from 'vitest'
import { envKeyWriteDenied, isLoaderEnvKey } from '../env-key-policy'

// bearer-token env writes may not set package-manager config, runtime option
// families, TLS trust or proxy keys. An admin browser session keeps every key.

describe('env loader keys for token writes', () => {
	it('refuses npm / yarn / bun / pip config keys (npm vector: a registry or script-shell override)', () => {
		for (const k of ['NPM_CONFIG_REGISTRY', 'npm_config_script_shell', 'YARN_NPM_REGISTRY_SERVER', 'BUN_CONFIG_REGISTRY', 'PIP_INDEX_URL']) {
			expect(isLoaderEnvKey(k), k).toBe(true)
			expect(envKeyWriteDenied(k, 'https://registry.invalid.example', false), k).not.toBeNull()
			expect(envKeyWriteDenied(k, 'https://registry.invalid.example', true), k).toBeNull()
		}
	})

	it('refuses runtime families and Java option keys', () => {
		for (const k of ['PYTHONWARNINGS', 'RUBYGEMS_HOST', 'PERL5DB', 'JAVA_HOME', 'JAVA_OPTS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CATALINA_OPTS'])
			expect(envKeyWriteDenied(k, 'x', false), k).not.toBeNull()
	})

	it('refuses TLS trust and proxy keys, any case (proxy vector)', () => {
		for (const k of [
			'NODE_TLS_REJECT_UNAUTHORIZED',
			'NODE_USE_ENV_PROXY',
			'NODE_EXTRA_CA_CERTS',
			'SSL_CERT_FILE',
			'SSL_CERT_DIR',
			'REQUESTS_CA_BUNDLE',
			'CURL_CA_BUNDLE',
			'PYTHONHTTPSVERIFY',
			'HTTP_PROXY',
			'https_proxy',
			'All_Proxy',
			'no_proxy',
		]) {
			expect(envKeyWriteDenied(k, 'http://proxy.invalid.example:3128', false), k).not.toBeNull()
			expect(envKeyWriteDenied(k, 'http://proxy.invalid.example:3128', true), k).toBeNull()
		}
	})

	it('refuses any key containing OPTIONS, _OPTS or PROXY for a token only', () => {
		for (const k of ['GRADLE_OPTS', 'MAVEN_OPTS', 'APP_OPTIONS', 'UPSTREAM_PROXY_URL', 'socks_proxy']) {
			expect(envKeyWriteDenied(k, 'x', false), k).not.toBeNull()
			expect(envKeyWriteDenied(k, 'x', true), k).toBeNull()
		}
	})

	it('NODE_ENV and other non-credential keys are refused for tokens; the safe NODE_OPTIONS only with the operator allow', () => {
		// DATABASE_URL and NEXT_PUBLIC_SITE_URL are destination keys now (env-token-rule)
		for (const k of ['NODE_ENV', 'OPTIMIZE_IMAGES', 'PORT']) {
			expect(envKeyWriteDenied(k, 'production', false), k).toMatch(/not a credential key/)
			expect(envKeyWriteDenied(k, 'production', true), k).toBeNull()
		}
		expect(envKeyWriteDenied('NODE_OPTIONS', '--max-old-space-size=4096', false)).not.toBeNull()
		vi.stubEnv('POWDER_TOKEN_ENV_ALLOW', 'NODE_ENV|NODE_OPTIONS')
		try {
			expect(envKeyWriteDenied('NODE_ENV', 'production', false)).toBeNull()
			expect(envKeyWriteDenied('NODE_OPTIONS', '--max-old-space-size=4096', false)).toBeNull()
			expect(envKeyWriteDenied('NODE_OPTIONS', '--require /tmp/x.js', false)).not.toBeNull()
		} finally {
			vi.unstubAllEnvs()
		}
	})
})
