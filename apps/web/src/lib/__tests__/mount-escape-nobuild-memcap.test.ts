import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DOCKERFILE_REWRITE_AWK, SYNTAX_ALLOWED_ERE } from '../build-cache'
import { composeUpCommand } from '../deploy/fragments'
import { BUILD_CACHE_ID_SH } from '../deploy/self-deploy'
import { buildDeployScript, composeFileArgs } from '../ssh'

const root = mkdtempSync(join(tmpdir(), 'mount-escape-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const REPO = join(__dirname, '../../../../..')

function rewrite(dockerfile: string | Buffer): { out: string; report: string[] } {
	const dir = join(root, `c${++n}`)
	mkdirSync(dir)
	writeFileSync(join(dir, 'Dockerfile'), dockerfile)
	const rp = join(dir, 'rp')
	writeFileSync(rp, '')
	const r = spawnSync('awk', [DOCKERFILE_REWRITE_AWK, join(dir, 'Dockerfile')], {
		encoding: 'utf8',
		env: {
			...process.env,
			LC_ALL: 'C',
			DFR_NS: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
			DFR_APP: 'shop',
			DFR_TF: join(dir, 'tf'),
			DFR_RP: rp,
			DFR_SYNTAX: SYNTAX_ALLOWED_ERE,
		},
	})
	expect(r.status).toBe(0)
	return { out: r.stdout, report: readFileSync(rp, 'utf8').split('\n').filter(Boolean) }
}
const refused = (df: string | Buffer) => rewrite(df).report.filter((l) => l.startsWith('REFUSE'))

// BuildKit drops escape characters in a --mount flag before it splits it.
describe('escape characters in a RUN --mount flag', () => {
	it('refuses a backslash in a --mount spec (type and from)', () => {
		expect(
			refused('FROM x\nRUN --mount=type=cach\\e,target=/root/.npm npm ci\n').length,
		).toBeGreaterThan(0)
		expect(
			refused('FROM x\nRUN --mount=type=bind,fr\\om=victim:latest,target=/s true\n').length,
		).toBeGreaterThan(0)
		expect(
			refused('FROM x\nONBUILD RUN --mount=type=cach\\e,target=/x true\n').length,
		).toBeGreaterThan(0)
	})
	it('refused whatever the frontend version and escape directive say', () => {
		// (a) frontend 1.14 always drops \, even under escape=`
		expect(
			refused(
				'# syntax=docker/dockerfile:1.14\n# escape=`\nFROM x\nRUN --mount=type=cach\\e,target=/root/.npm npm ci\n',
			).length,
		).toBeGreaterThan(0)
		// (b) frontend 1.16+ drops the escape= char inside a flag name
		expect(
			refused('# escape=`\nFROM x\nRUN --mou`nt=type=cache,target=/root/.npm npm ci\n').length,
		).toBeGreaterThan(0)
		expect(
			refused('FROM x\nRUN --mou\\nt=type=cache,target=/root/.npm npm ci\n').length,
		).toBeGreaterThan(0)
		// (c) COPY --from with the escape char hidden in the flag name
		expect(
			refused('# escape=`\nFROM x\nCOPY --fr`om=otherapp:latest /a /b\n').length,
		).toBeGreaterThan(0)
		expect(refused('FROM x\nCOPY --fr\\om=otherapp:latest /a /b\n').length).toBeGreaterThan(0)
	})
	it('a continuation glued to a COPY/ADD flag at the end of the line is not refused', () => {
		expect(refused('FROM x\nCOPY --chown=node:node\\\n  src /dst\n')).toEqual([])
		expect(refused('FROM x\nCOPY --link --chown=node:node \\\n  src /dst\n')).toEqual([])
		const r = rewrite('FROM x\nRUN --mount=type=cache,target=/root/.npm \\\n  npm ci\n')
		expect(r.report.filter((l) => l.startsWith('REFUSE'))).toEqual([])
		expect(r.out).toMatch(/--mount=type=cache,id=shop-[0-9a-f]{20},target=\/root\/\.npm \\$/m)
	})
	it('a # escape= directive other than \\ is refused anywhere in the leading comment block', () => {
		const MSG = 'REFUSE a # escape= parser directive other than \\ is not supported'
		// bypass case: BuildKit ignores a directive after an ordinary comment or a blank line
		expect(
			refused(
				'# hello\n# escape=`\nFROM x\nRUN \\\n  --mount=type=cache,target=/root/.npm npm ci\n',
			),
		).toContain(MSG)
		expect(
			refused('\n# escape=`\nFROM x\nRUN \\\n  --mount=type=cache,target=/root/.npm npm ci\n'),
		).toContain(MSG)
		expect(
			refused('# hello\n# escape=`\nFROM x\nCOPY \\\n  --from=otherapp:latest /a /b\n'),
		).toContain(MSG)
		// a valid leading escape=` directive
		expect(refused('# escape=`\nFROM x\nRUN true\n')).toEqual([MSG])
		// case and spaces do not matter
		expect(refused('#ESCAPE = x\nFROM x\n')).toEqual([MSG])
		expect(refused('  #  Escape=`\nFROM x\n')).toEqual([MSG])
		// exactly a backslash is the default and is accepted
		expect(
			refused('# escape=\\\nFROM x\nRUN --mount=type=cache,target=/root/.npm \\\n  npm ci\n'),
		).toEqual([])
		expect(refused('#ESCAPE = \\\nFROM x\n')).toEqual([])
		// a later comment line inside the Dockerfile body is not a directive
		expect(refused('FROM x\n# escape=`\nRUN true\n')).toEqual([])
	})
	it('refuses a backtick in a --mount spec', () => {
		expect(
			refused('# escape=`\nFROM x\nRUN --mount=type=cach`e,target=/x true\n').length,
		).toBeGreaterThan(0)
		// default escape too: an older or newer frontend may drop it
		expect(refused('FROM x\nRUN --mount=type=cache,target=/a` true\n').length).toBeGreaterThan(0)
	})
	it('a normal cache mount is rewritten, nothing refused', () => {
		const r = rewrite('FROM x\nRUN --mount=type=cache,target=/root/.npm npm ci\n')
		expect(r.report.filter((l) => l.startsWith('REFUSE'))).toEqual([])
		expect(r.report).toContain('REWROTE 1')
		expect(r.out).toMatch(/--mount=type=cache,id=shop-[0-9a-f]{20},target=\/root\/\.npm npm ci/)
	})
	it('end-of-line continuation backslashes still work', () => {
		const r = rewrite(
			'FROM x\nRUN --mount=type=cache,target=/root/.npm \\\n    --mount=type=cache,target=/app/.next/cache \\\n    npm ci && \\\n    npm run build\n',
		)
		expect(r.report.filter((l) => l.startsWith('REFUSE'))).toEqual([])
		expect(r.report).toContain('REWROTE 2')
		expect(r.out).toMatch(/^RUN --mount=type=cache,id=shop-[0-9a-f]{20},target=\/root\/\.npm \\$/m)
	})
	it('a backslash in shell text after the flags is not a flag (no refusal)', () => {
		expect(refused('FROM x\nRUN echo a\\b --mount=type=cach\\e && true\n')).toEqual([])
	})
	it("an explicit id= naming powder's own cache is salted like any other", () => {
		const r = rewrite(
			'FROM x\nRUN --mount=type=cache,id=powder-self-pnpm-,target=/root/.local/share/pnpm/store/v3 true\n',
		)
		expect(r.out).toMatch(/id=shop-[0-9a-f]{20},target=/)
		expect(r.out).not.toContain('powder-self')
	})
	it("powder's own docker/web.Dockerfile passes the check, with secret ids on both cache mounts", () => {
		const df = readFileSync(join(REPO, 'docker/web.Dockerfile'), 'utf8')
		expect(refused(df)).toEqual([])
		const mounts = df.match(/--mount=type=cache[^ ]*/g) ?? []
		expect(mounts.length).toBe(2)
		for (const m of mounts) expect(m).toMatch(/,id=powder-self-[a-z]+-\$\{POWDER_BUILD_CACHE_ID\},/)
		const compose = readFileSync(join(REPO, 'docker-compose.yml'), 'utf8')
		expect(compose.match(/POWDER_BUILD_CACHE_ID: \$\{POWDER_BUILD_CACHE_ID:-\}/g)?.length).toBe(2)
	})
})

// BuildKit's whitespace is Go's unicode.IsSpace (\v, \f,
// 0x85, 0xA0 too). Bypass cases.
describe('whitespace BuildKit sees and the parser does not', () => {
	const VTFF = 'REFUSE a Dockerfile with control characters other than tab is not supported'
	const ESCMSG = 'REFUSE a # escape= parser directive other than \\ is not supported'
	const lead = (r: string[]) =>
		r.some((l) => l.startsWith('REFUSE a line that starts with a non-ASCII character'))
	const flag = (r: string[]) =>
		r.some((l) => /^REFUSE a (RUN|COPY) flag with a non-ASCII byte/.test(l))
	const raw = (...parts: Array<string | number[]>) =>
		Buffer.concat(
			parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))),
		)
	const MOUNT = '--mount=type=cache,target=/root/.npm npm ci\n'
	it('refuses \\v and \\f anywhere (blank line, comment, flag separator, directive padding)', () => {
		expect(refused(`FROM x\nRUN \\\n\v\n${MOUNT}`)).toContain(VTFF)
		expect(refused(`FROM x\nRUN \\\n\f# c\n${MOUNT}`)).toContain(VTFF)
		expect(refused(`FROM x\nRUN --network=none\f${MOUNT}`)).toContain(VTFF)
		expect(refused(`FROM x\nRUN --mount=type=bind,target=/s\v${MOUNT}`)).toContain(VTFF)
		expect(refused(`#\fescape=\`\nFROM x\nRUN \`\n${MOUNT}`)).toContain(VTFF)
		expect(refused('\f# escape=`\nFROM x\nRUN true\n')).toContain(VTFF)
		expect(refused('# escape\f=`\nFROM x\nRUN true\n')).toContain(VTFF)
	})
	it('refuses a line that starts with a no-break space or 0x85 (comment or indentation)', () => {
		expect(lead(refused(`FROM x\nRUN \\\n # c\n${MOUNT}`))).toBe(true)
		expect(lead(refused(raw('FROM x\nRUN \\\n', [0xa0], '# c\n', MOUNT)))).toBe(true)
		expect(lead(refused(raw('FROM x\nRUN \\\n', [0x85], MOUNT)))).toBe(true)
		expect(lead(refused(' # escape=`\nFROM x\nRUN true\n'))).toBe(true)
	})
	it('refuses 0x85 / 0xA0 in or before flag words and next to the keyword', () => {
		expect(flag(refused(raw('FROM x\nRUN --network=none', [0xa0], MOUNT)))).toBe(true)
		expect(flag(refused(raw('FROM x\nRUN --network=none', [0x85], MOUNT)))).toBe(true)
		expect(flag(refused(`FROM x\nRUN --network=none ${MOUNT}`))).toBe(true)
		expect(flag(refused(`FROM x\nRUN --network=none  ${MOUNT}`))).toBe(true)
		expect(
			flag(refused(raw('FROM x\nCOPY --link', [0xa0], '--from=otherapp:latest /a /b\n'))),
		).toBe(true)
		expect(
			refused(`FROM x\nRUN ${MOUNT}`).some((l) => l.startsWith('REFUSE an instruction keyword')),
		).toBe(true)
		expect(refused('FROM x\nRUN --mount=type=cache,target=/r x true\n').length).toBeGreaterThan(0)
	})
	it('refuses an escape directive padded with no-break spaces', () => {
		expect(refused('# escape=`\nFROM x\nRUN true\n')).toContain(ESCMSG)
		expect(refused(raw('#', [0xa0], 'escape=`\nFROM x\nRUN true\n'))).toContain(ESCMSG)
		expect(refused('# escape =\\\nFROM x\nRUN true\n')).toContain(ESCMSG)
	})
	it('CRLF Dockerfiles behave like LF ones', () => {
		const r = rewrite(
			'# syntax=docker/dockerfile:1\r\n# escape=\\\r\nFROM node:22 AS b\r\nCOPY --from=b --chown=node:node /a /a\r\nRUN --mount=type=cache,target=/x \\\r\n  npm ci\r\n',
		)
		expect(r.report.filter((l) => l.startsWith('REFUSE'))).toEqual([])
		expect(r.report).toContain('REWROTE 1')
		expect(r.report).toContain('IMG node:22')
		expect(refused('# escape=`\r\nFROM x\r\n')).toEqual([ESCMSG])
	})
	it('UTF-8 text in shell text and heredoc bodies still passes', () => {
		for (const df of [
			'FROM x\nRUN echo "à la carte, voilà !" && echo ok\n',
			'FROM x\nRUN --mount=type=cache,target=/root/.npm echo "déjà vu" && npm ci\n',
			'# syntax=docker/dockerfile:1\nFROM x\nRUN <<EOF\necho "voilà à bientôt"\n  echo "ça marche"\nEOF\n',
			'FROM x\nCOPY --chown=node:node naïve.txt /app/\n',
		]) {
			const r = rewrite(df)
			expect(
				r.report.filter((l) => l.startsWith('REFUSE')),
				df,
			).toEqual([])
		}
	})
})

// a keyword split by a continuation hid the RUN flags from
// the strict pass. Bypass cases.
describe('instruction keyword split over a line break', () => {
	const KW = (r: string[]) =>
		r.some((l) =>
			l.startsWith('REFUSE an instruction keyword continued over a line break is not supported'),
		)
	const VAR = (r: string[]) =>
		r.some((l) => l.startsWith('REFUSE a --mount= type set from a variable'))
	it('splitkwvar2: R\\ + UN --mount=type=${T}', () => {
		const r = refused('FROM x\nARG T=cache\nR\\\nUN --mount=type=${T},target=/root/.npm npm ci\n')
		expect(KW(r)).toBe(true)
		expect(VAR(r)).toBe(true)
	})
	it('splitkwfrom: R\\ + UN --mount=type=bind,from=otherapp:latest is refused and its image checked', () => {
		const r = rewrite(
			'FROM x\nR\\\nUN --mount=type=bind,from=otherapp:latest,target=/s cat /s/x\n',
		).report
		expect(KW(r.filter((l) => l.startsWith('REFUSE')))).toBe(true)
		expect(r).toContain('IMG otherapp:latest')
	})
	it('runglued: RUN\\ + --mount=type=$T', () => {
		expect(
			KW(refused('ARG T=cache\nFROM x\nRUN\\\n  --mount=type=$T,target=/root/.npm npm ci\n')),
		).toBe(true)
		expect(KW(refused('FROM x\nCOPY\\\n  --from=otherapp:latest /a /b\n'))).toBe(true)
		expect(KW(refused('FROM x\nONBUILD RUN\\\n  --mount=type=$T,target=/x true\n'))).toBe(true)
	})
	it('control: RUN \\ (space before the backslash) is a normal continuation', () => {
		const r = refused('ARG T=cache\nFROM x\nRUN \\\n  --mount=type=$T,target=/root/.npm npm ci\n')
		expect(KW(r)).toBe(false)
		expect(VAR(r)).toBe(true)
		const ok = rewrite('FROM x\nRUN \\\n  --mount=type=cache,target=/root/.npm npm ci\n')
		expect(ok.report.filter((l) => l.startsWith('REFUSE'))).toEqual([])
		expect(ok.report).toContain('REWROTE 1')
	})
	it('the joined line checks --mount flags a physical line split hides (no keyword split)', () => {
		const r = rewrite(
			'FROM x\nRUN --network=none \\\n  --mount=type=bind,from=otherapp:latest,target=/s true\n',
		).report
		expect(r).toContain('IMG otherapp:latest')
	})
	it('a heredoc body line ending in a glued backslash is not a keyword split', () => {
		expect(
			refused(
				'# syntax=docker/dockerfile:1\nFROM x\nRUN <<EOF\necho\\\n  done\nEOF\nRUN --mount=type=cache,target=/x true\n',
			),
		).toEqual([])
	})
})

describe('build cache id snippet', () => {
	it('bin/self-deploy.sh and the dashboard self-deploy use the same snippet', () => {
		const sh = readFileSync(join(REPO, 'bin/self-deploy.sh'), 'utf8')
		expect(sh).toContain(`BUILD_CACHE_ID_SH='${BUILD_CACHE_ID_SH}'`)
		expect(sh).toContain('POWDER_BUILD_CACHE_ID=$BCID OS_PATCH_WEEK=$OS_PATCH_WEEK $DC build powder')
		expect(sh).toContain('POWDER_BUILD_CACHE_ID=$BCID OS_PATCH_WEEK=$OS_PATCH_WEEK $DC build worker')
	})
	it('creates a 32-hex id once and reads the same value back', () => {
		const dir = join(root, 'opt')
		mkdirSync(dir)
		const snip = BUILD_CACHE_ID_SH.replaceAll('/opt/apps', dir)
		const a = spawnSync('sh', ['-c', snip], { encoding: 'utf8' }).stdout
		const b = spawnSync('sh', ['-c', snip], { encoding: 'utf8' }).stdout
		expect(a).toMatch(/^[0-9a-f]{32}$/)
		expect(b).toBe(a)
	})
	it('prints nothing (never fails) when the dir is missing', () => {
		const r = spawnSync(
			'sh',
			['-c', BUILD_CACHE_ID_SH.replaceAll('/opt/apps', join(root, 'nope'))],
			{ encoding: 'utf8' },
		)
		expect(r.stdout).toBe('')
	})
})

// the non-deploy `up` (rollback, domain apply, container apply) never builds.
describe('compose up outside the deploy script', () => {
	it('composeUpCommand always passes --no-build', () => {
		expect(composeUpCommand('/opt/apps/a/docker-compose.yml', 'app', '/opt/apps/a', { approval: { hash: '', app: null, log: '' } })).toContain(
			'up -d --no-build --force-recreate --no-deps ',
		)
		expect(
			composeUpCommand('/c.yml', 'app', '/w', { approval: { hash: '', app: null, log: '' }, targets: '$TARGETS', lock: false, tail: null }),
		).toContain('up -d --no-build --force-recreate ${TARGETS:+--no-deps} $TARGETS')
	})
	it("the deploy script's own up is unchanged (no --no-build)", () => {
		const s = buildDeployScript({
			workingDir: '/opt/apps/demo',
			configFile: '/opt/apps/demo/docker-compose.yml',
			service: 'app',
			cf: composeFileArgs('/opt/apps/demo/docker-compose.yml'),
			declaredMode: 'build',
			prebuilt: false,
			migrateApp: 'demo',
			infra: ['db'],
			wantBranch: 'main',
			wantSha: null,
			shaIsStrict: false,
		})
		expect(s).toContain('up -d --force-recreate ${TARGETS:+--no-deps} $TARGETS')
		expect(s).not.toContain('--no-build')
	})
})

// the memory cap / restart normalize is opt-in through /opt/apps/.mem-cap.
describe('normalize step after the recreate', () => {
	const script = buildDeployScript({
		workingDir: '/opt/apps/demo',
		configFile: '/opt/apps/demo/docker-compose.yml',
		service: 'app',
		cf: composeFileArgs('/opt/apps/demo/docker-compose.yml'),
		declaredMode: 'build',
		prebuilt: false,
		migrateApp: 'demo',
		infra: ['db'],
		wantBranch: 'main',
		wantSha: null,
		shaIsStrict: false,
	})
	const start = script.indexOf('NCAP=')
	const end = script.indexOf(' && step "resolve image"')
	const frag = script.slice(start, end)

	function run(memCap: string | null, mem: string, restart: string): string[] {
		const dir = join(root, `n${++n}`)
		mkdirSync(dir)
		const log = join(dir, 'log')
		writeFileSync(log, '')
		const prelude =
			`cat() { if [ "$1" = /opt/apps/.mem-cap ]; then ${memCap === null ? 'return 1' : `printf '%s\\n' '${memCap}'`}; else command cat "$@"; fi; }; ` +
			`docker() { case "$*" in "compose "*"ps -q"*) echo cid1;; *HostConfig.Memory*) echo '${mem}';; *RestartPolicy*) echo '${restart}';; update*) echo "$*" >> '${log}';; esac; }; `
		const r = spawnSync('bash', ['-c', `${prelude}${frag} && echo DONE`], { encoding: 'utf8' })
		expect(r.stdout).toContain('DONE')
		return readFileSync(log, 'utf8').split('\n').filter(Boolean)
	}

	it('no /opt/apps/.mem-cap: nothing is updated', () => {
		expect(frag).not.toContain('echo 2g')
		expect(run(null, '0', 'no')).toEqual([])
		expect(run('', '0', 'no')).toEqual([])
	})
	it('with .mem-cap: an uncapped container with no restart policy gets both', () => {
		expect(run('2g', '0', 'no')).toEqual([
			'update --restart=unless-stopped cid1',
			'update --memory=2g --memory-swap=2g cid1',
		])
		expect(run('4g', '0', '')).toEqual([
			'update --restart=unless-stopped cid1',
			'update --memory=4g --memory-swap=4g cid1',
		])
	})
	it('with .mem-cap: the cap overrides a compose mem_limit; an explicit restart policy wins', () => {
		// compose mem_limit 1g, the server cap raises it to 4g on every deploy
		expect(run('4g', '1073741824', 'always')).toEqual(['update --memory=4g --memory-swap=4g cid1'])
		expect(run('2g', '536870912', 'no')).toEqual([
			'update --restart=unless-stopped cid1',
			'update --memory=2g --memory-swap=2g cid1',
		])
		expect(run('2g', '0', 'on-failure')).toEqual(['update --memory=2g --memory-swap=2g cid1'])
	})
	it('no .mem-cap: a container with its own limit is untouched', () => {
		expect(run(null, '1073741824', 'no')).toEqual([])
	})
})
