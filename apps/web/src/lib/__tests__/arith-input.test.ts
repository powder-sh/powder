// a value read from a file never reaches $() unvalidated: bash arithmetic
// evaluates a name or an `a[$(cmd)]` subscript in it. The deploy's memory gate reads its
// floor from /opt/apps/.build-min-mem-mb. Real bash on the generated line.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildDeployScript } from '../deploy/script'

const script = buildDeployScript({
	workingDir: '/opt/apps/shop',
	configFile: '/opt/apps/shop/docker-compose.yml',
	service: 'shop',
	cf: "-f '/opt/apps/shop/docker-compose.yml'",
	declaredMode: 'build',
	prebuilt: false,
	infra: [],
	wantBranch: null,
	wantSha: null,
	shaIsStrict: false,
	swapOrdinal: 1700000000000,
	stageId: 'dep_x',
})

/** The generated statement that reads the floor, with the file path pointed at `file`. */
function floorLine(file: string): string {
	const m = script.match(/MG_MIN_MB=\$\(cat \/opt\/apps\/\.build-min-mem-mb[^\n]*?esac; /)
	expect(m).not.toBeNull()
	return (m?.[0] ?? '').replace('/opt/apps/.build-min-mem-mb', file)
}

describe('the memory gate floor is digits only', () => {
	const dir = mkdtempSync(join(tmpdir(), 'arith-'))
	const run = (content: string) => {
		const f = join(dir, 'floor')
		writeFileSync(f, content)
		const r = spawnSync('bash', ['-c', `${floorLine(f)} echo "$((MG_MIN_MB*1024))"`], { encoding: 'utf8', cwd: dir })
		return r.stdout.trim()
	}
	it('a plain number is used', () => {
		expect(run('2048\n')).toBe(String(2048 * 1024))
	})
	it('anything else falls back to the default and runs nothing', () => {
		const marker = join(dir, 'pwned')
		for (const bad of [`a[$(touch ${marker})]`, 'HOME', '08', '1e3', '', ' 512', '123456789'])
			expect(run(bad)).toBe(String(1536 * 1024))
		expect(existsSync(marker)).toBe(false)
	})
	it('the gate reads no other file value into arithmetic', () => {
		expect(readFileSync(new URL('../deploy/script.ts', import.meta.url), 'utf8')).toContain("case \"$MG_MIN_MB\" in ''|*[!0-9]*|0?*|????????*) MG_MIN_MB=1536;; esac")
	})
})
