import { HERO_LINE, OG_CONTENT_TYPE, OG_SIZE, renderCard } from '@/lib/og-card'

export const alt = 'powder: push to deploy on servers you own'
export const size = OG_SIZE
export const contentType = OG_CONTENT_TYPE

export default function Image() {
	return renderCard({
		title: HERO_LINE,
		sub: 'Open-source deploy platform. It builds on your server, health-checks the result and swaps it in.',
	})
}
