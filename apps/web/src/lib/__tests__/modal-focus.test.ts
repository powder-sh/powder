// Modals keep keyboard focus: focus moves in on open, Tab cycles inside, focus goes
// back to the trigger on close (components/ui/use-modal-focus.ts), and a dialog whose
// action runs cannot be closed under it. The DOM half is checked in a real browser;
// here the cycle itself and that every modal uses the one hook.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { trapTarget } from '@/components/ui/use-modal-focus'

const root = join(__dirname, '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

describe('focus trap cycle', () => {
	const items = ['cancel', 'input', 'confirm']
	it('Tab on the last control wraps to the first, Shift+Tab on the first to the last', () => {
		expect(trapTarget(items, 'confirm', false)).toBe('cancel')
		expect(trapTarget(items, 'cancel', true)).toBe('confirm')
	})
	it('inside the panel the browser moves focus itself', () => {
		expect(trapTarget(items, 'cancel', false)).toBeNull()
		expect(trapTarget(items, 'confirm', true)).toBeNull()
	})
	it('focus outside the panel is pulled back in', () => {
		expect(trapTarget(items, null, false)).toBe('cancel')
		expect(trapTarget(items, null, true)).toBe('confirm')
	})
	it('a panel with nothing focusable has no target', () => {
		expect(trapTarget([], null, false)).toBeNull()
	})
})

describe('every modal uses the shared focus hook', () => {
	it('the confirm dialog and the command palette', () => {
		for (const f of ['components/ui/confirm-dialog.tsx', 'components/command-palette.tsx']) {
			expect(read(f), f).toMatch(/useModalFocus\(open, panelRef\)/)
		}
	})
	it('no other aria-modal panel and no hand-rolled initial focus in a dialog', () => {
		const files: string[] = []
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const p = join(dir, name)
				if (statSync(p).isDirectory()) walk(p)
				else if (/\.tsx$/.test(name)) files.push(p)
			}
		}
		walk(join(root, 'app'))
		walk(join(root, 'components'))
		const modal = files
			.map((f) => relative(root, f))
			.filter((f) => /aria-modal/.test(read(f)))
		expect(modal).toEqual(['components/ui/confirm-dialog.tsx'])
		// the typed confirmation is focused through data-autofocus, not a timer
		expect(read('app/(dashboard)/projects/[id]/settings/danger-zone.tsx')).not.toMatch(/setTimeout\(\(\) => \w+Ref\.current\?\.focus/)
	})
	it('the confirm dialog does not close on Escape or the backdrop while its action runs', () => {
		const src = read('components/ui/confirm-dialog.tsx')
		expect(src).toMatch(/if \(e\.key === 'Escape'\) \{\s*if \(!loading\) onClose\(\)/)
		expect(src).toMatch(/onClick=\{\(\) => \{\s*if \(!loading\) onClose\(\)/)
	})
	it('the delete-app and stop dialogs guard onClose with busy, like the server and cron dialogs', () => {
		const src = read('app/(dashboard)/projects/[id]/settings/danger-zone.tsx')
		expect(src).toContain("onClose={() => busy !== 'delete' && setPending(null)}")
		expect(src).toContain("onClose={() => busy !== 'stop' && setPending(null)}")
	})
})
