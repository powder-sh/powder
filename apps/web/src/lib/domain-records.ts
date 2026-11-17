// The DNS records a custom domain still needs, as rows the domains tab can
// show with a copy button each. Pure: no DNS, no DB, safe in the browser.
//
// Ownership: a TXT at _powder.<host> holding the row's challenge (the verify
// route accepts it there). Routing: a subdomain CNAMEs to the app's default
// host when the server has a base domain; otherwise (and for an apex, which
// cannot hold a CNAME) an A record to the server's public IP.

export interface DnsRecord {
	purpose: 'ownership' | 'routing'
	type: 'TXT' | 'CNAME' | 'A'
	name: string
	value: string
}

export interface DomainRecordInput {
	hostname: string
	status: string
	verifyChallenge: string | null
	/** The app's default host on a Traefik server with a base domain. */
	autoAssigned: string | null
	/** The server's public IPv4 (servers.ingress_ip), when set. */
	ingressIp: string | null
}

// Statuses whose DNS is not proven yet: show what to create.
export function needsDnsRecords(status: string): boolean {
	return status !== 'live' && status !== 'verified' && status !== 'apply_failed'
}

// Two labels (example.com) is an apex. Multi-part public suffixes are rare
// enough here that the A record fallback is the safe answer for them too.
export function isApex(hostname: string): boolean {
	return hostname.split('.').filter(Boolean).length <= 2
}

export function domainRecords(d: DomainRecordInput): {
	records: DnsRecord[]
	/** Set when the routing record cannot be named yet. */
	routingMissing: string | null
} {
	const records: DnsRecord[] = []
	if (!needsDnsRecords(d.status)) return { records, routingMissing: null }
	if (d.verifyChallenge)
		records.push({
			purpose: 'ownership',
			type: 'TXT',
			name: `_powder.${d.hostname}`,
			value: d.verifyChallenge,
		})
	if (d.autoAssigned && !isApex(d.hostname)) {
		records.push({ purpose: 'routing', type: 'CNAME', name: d.hostname, value: d.autoAssigned })
		return { records, routingMissing: null }
	}
	if (d.ingressIp) {
		records.push({ purpose: 'routing', type: 'A', name: d.hostname, value: d.ingressIp })
		return { records, routingMissing: null }
	}
	return {
		records,
		routingMissing: d.autoAssigned
			? `an A record for ${d.hostname} to the IP that ${d.autoAssigned} resolves to`
			: `an A record for ${d.hostname} to the server's public IP (set it on the server page)`,
	}
}
