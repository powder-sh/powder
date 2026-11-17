// Client-safe: the server settings form sends only the fields the user changed,
// so saving one setting never re-submits (and re-validates) the others.

export interface ServerSettingsForm {
	proxy: string
	tlsMode: string
	baseDomain: string | null
	ingressIp: string | null
	buildHost: string | null
}

export function changedSettings(
	saved: ServerSettingsForm,
	form: { proxy: string; tlsMode: string; baseDomain: string; ingressIp: string; buildHost: string },
): Record<string, string> {
	const out: Record<string, string> = {}
	if (form.proxy !== saved.proxy) out.proxy = form.proxy
	if (form.tlsMode !== saved.tlsMode) out.tlsMode = form.tlsMode
	for (const k of ['baseDomain', 'ingressIp', 'buildHost'] as const) {
		if (form[k].trim() !== (saved[k] ?? '')) out[k] = form[k]
	}
	return out
}
