// Writes brand/ + app icons for the powder logo from logo-geometry.ts.
// Run from the repo root: node --experimental-strip-types brand/scripts/gen-icons.mts
// Needs sharp resolvable from apps/web (pnpm install).
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WEB = `${REPO}/apps/web`
const require = createRequire(`${WEB}/package.json`)
// sharp ships with next (transitive), so resolve it from next's package.
const sharp = createRequire(require.resolve('next/package.json'))('sharp')
const G = await import(`${WEB}/src/components/ui/logo-geometry.ts`)
const { BRAND, MARK, MARK_SMALL, WORDMARK_O, WORDMARK_LETTERS, WORDMARK_VIEWBOX: VB, ringPath } = G

const ring = (s, ink, spark) => `<path d="${ringPath(s)}" fill="none" stroke="${ink}" stroke-width="${s.stroke}"/><circle cx="${s.sparkX}" cy="${s.sparkY}" r="${s.sparkR}" fill="${spark}"/>`
const glowRing = (s, blur) => `<g filter="url(#g)" opacity=".8"><path d="${ringPath(s)}" fill="none" stroke="${BRAND.cyan}" stroke-width="${s.stroke}"/><circle cx="${s.sparkX}" cy="${s.sparkY}" r="${s.sparkR}" fill="${BRAND.cyan}"/></g>${ring(s, BRAND.cyan, BRAND.spark)}`
const defs = (blur) => `<defs><filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>`

// Favicon tile: dark rounded tile, heavy small drawing (same as PowderMark tile).
export const favSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${BRAND.bg}"/><g transform="translate(7 7) scale(0.78125)">${ring(MARK_SMALL, BRAND.cyan, BRAND.spark)}</g></svg>`
// Full-bleed square (apple / maskable / avatar): mark inside `frac` of the side, glow.
const bleed = (frac, spec = MARK) => {
	const k = frac
	const t = 32 - 32 * k
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${defs(1.6)}<rect width="64" height="64" fill="${BRAND.bg}"/><g transform="translate(${t} ${t}) scale(${k})">${glowRing(spec, 1.8)}</g></svg>`
}
// Rounded app tile ("any" purpose manifest icons, brand mark png).
const appTile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${defs(1.6)}<rect width="64" height="64" rx="14" fill="${BRAND.bg}"/><g transform="translate(11.2 11.2) scale(0.65)">${glowRing(MARK, 1.8)}</g></svg>`

const png = (svg, size) => sharp(Buffer.from(svg), { density: 72 * Math.max(1, size / 64) * 4 }).resize(size, size).png().toBuffer()

// ICO with embedded PNGs.
function ico(pngs) {
	const head = Buffer.alloc(6 + 16 * pngs.length)
	head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4)
	let off = head.length
	pngs.forEach(([size, buf], i) => {
		const e = 6 + 16 * i
		head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1)
		head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6)
		head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(off, e + 12)
		off += buf.length
	})
	return Buffer.concat([head, ...pngs.map(([, b]) => b)])
}

const word = (text, ringInk, spark, glow) => {
	const o = WORDMARK_O
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB.x} ${VB.y} ${VB.width} ${VB.height}" width="${VB.width * 2}" height="${VB.height * 2}">${glow ? defs(3.2) + `<g filter="url(#g)" opacity=".75"><path d="${ringPath(o)}" fill="none" stroke="${BRAND.cyan}" stroke-width="${o.stroke}"/><circle cx="${o.sparkX}" cy="${o.sparkY}" r="${o.sparkR}" fill="${BRAND.cyan}"/></g>` : ''}<path d="${WORDMARK_LETTERS}" fill="${text}"/>${ring(o, ringInk, spark)}</svg>`
}

const w = (p, b) => writeFileSync(p, b)
w(`${WEB}/src/app/icon.svg`, favSvg)
w(`${WEB}/src/app/favicon.ico`, ico([[16, await png(favSvg.replace('translate(7 7) scale(0.78125)', 'translate(5 5) scale(0.84375)'), 16)], [32, await png(favSvg, 32)]]))
w(`${WEB}/src/app/apple-icon.png`, await png(bleed(0.6), 180))
w(`${WEB}/public/icon-192.png`, await png(appTile, 192))
w(`${WEB}/public/icon-512.png`, await png(appTile, 512))
// maskable: everything inside the 80% safe circle; the mark fits a 0.55 square.
w(`${WEB}/public/icon-maskable-512.png`, await png(bleed(0.55), 512))
const B = `${REPO}/brand`
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${ring(MARK, BRAND.cyan, BRAND.spark)}</svg>`
w(`${B}/powder-mark.svg`, markSvg)
w(`${B}/powder-mark-small.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${ring(MARK_SMALL, BRAND.cyan, BRAND.spark)}</svg>`)
w(`${B}/powder-icon.svg`, favSvg)
w(`${B}/powder-mark-512.png`, await png(appTile, 512))
w(`${B}/github-avatar-512.png`, await png(bleed(0.62), 512))
w(`${B}/powder-wordmark.svg`, word('#05070c', BRAND.cyanInk, BRAND.cyanInk, false))
w(`${B}/powder-wordmark-dark.svg`, word(BRAND.text, BRAND.cyan, BRAND.spark, true))
writeFileSync(new URL('./fav.json', import.meta.url), JSON.stringify({ favSvg, markSvg }))
console.log('ok')
