// Response security headers for every route (next.config.ts headers()). Pure
// constants, imported by next.config.ts and the guard test.

/** No full CSP (inline scripts from Next + PostHog would need a nonce pipeline);
 *  these directives need none: no framing, no plugins, no <base> hijack, forms
 *  submit to this origin only. */
export const CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"

/** Powerful features the dashboard never uses. Clipboard writes (copy buttons)
 *  stay allowed for this origin by default. */
export const PERMISSIONS_POLICY =
	'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()'
