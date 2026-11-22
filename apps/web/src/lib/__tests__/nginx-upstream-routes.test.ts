// nginx discovery resolves `proxy_pass http://<upstream>` through the upstream block,
// so apps behind the zero-downtime bridge layout (a named upstream with the app port
// and a backup bridge port) get their URLs, and the direct forms are unchanged.
import { describe, expect, it } from 'vitest'
import { parseHostMaps, parseNginxRoutes, parseNginxUpstreams } from '../ssh/discovery'
import {
	CONF_D_HOST_MAP,
	MAP_ROUTES,
	MAPPED_APPS_VHOST,
	PORT_MAP_VHOST,
	hostNginxDumpWithConfD,
} from './fixtures/nginx-vhosts'

const BRIDGE_VHOST = `
upstream shop_app {
    server 127.0.0.1:3017 max_fails=0;
    # powder zero-downtime bridge (label powder.bridge.host-port=13017), only up during a deploy swap
    server 127.0.0.1:13017 backup;
}
server {
    listen 80;
    listen 443 ssl;
    ssl_certificate /etc/ssl/shop.pem;
    server_name shop.example.com;
    location /assets/ { proxy_pass http://shop_app; proxy_next_upstream error timeout; }
    location / { proxy_pass http://shop_app; proxy_next_upstream error timeout; }
}
server {
    listen 443 ssl;
    server_name www.shop.example.com;
    return 301 https://shop.example.com$request_uri;
}
`

const sorted = (r: ReturnType<typeof parseNginxRoutes>) =>
	[...r].sort((a, b) => `${a.host}|${a.port}`.localeCompare(`${b.host}|${b.port}`))

describe('named upstreams', () => {
	it('the bridge layout routes the hostname to the primary port only, never the backup', () => {
		expect(parseNginxRoutes(BRIDGE_VHOST)).toEqual([
			{ host: '127.0.0.1', port: 3017, urls: ['https://shop.example.com'] },
		])
	})

	it('the www redirect block (no proxy_pass) gives no route and no URL', () => {
		const urls = parseNginxRoutes(BRIDGE_VHOST).flatMap((r) => r.urls)
		expect(urls).not.toContain('https://www.shop.example.com')
	})

	it('an upstream with a single server', () => {
		const conf = `upstream demo { server 127.0.0.1:3020; }
server { listen 80; server_name demo.example.com; location / { proxy_pass http://demo; } }`
		expect(parseNginxRoutes(conf)).toEqual([{ host: '127.0.0.1', port: 3020, urls: ['http://demo.example.com'] }])
	})

	it('an upstream defined after the server block that uses it', () => {
		const conf = `server { listen 443 ssl; server_name late.example.com; location / { proxy_pass http://late_up; } }
upstream late_up { server 127.0.0.1:3030; }`
		expect(parseNginxRoutes(conf)).toEqual([{ host: '127.0.0.1', port: 3030, urls: ['https://late.example.com'] }])
	})

	it('several servers, parameters after the address, a down entry and a proxy_pass with a URI part', () => {
		const conf = `upstream pool {
  server 127.0.0.1:3041 weight=3 max_fails=0;
  server web-b:3000 max_fails=2 fail_timeout=5s;
  server 127.0.0.1:3043 down;
  server 127.0.0.1:3044 backup;
}
server { listen 80; server_name pool.example.com; location /api/ { proxy_pass http://pool/api/; } }`
		expect(sorted(parseNginxRoutes(conf))).toEqual([
			{ host: '127.0.0.1', port: 3041, urls: ['http://pool.example.com'] },
			{ host: 'web-b', port: 3000, urls: ['http://pool.example.com'] },
		])
	})

	it('an unknown upstream name stays a DNS name; a unix socket upstream gives no route', () => {
		const conf = `upstream sock { server unix:/run/app.sock; }
server { listen 80; server_name sock.example.com; location / { proxy_pass http://sock; } }
server { listen 80; server_name other.example.com; location / { proxy_pass http://nosuch_up; } }`
		// nosuch_up is no upstream: it is kept as a host name, which only matches a container
		// or compose service of that exact name (server-list.ts), never a port
		expect(parseNginxRoutes(conf)).toEqual([{ host: 'nosuch_up', port: null, urls: ['http://other.example.com'] }])
	})

	it('an upstream wins over a docker DNS name of the same name, as in nginx', () => {
		const conf = `upstream shop { server 127.0.0.1:3050; }
server { listen 80; server_name s.example.com; location / { proxy_pass http://shop; } }`
		expect(parseNginxRoutes(conf)).toEqual([{ host: '127.0.0.1', port: 3050, urls: ['http://s.example.com'] }])
	})

	it('a proxy_pass with a port is never resolved through an upstream (nginx refuses that)', () => {
		const conf = `upstream shop { server 127.0.0.1:3050; }
server { listen 80; server_name s.example.com; location / { proxy_pass http://shop:3000; } }`
		expect(parseNginxRoutes(conf)).toEqual([{ host: 'shop', port: 3000, urls: ['http://s.example.com'] }])
	})

	it('upstream names match case-insensitively', () => {
		const conf = `upstream Shop_App { server 127.0.0.1:3060; }
server { listen 80; server_name c.example.com; location / { proxy_pass http://shop_app; } }`
		expect(parseNginxRoutes(conf)).toEqual([{ host: '127.0.0.1', port: 3060, urls: ['http://c.example.com'] }])
	})

	it('a set $var to an upstream name resolves too', () => {
		const conf = `upstream v_up { server 127.0.0.1:3070; }
server { listen 80; server_name v.example.com; set $u "http://v_up"; location / { proxy_pass $u; } }`
		expect(parseNginxRoutes(conf)).toEqual([{ host: '127.0.0.1', port: 3070, urls: ['http://v.example.com'] }])
	})

	it('the same name twice: identical definitions resolve, conflicting ones give no route', () => {
		const one = 'upstream dup { server 127.0.0.1:3080; }\n'
		const use = 'server { listen 80; server_name d.example.com; location / { proxy_pass http://dup; } }\n'
		expect(parseNginxRoutes(one + use + one)).toEqual([{ host: '127.0.0.1', port: 3080, urls: ['http://d.example.com'] }])
		expect(parseNginxRoutes(`${one}${use}upstream dup { server 127.0.0.1:3081; }\n`)).toEqual([])
		expect(parseNginxUpstreams(`${one}upstream dup { server 127.0.0.1:3081; }`).get('dup')).toBeNull()
	})

	it('a commented-out upstream or entry does not count', () => {
		const conf = `# upstream gone { server 127.0.0.1:3090; }
upstream half {
  # server 127.0.0.1:3091;
  server 127.0.0.1:3092;
}
server { listen 80; server_name h.example.com; location / { proxy_pass http://half; } }
server { listen 80; server_name g.example.com; location / { proxy_pass http://gone; } }`
		expect(sorted(parseNginxRoutes(conf))).toEqual([
			{ host: '127.0.0.1', port: 3092, urls: ['http://h.example.com'] },
			{ host: 'gone', port: null, urls: ['http://g.example.com'] },
		])
	})
})

describe('upstreams stay inside one nginx instance', () => {
	it('containerized nginx -T output with an upstream', () => {
		const out = `## CONTAINER:edge-nginx ##
# configuration file /etc/nginx/nginx.conf:
http {
    # configuration file /etc/nginx/conf.d/blog.conf:
    upstream blog_up {
        server blog:3000 max_fails=0;
    }
    server {
        listen 443 ssl;
        server_name blog.example.com;
        location / { proxy_pass http://blog_up; }
    }
}
`
		expect(parseNginxRoutes(out)).toEqual([{ host: 'blog', port: 3000, urls: ['https://blog.example.com'] }])
	})

	it("a host vhost never resolves through a container's upstream, nor the other way round", () => {
		const out = `server { listen 80; server_name host.example.com; location / { proxy_pass http://shared; } }
## CONTAINER:edge-nginx ##
http { upstream shared { server 127.0.0.1:3100; } }
## CONTAINER:other-proxy ##
http { server { listen 80; server_name c2.example.com; location / { proxy_pass http://shared; } } }
`
		expect(sorted(parseNginxRoutes(out))).toEqual([
			{ host: 'shared', port: null, urls: ['http://c2.example.com', 'http://host.example.com'] },
		])
	})
})

describe('direct forms are unchanged', () => {
	it('proxy_pass host:port, a DNS name, both set $var forms, wildcards and default names', () => {
		const conf = `server {
  listen 443 ssl;
  server_name app.example.com www.app.example.com;
  location / { proxy_pass http://127.0.0.1:3006; }
}
server {
  listen 80;
  server_name _ localhost;
  location / { proxy_pass http://127.0.0.1:3007; }
}
server {
  listen 80;
  server_name *.tenant.example.com;
  location / { proxy_pass http://tenant:3000/; }
}
server {
  listen 80;
  server_name a.example.com;
  set $up "http://alpha:4000";
  location / { proxy_pass $up; }
}
server {
  listen 80;
  ssl_certificate /x.pem;
  server_name b.example.com;
  set $hp "beta:5000";
  location / { proxy_pass https://$hp; }
}
server { listen 80; location / { proxy_pass http://127.0.0.1:3999; } }
`
		expect(parseNginxRoutes(conf)).toEqual([
			{ host: '127.0.0.1', port: 3006, urls: ['https://app.example.com', 'https://www.app.example.com'] },
			{ host: '127.0.0.1', port: 3007, urls: [] },
			{ host: 'tenant', port: 3000, urls: ['http://*.tenant.example.com'] },
			{ host: 'alpha', port: 4000, urls: ['http://a.example.com'] },
			{ host: 'beta', port: 5000, urls: ['https://b.example.com'] },
		])
	})

	it('getNginxRoutes parses with parseNginxRoutes', async () => {
		const { readFileSync } = await import('node:fs')
		const { join } = await import('node:path')
		const src = readFileSync(join(__dirname, '../ssh/discovery.ts'), 'utf8')
		expect(src).toContain('const routes: NginxRoutes = parseNginxRoutes(stdout)')
	})
})

describe('map $host variables', () => {
	const sortRoutes = (r: ReturnType<typeof parseNginxRoutes>) =>
		[...r].sort((a, b) => `${a.host}|${a.port ?? ''}`.localeCompare(`${b.host}|${b.port ?? ''}`))

	it('a map in conf.d routes each server_name to its own value only (also through an upstream)', () => {
		const routes = sortRoutes(parseNginxRoutes(hostNginxDumpWithConfD()))
		for (const r of MAP_ROUTES) expect(routes).toContainEqual(r)
		const urls = routes.flatMap((r) => r.urls)
		// in the map but not in any server_name, or in server_name but not in the map: no URL
		expect(urls).not.toContain('https://orphan.example.com')
		expect(urls).not.toContain('https://unmapped.example.com')
		// default, regex keys and the backup bridge port never become a route
		for (const port of [3999, 3199, 13104]) expect(routes.map((r) => r.port)).not.toContain(port)
	})

	it('only maps keyed on $host or $http_host count; default, regex and wildcard keys are skipped', () => {
		const maps = parseHostMaps(`${CONF_D_HOST_MAP}
map $remote_addr $by_ip { 10.0.0.1 127.0.0.1:1; }
map $host $w { *.wild.example.com 127.0.0.1:2; .dot.example.com 127.0.0.1:3; x.example.com $other; }`)
		expect([...maps.keys()]).toEqual(['app_backend', 'w'])
		expect(Object.fromEntries(maps.get('app_backend') ?? [])).toEqual({
			'alpha.example.com': '127.0.0.1:3101',
			'beta.example.com': '127.0.0.1:3102',
			'gamma.example.com': 'gamma_up',
			'orphan.example.com': '127.0.0.1:3103',
		})
		expect(maps.get('w')?.size).toBe(0)
	})

	it('proxy_pass $var with a scheme in the value, and the port-map shape', () => {
		const conf = `map $host $u { a.example.com http://web-a:3000; b.example.com "https://127.0.0.1:3302/"; }
server { listen 80; server_name a.example.com b.example.com; location / { proxy_pass $u; } }`
		expect(sortRoutes(parseNginxRoutes(conf))).toEqual([
			{ host: '127.0.0.1', port: 3302, urls: ['http://b.example.com'] },
			{ host: 'web-a', port: 3000, urls: ['http://a.example.com'] },
		])
		expect(sortRoutes(parseNginxRoutes(PORT_MAP_VHOST))).toEqual([
			// the direct reader's portless route, unchanged (matches no container)
			{ host: '127.0.0.1', port: null, urls: ['https://desk.example.com', 'https://orders.example.com'] },
			{ host: '127.0.0.1', port: 3201, urls: ['https://orders.example.com'] },
			{ host: '127.0.0.1', port: 3202, urls: ['https://desk.example.com'] },
		])
	})

	it('a map never crosses from one nginx instance to another, and a conflicting duplicate gives nothing', () => {
		const out = `${MAPPED_APPS_VHOST}\n## CONTAINER:edge-nginx ##\n${CONF_D_HOST_MAP}`
		expect(parseNginxRoutes(out)).toEqual([])
		const dup = `map $host $v { a.example.com 127.0.0.1:1; }
map $host $v { a.example.com 127.0.0.1:2; }
server { listen 80; server_name a.example.com; location / { proxy_pass http://$v; } }`
		expect(parseNginxRoutes(dup)).toEqual([])
	})
})
