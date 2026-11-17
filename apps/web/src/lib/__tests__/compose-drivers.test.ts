// named-volume driver / driver_opts allow-list, network driver / driver_opts.
import { describe, expect, it } from 'vitest'
import { composeViolations, isHighSeverity } from '../compose-safety'

const ctx = { appName: 'shop', resolved: true }
const codes = (top: Record<string, unknown>) =>
	composeViolations({ name: 'shop', services: { shop: { image: 'shop-web:1' } }, ...top }, ctx).map(
		(v) => v.code,
	)
const vol = (d: unknown) => codes({ volumes: { v: { name: 'shop_v', ...(d as object) } } })

describe('volume driver allow-list', () => {
	it('passes the common shape (no driver, no driver_opts) and an explicit local driver', () => {
		expect(vol({})).toEqual([])
		expect(vol({ driver: 'local' })).toEqual([])
		expect(vol({ driver: 'local', driver_opts: {} })).toEqual([])
	})
	it('passes a tmpfs volume and an app-folder bind', () => {
		expect(
			vol({ driver_opts: { type: 'tmpfs', device: 'tmpfs', o: 'size=100m,uid=1000,mode=1777' } }),
		).toEqual([])
		expect(
			vol({
				driver: 'local',
				driver_opts: { type: 'none', o: 'bind', device: '/opt/apps/shop/data' },
			}),
		).toEqual([])
		expect(
			vol({ driver_opts: { type: 'none', o: 'rbind,ro', device: '/opt/apps/shop-uploads/x' } }),
		).toEqual([])
	})
	it('refuses another driver', () => {
		expect(vol({ driver: 'rclone' })).toEqual(['volume_driver'])
	})
	it('refuses overlay and paths in o', () => {
		expect(
			vol({
				driver_opts: {
					type: 'overlay',
					device: 'overlay',
					o: 'lowerdir=/,upperdir=/tmp/u,workdir=/tmp/w',
				},
			}),
		).toEqual(['volume_driver'])
		expect(
			vol({ driver_opts: { type: 'none', o: 'bind,lowerdir=/', device: '/opt/apps/shop/d' } }),
		).toEqual(['volume_driver'])
		expect(vol({ driver_opts: { type: 'tmpfs', device: 'tmpfs', o: 'size=1m,x=/etc' } })).toEqual([
			'volume_driver',
		])
	})
	it('refuses a relative, dotted or foreign bind device, and other keys', () => {
		expect(vol({ driver_opts: { type: 'none', o: 'bind', device: 'data' } })).toEqual([
			'volume_driver',
		])
		expect(
			vol({ driver_opts: { type: 'none', o: 'bind', device: '/opt/apps/shop/../other' } }),
		).toEqual(['volume_driver'])
		expect(vol({ driver_opts: { type: 'none', o: 'bind', device: '/etc' } })).toEqual(['bind'])
		expect(vol({ driver_opts: { type: 'none', o: 'bind', device: '/opt/apps/shopx/d' } })).toEqual([
			'bind',
		])
		expect(vol({ driver_opts: { type: 'none', o: 'bind', device: '/opt/apps/shop-' } })).toEqual([
			'bind',
		])
		expect(
			vol({ driver_opts: { type: 'none', o: 'bind', device: '/opt/apps/shop/d', foo: 'x' } }),
		).toEqual(['volume_driver'])
		expect(vol({ driver_opts: { type: 'nfs', o: 'addr=10.0.0.1', device: ':/x' } })).toEqual([
			'volume_driver',
		])
		expect(
			vol({ driver_opts: { type: 'none', o: 'bind,uid=1', device: '/opt/apps/shop/d' } }),
		).toEqual(['volume_driver'])
	})
	it('the findings are high severity', () => {
		expect(isHighSeverity({ code: 'volume_driver', message: '' })).toBe(true)
		expect(isHighSeverity({ code: 'network_driver', message: '' })).toBe(true)
	})
})

describe('network driver', () => {
	const net = (d: unknown) => codes({ networks: { n: { name: 'shop_n', ...(d as object) } } })
	it('passes no driver and bridge', () => {
		expect(net({})).toEqual([])
		expect(net({ driver: 'bridge' })).toEqual([])
		expect(net({ external: true, name: 'web' })).toEqual([])
	})
	it('refuses macvlan / ipvlan and any driver_opts', () => {
		expect(net({ driver: 'macvlan', driver_opts: { parent: 'eth0' } })).toEqual([
			'network_driver',
			'network_driver',
		])
		expect(net({ driver: 'ipvlan' })).toEqual(['network_driver'])
		expect(net({ driver_opts: { 'com.docker.network.bridge.name': 'docker0' } })).toEqual([
			'network_driver',
		])
	})
})

describe('a bind device follows the service bind rules', () => {
	const dev = (device: string, otherApps: string[] = [], extra: Record<string, unknown> = {}) =>
		composeViolations(
			{
				name: 'shop',
				services: { shop: { image: 'shop-web:1', ...extra } },
				volumes: { v: { name: 'shop_v', driver_opts: { type: 'none', o: 'bind', device } } },
			},
			{
				appName: 'shop',
				resolved: true,
				otherApps,
				protectedPaths: ['/opt/apps/shop/.deploy-key', '/opt/apps/shop/docker-compose.yml'],
			},
		).map((v) => v.code)
	it('refuses the app dir itself and folders holding protected files', () => {
		expect(dev('/opt/apps/shop')).toEqual(['bind'])
		expect(dev('/opt/apps/shop/')).toEqual(['bind'])
	})
	it('refuses another registered app dir or env file, even when it starts with the app name', () => {
		expect(dev('/opt/apps/shop-api', ['shop-api'])).toEqual(['bind'])
		expect(dev('/opt/apps/shop-api/src', ['shop-api'])).toEqual(['bind'])
		expect(dev('/opt/apps/shop-api-files', ['shop-api'])).toEqual(['bind'])
		expect(dev('/opt/apps/shop-x.env')).toEqual(['bind'])
		expect(dev('/opt/apps/shop.env')).toEqual(['bind'])
	})
	it('passes own folders, also next to a shorter registered app', () => {
		expect(dev('/opt/apps/shop-uploads', ['shop-api', 'web'])).toEqual([])
		expect(dev('/opt/apps/shop/data', ['shop-api'])).toEqual([])
	})
	it('refuses a folder holding an env file of the compose', () => {
		// the env file sits in a folder a container can write (the device is in the
		// writable set), so the env_file rule refuses it too
		expect(dev('/opt/apps/shop/conf', [], { env_file: ['/opt/apps/shop/conf/app.env'] })).toEqual([
			'env_file',
			'bind',
		])
	})
})
