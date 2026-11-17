import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILDER_FALLBACK_PREFIX, extractBuilderFallback } from '../hq'

describe('extractBuilderFallback', () => {
	it('ignores not-builder-eligible skips', () => {
		expect(
			extractBuilderFallback(
				'x\n[builder] phase failed - compose build uses secrets/additional_contexts - those inputs live on the target; not builder-eligible\ny',
			),
		).toBeNull()
		expect(
			extractBuilderFallback(
				'[builder] phase failed - builder: context /a is not a src/-layout path - not builder-eligible',
			),
		).toBeNull()
	})
	it('keeps real failures', () => {
		const l = '[builder] phase failed - Permission denied (publickey)'
		expect(extractBuilderFallback(`a\n${l}\nb`)).toBe(l)
		expect(extractBuilderFallback('all good')).toBeNull()
	})
	it('parity pin: deploy/run.ts prints exactly the prefix hq.ts matches', () => {
		const run = readFileSync(join(__dirname, '../deploy/run.ts'), 'utf8')
		expect(run).toContain(`\`${BUILDER_FALLBACK_PREFIX}\${`)
		expect(extractBuilderFallback(`${BUILDER_FALLBACK_PREFIX}boom`)).toBe(
			`${BUILDER_FALLBACK_PREFIX}boom`,
		)
	})
})
