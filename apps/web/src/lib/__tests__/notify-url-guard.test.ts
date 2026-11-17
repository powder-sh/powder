import { describe, expect, it } from 'vitest'
import { CLOUD_METADATA_ADDRESSES, appTargetBlocked, checkWebhookUrl, cronTargetBlocked } from '../notify-url-guard'

const publicIp = async () => ['93.184.216.34']

describe('notification webhook URL guard', () => {
	it('accepts http(s) URLs that resolve to a public or private-network address', async () => {
		expect((await checkWebhookUrl('https://discord.com/api/webhooks/1/x', publicIp)).ok).toBe(true)
		expect((await checkWebhookUrl('http://hook.internal/x', async () => ['10.20.30.40'])).ok).toBe(
			true,
		)
	})
	it('rejects other schemes, credentials and junk', async () => {
		for (const u of [
			'ftp://h.test/x',
			'file:///etc/passwd',
			'javascript:alert(1)',
			'not a url',
			'https://u:p@h.test/',
		]) {
			expect((await checkWebhookUrl(u, publicIp)).ok).toBe(false)
		}
	})
	it('rejects loopback, link-local and metadata targets', async () => {
		expect((await checkWebhookUrl('http://localhost:3000/x', publicIp)).ok).toBe(false)
		expect((await checkWebhookUrl('http://127.0.0.1/x')).ok).toBe(false)
		expect((await checkWebhookUrl('http://169.254.169.254/latest/meta-data')).ok).toBe(false)
		expect((await checkWebhookUrl('http://[::1]/x')).ok).toBe(false)
		expect((await checkWebhookUrl('http://[::ffff:127.0.0.1]/x')).ok).toBe(false)
		expect(
			(await checkWebhookUrl('https://rebind.test/x', async () => ['93.184.216.34', '127.0.0.1']))
				.ok,
		).toBe(false)
	})
	it('allows 100.64/10 (private overlay networks) but not the cloud metadata address in it', async () => {
		// built from octets: the export's address guard refuses CGNAT dotted quads
		const overlay = [100, 101, 102, 103].join('.')
		expect((await checkWebhookUrl('http://hook.test/x', async () => [overlay])).ok).toBe(true)
		expect(appTargetBlocked(overlay)).toBe(false)
		for (const ip of ['100.100.100.200', '::ffff:100.100.100.200', '::ffff:6464:64c8']) {
			expect(appTargetBlocked(ip), ip).toBe(true)
			expect(cronTargetBlocked(ip), ip).toBe(true)
		}
		expect((await checkWebhookUrl('http://100.100.100.200/latest/meta-data')).ok).toBe(false)
		expect((await checkWebhookUrl('http://meta.test/x', async () => ['100.100.100.200'])).ok).toBe(false)
	})
	it('refuses the IPv6 cloud metadata address in any spelling, for webhooks, uptime and crons', async () => {
		for (const ip of ['fd00:ec2::254', 'FD00:EC2::254', 'fd00:ec2:0:0:0:0:0:254', 'fd00:0ec2:0000::0254']) {
			expect((await checkWebhookUrl('http://meta.test/x', async () => [ip])).ok, ip).toBe(false)
			expect(appTargetBlocked(ip), ip).toBe(true)
			expect(cronTargetBlocked(ip), ip).toBe(true)
		}
		expect((await checkWebhookUrl('http://[fd00:ec2::254]/latest/meta-data')).ok).toBe(false)
		// a webhook may still target other unique-local addresses (private receivers)
		expect((await checkWebhookUrl('http://hook.test/x', async () => ['fd00:ec2::253'])).ok).toBe(true)
		expect(CLOUD_METADATA_ADDRESSES).toEqual(['100.100.100.200', 'fd00:ec2::254'])
	})
	it('rejects a host that does not resolve', async () => {
		expect((await checkWebhookUrl('https://nx.test/x', async () => [])).ok).toBe(false)
		expect(
			(
				await checkWebhookUrl('https://nx.test/x', async () => {
					throw new Error('ENOTFOUND')
				})
			).ok,
		).toBe(false)
	})
})
