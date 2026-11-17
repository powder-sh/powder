// The one rule for how a Traefik router gets its certificate, from the server's
// servers.tls_mode. acme: Traefik issues via HTTP-01 (resolver le).
// origin-cert: no resolver, the router serves the default-store cert (the
// Cloudflare origin cert), so tls=true. Every router powder writes (compose
// labels for apps, previews, snapshots; file-provider redirects) goes through
// here so the forms cannot drift. Pure: no DB, safe to import anywhere.

export type TraefikTlsMode = 'acme' | 'origin-cert'

/** The router TLS label without the leading "- ", e.g. traefik.http.routers.x.tls=true */
export function traefikRouterTlsLabel(router: string, tlsMode?: TraefikTlsMode | null): string {
	return tlsMode === 'origin-cert'
		? `traefik.http.routers.${router}.tls=true`
		: `traefik.http.routers.${router}.tls.certresolver=le`
}

/** The `tls:` value of a file-provider router (YAML flow form). */
export function traefikFileRouterTls(tlsMode?: TraefikTlsMode | null): string {
	return tlsMode === 'origin-cert' ? '{}' : '{ certResolver: le }'
}
