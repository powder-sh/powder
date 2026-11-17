import type { Viewport } from 'next'

/** Public GitHub repo (the exported mirror). Single source for every GitHub link on the site. */
export const PUBLIC_REPO_URL = 'https://github.com/powder-sh/powder'
/** The powder project's own site: project links (its docs) and the last fallback of
 *  siteUrl() in lib/hosts.ts. This install's own public URL is siteUrl(), not this. */
export const SITE_URL = 'https://powder.sh'

/** Live wire page color: the public site, docs, login, OG cards and app icons. */
export const WIRE_BG = '#05070c'

/** The public site, docs and login are dark only (globals.css .theme-wire). */
export const WIRE_VIEWPORT: Viewport = { themeColor: WIRE_BG, colorScheme: 'dark' }
