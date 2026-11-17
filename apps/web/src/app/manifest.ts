import { WIRE_BG } from '@/lib/site'
import type { MetadataRoute } from 'next'

// Served at /manifest.webmanifest (a root dotted path, so the public-site
// host allows it; lib/hosts.ts). Icons live in public/.
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: 'powder',
		short_name: 'powder',
		description: 'Push to deploy on servers you own.',
		start_url: '/',
		display: 'standalone',
		background_color: WIRE_BG,
		theme_color: WIRE_BG,
		icons: [
			{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
			{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
			// Full bleed, mark inside the 80% safe circle.
			{ src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
		],
	}
}
