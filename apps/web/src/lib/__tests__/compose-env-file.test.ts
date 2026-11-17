import { describe, expect, it } from 'vitest'
import { composeEnvFilePaths } from '../ssh'

describe('composeEnvFilePaths', () => {
	it('reads a single path', () => {
		expect(composeEnvFilePaths(`services:\n  app:\n    env_file: /opt/apps/a.env\n`)).toEqual(['/opt/apps/a.env'])
		expect(composeEnvFilePaths(`services:\n  app:\n    env_file: "/opt/apps/a.env" # main\n`)).toEqual([
			'/opt/apps/a.env',
		])
	})

	it('reads an inline flow list (myapp shape)', () => {
		expect(
			composeEnvFilePaths(`services:\n  myapp:\n    env_file: [/opt/apps/myapp.env, /opt/apps/myapp.db.env]\n`),
		).toEqual(['/opt/apps/myapp.env', '/opt/apps/myapp.db.env'])
		expect(composeEnvFilePaths(`    env_file: ["/opt/apps/a.env", '/opt/apps/b.env']`)).toEqual([
			'/opt/apps/a.env',
			'/opt/apps/b.env',
		])
	})

	it('reads a block list, stopping at the next key', () => {
		const compose = [
			'services:',
			'  app:',
			'    env_file:',
			'      - /opt/apps/example.env',
			'',
			'      - /opt/apps/example.db.env',
			'    volumes:',
			'      - ./data:/data',
			'      - /opt/apps/other.env',
		].join('\n')
		expect(composeEnvFilePaths(compose)).toEqual(['/opt/apps/example.env', '/opt/apps/example.db.env'])
	})

	it('reads the long form with path:/required:', () => {
		const compose = [
			'    env_file:',
			'      - path: /opt/apps/a.env',
			'        required: true',
			'      - path: /opt/apps/b.env',
			'        required: false',
			'    restart: always',
		].join('\n')
		expect(composeEnvFilePaths(compose)).toEqual(['/opt/apps/a.env', '/opt/apps/b.env'])
	})

	it('keeps file order across services', () => {
		const compose = [
			'services:',
			'  app:',
			'    env_file: [/opt/apps/app.env]',
			'  db:',
			'    env_file:',
			'      - /opt/apps/app.db.env',
		].join('\n')
		expect(composeEnvFilePaths(compose)).toEqual(['/opt/apps/app.env', '/opt/apps/app.db.env'])
	})

	it('returns nothing without env_file', () => {
		expect(composeEnvFilePaths(`services:\n  app:\n    image: x\n`)).toEqual([])
	})
})

describe('composeEnvFilePaths resolution relative to the compose dir', () => {
	const rel = `services:\n  app:\n    env_file: .env\n`
	it('resolves a relative env_file against dirname(configFile), not /root', () => {
		expect(composeEnvFilePaths(rel, '/opt/apps/foo/docker-compose.yml')).toEqual(['/opt/apps/foo/.env'])
		expect(composeEnvFilePaths(`    env_file: ./env/app.env\n`, '/opt/apps/foo/docker-compose.yml')).toEqual(['/opt/apps/foo/env/app.env'])
	})
	it('two apps with `env_file: .env` do not share one path', () => {
		const a = composeEnvFilePaths(rel, '/opt/apps/a/docker-compose.yml')
		const b = composeEnvFilePaths(rel, '/opt/apps/b/docker-compose.yml')
		expect(a).not.toEqual(b)
	})
	it('keeps absolute paths outside /opt/apps (a shared env dir) and relative .env next to the compose', () => {
		expect(composeEnvFilePaths(`    env_file: /opt/docker/stack/env/web.env\n`, '/opt/docker/stack/docker-compose.yml')).toEqual(['/opt/docker/stack/env/web.env'])
		expect(composeEnvFilePaths(rel, '/opt/docker/stack/docker-compose.yml')).toEqual(['/opt/docker/stack/.env'])
	})
	it('refuses relative paths with no base and system locations (deny-list)', () => {
		for (const p of ['/root/x.env', '/etc/x', '/var/lib/powder/env/x', '/proc/1/environ', '/sys/x', '/dev/x', '/boot/x', '/usr/x', '/bin/x', '/sbin/x', '/lib/x', '/lib64/x', '/etc/../etc/x']) {
			expect(composeEnvFilePaths(`    env_file: ${p}\n`, '/opt/apps/a/c.yml')).toEqual([])
		}
		expect(composeEnvFilePaths(rel)).toEqual([])
		expect(composeEnvFilePaths(`    env_file: ../../../etc/passwd\n`, '/opt/apps/a/c.yml')).toEqual([])
		expect(composeEnvFilePaths(`    env_file: /opt/apps/../../root/.env\n`, '/opt/apps/a/c.yml')).toEqual([])
		expect(composeEnvFilePaths(`    env_file: /root/app.env\n`, '/opt/apps/a/c.yml')).toEqual([])
	})
})
