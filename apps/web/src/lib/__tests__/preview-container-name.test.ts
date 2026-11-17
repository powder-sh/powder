import { describe, expect, it } from 'vitest'
import {
	PreviewNameCollisionError,
	assertPreviewNameFree,
	previewContainerName,
} from '../preview-deploys'

const free = { appContainerNames: [], otherPreviewNames: [], dirExists: async () => false }

describe('previewContainerName', () => {
	it('namespaces previews under pv-', () => {
		expect(previewContainerName('shop', 'feat-x')).toBe('pv-shop-feat-x')
	})
	it('keeps long names unique and within 50 chars', () => {
		const a = previewContainerName('a'.repeat(40), 'b'.repeat(24) + '1')
		const b = previewContainerName('a'.repeat(40), 'b'.repeat(24) + '2')
		expect(a.length).toBeLessThanOrEqual(50)
		expect(a).not.toBe(b)
	})
})

describe('assertPreviewNameFree', () => {
	it('rejects a name equal to an existing app', async () => {
		await expect(
			assertPreviewNameFree({ ...free, name: 'pv-shop-x', appContainerNames: ['pv-shop-x'] }),
		).rejects.toBeInstanceOf(PreviewNameCollisionError)
	})
	it('rejects an existing /opt/apps dir', async () => {
		await expect(
			assertPreviewNameFree({ ...free, name: 'pv-shop-x', dirExists: async (p) => p === '/opt/apps/pv-shop-x' }),
		).rejects.toBeInstanceOf(PreviewNameCollisionError)
	})
	it('rejects another preview and allows a free name', async () => {
		await expect(
			assertPreviewNameFree({ ...free, name: 'pv-a', otherPreviewNames: ['pv-a'] }),
		).rejects.toBeInstanceOf(PreviewNameCollisionError)
		await expect(assertPreviewNameFree({ ...free, name: 'pv-a' })).resolves.toBeUndefined()
	})
})
