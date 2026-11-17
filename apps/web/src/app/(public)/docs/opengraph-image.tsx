import { OG_CONTENT_TYPE, OG_SIZE, renderCard } from '@/lib/og-card'

export const alt = 'powder docs'
export const size = OG_SIZE
export const contentType = OG_CONTENT_TYPE

export default function Image() {
	return renderCard({
		eyebrow: 'Docs',
		title: 'How powder works',
		sub: 'Self-hosting, how deploys run, domains, env vars, backups, crons and uptime.',
	})
}
