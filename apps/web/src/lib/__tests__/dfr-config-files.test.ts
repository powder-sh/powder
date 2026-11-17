import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// The deploy script passes its per-deploy temp overrides
// ($DFR_DIR/override.yml, $DFR_DIR/labels.yml) to `compose up`; compose records every
// -f in the container's com.docker.compose.project.config_files label; the EXIT trap
// deletes them. The NEXT deploy read its file list from that label and every compose
// call failed: "preflight: compose file is INVALID - open /tmp/powder-dfr.XXXXXX/override.yml:
// no such file or directory" (seen on builder-prebuilt deploys in warn mode).

let inspectJson = '[]'
vi.mock('../ssh/connection', () => ({
	runCommand: async () => ({ code: 0, stdout: inspectJson, stderr: '' }),
	withConnection: () => ({}),
}))

const { isPowderTempComposeFile } = await import('../compose-override')
const { composeFileArgs } = await import('../deploy/fragments')
const { buildDeployScript } = await import('../deploy/script')
const { inspectContainer } = await import('../ssh/discovery')

const root = mkdtempSync(join(tmpdir(), 'hf-dfr-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const TEMP = [
	'/tmp/powder-dfr.FnNWsB/override.yml',
	'/tmp/powder-dfr.Q5rpZc/labels.yml',
	'/tmp/powder-stage.ab12CD',
]

describe('powder temp overrides never come back as compose files', () => {
	it('isPowderTempComposeFile matches only the per-deploy temp files', () => {
		for (const f of TEMP) expect(isPowderTempComposeFile(f), f).toBe(true)
		// the persistent per-deploy set under powder's compose state dir
		const base = (process.env.POWDER_COMPOSE_STATE_DIR ?? '/var/lib/powder/compose').replace(
			/\/+$/,
			'',
		)
		expect(isPowderTempComposeFile(`${base}/abc-docker-compose.yml/dfr/override.yml`)).toBe(true)
		expect(isPowderTempComposeFile(`${base}/abc-docker-compose.yml/dfr/labels.yml`)).toBe(true)
		expect(
			isPowderTempComposeFile(`${base}/abc-docker-compose.yml/docker-compose.powder.yml`),
		).toBe(false)
		for (const f of [
			'/opt/apps/x/docker-compose.yml',
			'/tmp/powder-dfr.x/other.yml',
			'/var/lib/powder/compose/k/docker-compose.powder.yml',
			'/opt/apps/x/override.yml',
		])
			expect(isPowderTempComposeFile(f), f).toBe(false)
	})

	it('discovery drops them from the config_files label', async () => {
		inspectJson = JSON.stringify([
			{
				Name: '/shop',
				Config: {
					Image: 'shop:latest',
					Env: [],
					Labels: {
						'com.docker.compose.project': 'shop',
						'com.docker.compose.service': 'shop',
						'com.docker.compose.project.working_dir': '/opt/apps/shop',
						'com.docker.compose.project.config_files': `/opt/apps/shop/docker-compose.yml,/var/lib/powder/compose/k/docker-compose.powder.yml,${TEMP[0]},${TEMP[1]}`,
					},
				},
				State: { Status: 'running', StartedAt: '', Restarting: false },
				Created: '',
				HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
				RestartCount: 0,
				NetworkSettings: { Ports: {} },
				Mounts: [],
			},
		])
		const d = await inspectContainer({ id: 's', host: 'h' } as never, 'shop')
		expect(d.compose.configFiles).toEqual([
			'/opt/apps/shop/docker-compose.yml',
			'/var/lib/powder/compose/k/docker-compose.powder.yml',
		])
		expect(d.compose.configFile).toBe('/opt/apps/shop/docker-compose.yml')
	})

	it('composeFileArgs drops them too (a list from anywhere else)', () => {
		const cf = composeFileArgs('/opt/apps/shop/docker-compose.yml', [
			'/opt/apps/shop/docker-compose.yml',
			...TEMP,
		])
		expect(cf).not.toContain('/tmp/powder-')
	})
})

// Two deploys under bash: deploy 1 records the `up` -f list as the label would; deploy 2
// (builder-prebuilt, warn mode, the pinned second run of a re-check) builds its compose
// args from that label the way the runner does. The stub docker fails any compose call
// that names a missing -f file, exactly like compose.
const DOCKER = `#!/bin/bash
# the base image ONBUILD check (dfr_bases): no triggers
if [[ "$*" == *".Config.OnBuild"* ]]; then echo 0; exit 0; fi
# image IDs and configs for the provenance check (dfr_prov)
if [[ "$*" == *"{{.Id}}"* ]]; then echo "sha256:$(printf %s "\${@: -1}" | cksum | cut -d" " -f1)"; exit 0; fi
if [[ "$*" == *"{{json .Config}}"* ]]; then echo "{}"; exit 0; fi
if [[ "$*" == *"range .RepoDigests"* ]]; then r="\${@: -1}"; r="\${r%%@*}"; case "\${r##*/}" in *:*) r="\${r%:*}";; esac; echo "$r@sha256:0000000000000000000000000000000000000000000000000000000000000000"; exit 0; fi
args=("$@")
if [ "$1" = compose ]; then
  i=1
  while [ $i -lt $# ]; do
    if [ "\${args[$i]}" = -f ]; then f="\${args[$((i+1))]}"; if [ ! -e "$f" ]; then echo "open $f: no such file or directory" >&2; exit 1; fi; fi
    i=$((i+1))
  done
fi
case "$*" in
  info*) exit 0;;
  *"config --services"*) echo shop; exit 0;;
  *"config --images"*) echo shop:latest; exit 0;;
  *"config --format json"*|*"config --no-interpolate --format json"*) printf '{\\n  "name": "shop"\\n}\\n'; exit 0;;
  *" config"*) printf 'name: shop\\nservices:\\n  shop:\\n    build:\\n      context: %s\\n      dockerfile: Dockerfile\\n    image: shop:latest\\n' "$CTX"; exit 0;;
  *" up "*)
    fs=""; i=1
    while [ $i -lt $# ]; do if [ "\${args[$i]}" = -f ]; then fs="$fs,\${args[$((i+1))]}"; fi; i=$((i+1)); done
    echo "\${fs#,}" > "$LABEL"; exit 0;;
  *" ps -q"*) echo cid123; exit 0;;
  "image inspect"*) echo '{}'; exit 0;;
  inspect*) echo shop:latest; exit 0;;
  *) exit 0;;
esac
`

function deploy(wd: string, composeFiles: string[] | undefined, label: string, raw = false) {
	const d = mkdtempSync(join(root, 'run-'))
	const bin = join(d, 'bin')
	mkdirSync(bin)
	writeFileSync(join(bin, 'docker'), DOCKER)
	writeFileSync(
		join(bin, 'flock'),
		'#!/bin/bash\nif [ "$1" = -w ]; then shift 2; fi\nif [ "$1" = 9 ]; then exit 0; fi\nshift; exec "$@"\n',
	)
	writeFileSync(join(bin, 'timeout'), '#!/bin/bash\n[ "$1" = -k ] && shift 2; shift; exec "$@"\n')
	writeFileSync(join(bin, 'sleep'), '#!/bin/bash\nexit 0\n')
	for (const f of ['docker', 'flock', 'timeout', 'sleep']) chmodSync(join(bin, f), 0o755)
	const configFile = `${wd}/docker-compose.yml`
	// The hash the stub's two `config --format json` outputs give (see composeConfigHashShell).
	const cfgJson = '{\n  "name": "shop"\n}\n'
	const hash = createHash('sha256').update(`${cfgJson}---\n${cfgJson}`).digest('hex')
	const script = buildDeployScript({
		workingDir: wd,
		configFile,
		service: 'shop',
		cf:
			raw && composeFiles
				? composeFiles.map((f) => `-f '${f}'`).join(' ')
				: composeFileArgs(configFile, composeFiles),
		declaredMode: 'auto',
		prebuilt: true,
		stageImage: 'shop:build-x',
		infra: null,
		wantBranch: null,
		wantSha: null,
		shaIsStrict: false,
		swapOrdinal: undefined,
		stageId: 'dep_t',
		migrateApp: 'shop',
		composeHash: hash,
		composeGuardEnforce: false,
		composeGuardRecheck: false,
		composeHashEnforce: true,
		cacheNamespace: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
		composeFiles,
	} as Parameters<typeof buildDeployScript>[0])
	writeFileSync(join(d, 'deploy.sh'), script)
	const r = spawnSync('bash', [join(d, 'deploy.sh')], {
		encoding: 'utf8',
		cwd: d,
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LABEL: label, CTX: join(wd, 'src') },
	})
	return `${r.stdout}${r.stderr}`
}

const stateEnv = process.env.POWDER_COMPOSE_STATE_DIR
afterAll(() => {
	if (stateEnv === undefined) process.env.POWDER_COMPOSE_STATE_DIR = undefined
	else process.env.POWDER_COMPOSE_STATE_DIR = stateEnv
})

function app(name: string) {
	const wd = join(root, name)
	mkdirSync(join(wd, 'src'), { recursive: true })
	writeFileSync(join(wd, 'docker-compose.yml'), 'services: {}\n')
	writeFileSync(
		join(wd, 'src', 'Dockerfile'),
		'FROM node:22\nRUN --mount=type=cache,target=/root/.npm true\n',
	)
	return wd
}

describe('the per-deploy override set is persistent (builder-prebuilt, warn re-check run)', () => {
	it('the label names existing files, and deploy 2 succeeds with the raw label list and no filter at all', () => {
		const state = join(root, 'state')
		mkdirSync(state)
		process.env.POWDER_COMPOSE_STATE_DIR = state
		const wd = app('app2')
		const label = join(root, 'label2')

		const out1 = deploy(wd, undefined, label)
		expect(out1).toContain('── docker compose up ──')
		const recorded = readFileSync(label, 'utf8').trim().split(',')
		const ov = recorded.find((f) => f.endsWith('/dfr/override.yml'))
		expect(ov?.startsWith(`${state}/`)).toBe(true)
		// no per-deploy temp file (/tmp/powder-dfr.*): only the app's compose file and
		// the persistent set under the state dir. (The test root itself is under
		// os.tmpdir(), which is /tmp on Linux, so a bare '/tmp/' prefix check is host-dependent.)
		expect(recorded.filter((f) => f !== `${wd}/docker-compose.yml` && !f.startsWith(`${state}/`))).toEqual([])
		// every file the label names exists after the deploy, and so does the rewritten
		// Dockerfile the override points at: a later plain `compose up` reproduces the config
		for (const f of recorded) expect(existsSync(f), f).toBe(true)
		const df = /dockerfile: (\S+)/.exec(readFileSync(ov as string, 'utf8'))?.[1]
		expect(df && existsSync(df)).toBe(true)
		expect(readFileSync(df as string, 'utf8')).toContain('id=shop-')
		// 0700, and no half-built set left behind
		expect(statSync(join(state, readdirSync(state)[0] as string, 'dfr')).mode & 0o777).toBe(0o700)
		expect(
			readdirSync(join(state, readdirSync(state)[0] as string)).filter((n) => n !== 'dfr'),
		).toEqual([])

		const out2 = deploy(wd, recorded, label, true)
		expect(out2).not.toContain('compose file is INVALID')
		expect(out2).not.toContain('no such file or directory')
		expect(out2).toContain('── docker compose up ──')
		// deploy 2 replaced the set as a whole; the label still names existing files
		for (const f of readFileSync(label, 'utf8').trim().split(','))
			expect(existsSync(f), f).toBe(true)
	})

	it('falls back to a /tmp dir when the state dir cannot be written; old /tmp labels are filtered', () => {
		process.env.POWDER_COMPOSE_STATE_DIR = join(root, 'not-a-dir-file')
		writeFileSync(join(root, 'not-a-dir-file'), 'x')
		const wd = app('app3')
		const label = join(root, 'label3')
		const out1 = deploy(wd, undefined, label)
		expect(out1).toContain('[build-cache] WARN cannot write the per-app override dir')
		const recorded = readFileSync(label, 'utf8').trim().split(',')
		const tmpOv = recorded.find((f) => /\/powder-dfr\.[^/]+\/override\.yml$/.test(f))
		expect(tmpOv).toBeTruthy()
		expect(existsSync(tmpOv as string)).toBe(false)
		const out2 = deploy(wd, recorded, label)
		expect(out2).not.toContain('compose file is INVALID')
		expect(out2).toContain('── docker compose up ──')
	})
})
