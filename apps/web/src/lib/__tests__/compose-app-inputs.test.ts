import { describe, expect, it } from 'vitest'
import { checkComposeSafe, validateAppInputs } from '../compose-guard'
import { renderComposeYaml } from '../compose-render'

const base = {
	name: 'myapp',
	dockerfilePath: './Dockerfile',
	hostPort: null,
	containerPort: 3000,
	envFilePath: '/opt/apps/myapp.env',
	publicHost: 'myapp.apps.example.com',
	postgres: { password: 'pw', dataDir: '/opt/apps/myapp/pgdata' },
	kv: { dataDir: '/opt/apps/myapp/kvdata' },
}

describe('validateAppInputs', () => {
	it('rejects a hostile dockerfilePath payload', () => {
		const r = validateAppInputs({
			dockerfilePath: './Dockerfile\n    privileged: true\n    volumes:\n      - /:/host',
		})
		expect(r.ok).toBe(false)
	})
	it('rejects a hostile containerPort payload', () => {
		const r = validateAppInputs({ containerPort: '3000\n    privileged: true\n    pid: host' })
		expect(r.ok).toBe(false)
	})
	it('rejects traversal, absolute, long and out-of-range values', () => {
		expect(validateAppInputs({ dockerfilePath: '../Dockerfile' }).ok).toBe(false)
		expect(validateAppInputs({ dockerfilePath: 'a/../../b' }).ok).toBe(false)
		expect(validateAppInputs({ dockerfilePath: '/etc/Dockerfile' }).ok).toBe(false)
		expect(validateAppInputs({ dockerfilePath: 'a'.repeat(201) }).ok).toBe(false)
		expect(validateAppInputs({ containerPort: 0 }).ok).toBe(false)
		expect(validateAppInputs({ containerPort: 65536 }).ok).toBe(false)
		expect(validateAppInputs({ containerPort: 80.5 }).ok).toBe(false)
	})
	it('accepts defaults and sane values', () => {
		expect(validateAppInputs({})).toEqual({ ok: true, dockerfilePath: './Dockerfile', containerPort: 3000 })
		expect(validateAppInputs({ dockerfilePath: 'apps/web/Dockerfile.prod', containerPort: 8080 }).ok).toBe(true)
	})
})

describe('checkComposeSafe', () => {
	it('accepts the rendered compose for valid input', () => {
		expect(checkComposeSafe(renderComposeYaml(base), 'myapp')).toBeNull()
		expect(checkComposeSafe(renderComposeYaml({ ...base, hostPort: 3100, postgres: null, kv: null, publicHost: null }), 'myapp')).toBeNull()
	})
	it('rejects injected privileged/pid/volumes if rendering were bypassed', () => {
		const evilDf = renderComposeYaml({
			...base,
			dockerfilePath: './Dockerfile\n    privileged: true\n    volumes:\n      - /:/host',
		})
		expect(checkComposeSafe(evilDf, 'myapp')).toMatch(/privileged|bind mount/)
		const evilPort = renderComposeYaml({
			...base,
			containerPort: '3000\n    privileged: true\n    pid: host' as unknown as number,
			publicHost: null,
			hostPort: 3100,
		})
		expect(checkComposeSafe(evilPort, 'myapp')).toMatch(/not allowed|does not parse/)
	})
	it('rejects each forbidden key and foreign bind mounts', () => {
		const mk = (extra: string) => `services:\n  a:\n    image: x\n${extra}`
		for (const k of ['privileged: true', 'pid: host', 'cap_add: [SYS_ADMIN]', 'devices: ["/dev/sda"]', 'security_opt: ["seccomp=unconfined"]'])
			expect(checkComposeSafe(mk(`    ${k}\n`), 'myapp')).not.toBeNull()
		expect(checkComposeSafe(mk('    volumes:\n      - /:/host\n'), 'myapp')).not.toBeNull()
		expect(checkComposeSafe(mk('    volumes:\n      - /opt/apps/other/x:/d\n'), 'myapp')).not.toBeNull()
		expect(checkComposeSafe(mk('    volumes:\n      - /opt/apps/myapp/../other:/d\n'), 'myapp')).not.toBeNull()
		expect(checkComposeSafe(mk('    volumes:\n      - /opt/apps/myapp/data:/d\n      - named:/n\n'), 'myapp')).toBeNull()
	})
})
