import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// The tests run the repo's shell scripts under the host's `bash`, and
// bin/self-deploy.sh runs the tests on a Mac, where /bin/bash is 3.2. A bash-4-only
// construct in a script a test runs passes on the Linux gate and fails (or passes for
// the wrong reason) on the Mac. A script that may use them runs only on Linux servers
// and is listed here with the reason; its tests must not depend on the bash 4 part.

const REPO = join(__dirname, '../../../../..')
const DIRS = ['bin', 'infra', 'docker', '.powder']

/** Scripts that need bash 4+ (Linux servers only), and why that is fine. */
const NEEDS_BASH4: Record<string, string> = {
	'infra/powder-image-prune.sh':
		'hourly prune on Linux servers (declare -A); its tests stub docker and assert the volume and lock steps only',
}

const BASH4 = [
	{ re: /\b(declare|local|typeset)\s+-[a-zA-Z]*A/, what: 'associative array' },
	{ re: /\b(mapfile|readarray)\b/, what: 'mapfile/readarray' },
	{
		re: /\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?(,,?|\^\^?)\}/,
		what: '${var,,} / ${var^^} case change',
	},
	{ re: /&>>/, what: '&>> append' },
	{ re: /[^|]\|&/, what: '|& pipe' },
]

function shellFiles(dir: string): string[] {
	let out: string[] = []
	let entries: import('node:fs').Dirent[]
	try {
		entries = readdirSync(dir, { withFileTypes: true })
	} catch {
		return out
	}
	for (const e of entries) {
		const p = join(dir, e.name)
		if (e.isDirectory()) out = out.concat(shellFiles(p))
		else if (e.name.endsWith('.sh')) out.push(p)
	}
	return out
}

describe('shell scripts stay bash 3.2 compatible unless they declare bash 4+', () => {
	const files = DIRS.flatMap((d) => shellFiles(join(REPO, d))).map((f) => relative(REPO, f))

	it('finds the scripts', () => {
		expect(files).toContain('bin/self-deploy.sh')
	})

	it('no bash-4-only construct outside NEEDS_BASH4', () => {
		const hits: string[] = []
		for (const f of files) {
			if (f in NEEDS_BASH4) continue
			readFileSync(join(REPO, f), 'utf8')
				.split('\n')
				.forEach((line, i) => {
					if (/^\s*#/.test(line)) return
					for (const b of BASH4) if (b.re.test(line)) hits.push(`${f}:${i + 1}: ${b.what}`)
				})
		}
		expect(hits).toEqual([])
	})

	it('every NEEDS_BASH4 entry still exists', () => {
		for (const f of Object.keys(NEEDS_BASH4)) expect(files).toContain(f)
	})
})
