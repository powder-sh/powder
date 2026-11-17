import { describe, expect, it } from 'vitest'
import { parseDeployedImage } from '../ssh'

describe('parseDeployedImage', () => {
	it('takes the final image: line, not an earlier "image:" in build output', () => {
		expect(parseDeployedImage('Using image: node:22\nstep ...\nimage: app:latest\n')).toBe('app:latest')
	})
	it('ignores image: mid-line and takes the last whole-line match', () => {
		expect(parseDeployedImage('image: old:1\n  base image: node:22 done\nimage: new:2\n')).toBe('new:2')
	})
	it('returns null when there is no image line', () => {
		expect(parseDeployedImage('Using image: node:22\n')).toBeNull()
	})
})
