// the raw include / extends check must not read label or env VALUES as keys
// (powder's own override carries JSON headers and CSP wildcards), while keys stay checked.
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { renderOverride } from '../compose-override'
import { renderComposeYaml } from '../compose-render'
import { COMPOSE_JSON_PATHS_AWK, COMPOSE_RAW_AWK } from '../deploy/fragments'
import { buildTraefikLabels } from '../powder-config'

const raw = (text: string, gen = 0) => {
	const r = spawnSync('awk', ['-v', `gen=${gen}`, COMPOSE_RAW_AWK], { input: text, env: { ...process.env, LC_ALL: 'C' } })
	return { ok: r.status === 0, out: r.stdout.toString() }
}

describe('values are not keys', () => {
	it("powder's override with Report-To / NEL JSON, CSP wildcard:port, redirects and rewrites passes", () => {
		const { middlewareLabels, middlewareChain } = buildTraefikLabels('myapp', {
			rewrites: [{ source: '^/blog/(.*)', destination: '/posts/$${1}' }],
			redirects: [{ from: '^https?://www\\.example\\.com/(.*)', to: 'https://example.com/$${1}', permanent: true }],
			headers: {
				'Report-To': '{"group":"csp","max_age":10886400,"endpoints":[{"url":"https://x.report-uri.com/a"}]}',
				NEL: '{"report_to":"csp","max_age":31536000,"include_subdomains":true}',
				'Content-Security-Policy': "default-src 'self'; img-src * data:; connect-src wss://*.example.com:443 https://*.supabase.co",
				'X-Frame-Options': 'DENY',
			},
		})
		const labels = [
			...middlewareLabels,
			'traefik.http.routers.myapp.rule=Host(`example.com`) || Host(`www.example.com`)',
			`traefik.http.routers.myapp.middlewares=${middlewareChain}`,
		]
		const ov = renderOverride({
			service: 'my-app.web',
			labels,
			ports: {
				'my-app.web': [{ target: 3000, published: '3000', host_ip: '127.0.0.1', protocol: 'tcp' }],
				db: [{ target: 5432, published: '5432', host_ip: '127.0.0.1', mode: 'ingress' }],
			} as never,
		})
		expect(ov).toBeTruthy()
		// the escaped JSON and the wildcard:port really are in the file
		expect(ov).toContain('\\"group\\"')
		expect(ov).toContain('wss://*.example.com:443')
		// powder writes it under its compose state dir, so it runs with gen=1 (its !override tags)
		expect(raw(ov ?? '', 1)).toEqual({ ok: true, out: '' })
	})

	it('a user compose with map-form labels and environment values holding JSON, *.host:port, & and * passes', () => {
		const text = [
			'services:',
			'  app:',
			'    image: a',
			'    labels:',
			`      traefik.http.middlewares.a.headers.customresponseheaders.Report-To: '{"group":"csp","endpoints":[{"url":"https://r.example/a"}]}'`,
			'      traefik.http.middlewares.a.headers.contentSecurityPolicy: "connect-src wss://*.example.com:443"',
			'      "traefik.http.middlewares.b.headers.customresponseheaders.NEL": "{\\"report_to\\":\\"csp\\"}"',
			'      csp.plain: connect-src wss://*.example.com:443 https://*.cdn.example:8443',
			'    environment:',
			'      CONFIG_JSON: "{\\"a\\":1,\\"b\\":\\"x: y\\"}"',
			'      ALLOWED: https://*.example.com:443',
			'      QUERY: a=1&b=*&c=2',
			'      GLOB: "*.example.com:8080"',
			'    healthcheck:',
			'      test:',
			'        - CMD-SHELL',
			'        - "wget -q -O- \\"http://localhost:3000/a\\": || exit 1"',
			'      interval: 30s',
			'',
		].join('\n')
		expect(raw(text)).toEqual({ ok: true, out: '' })
	})

	const stillRefused: Record<string, string> = {
		'extends after a plain value in a flow continuation': 'services:\n  a: {image: x,\n    b: y, extends: {file: ../o.yml, service: app}}\n',
		'extends after a quoted value on the same line': 'services:\n  a: {image: "x", extends: {file: ../o.yml, service: app}}\n',
		'an escaped key after a quoted value': 'services:\n  a: {image: "x", "ext\\u0065nds": {file: ../o.yml}}\n',
		'an alias key after a value': 'services:\n  a: {image: x, *k : {file: ../o.yml}}\n',
		'an explicit key in a sequence item': 'services:\n  a:\n    labels:\n      - ? extends\n',
		'a quoted key with an escape and a quoted value': 'services:\n  a:\n    "ext\\x65nds": "x"\n',
		'a sequence item that is not one complete string': 'services:\n  a:\n    labels:\n      - "x" extends: y\n',
		'extends with a quoted value': 'services:\n  a:\n    extends: "base"\n',
		'a plain value holding ": "': 'services:\n  a: {image: x,\n    b: c: extends: {file: o.yml}}\n',
	}
	for (const [name, text] of Object.entries(stillRefused)) {
		it(`still refuses ${name}`, () => expect(raw(text).ok).toBe(false))
	}
})

describe('the hostile bypass cases stay refused', () => {
	// Probes compose itself rejects as invalid YAML (dqfold, dqfold2, plainfold, extsq)
	// are not listed: they never load.
	const probes: Record<string, string> = {
		anchor: 'x-a: &a {include: [x]}\n<<: *a\nservices: {}\n',
		anchorkey: 'x-k: &k include\n*k : [x]\n',
		complexkey: 'services:\n  a: {? extends : {file: o.yml}}\n',
		flowml: 'services:\n  a: {image: x,\n    extends: {file: o/c.yml, service: app}}\n',
		tagstr: 'services:\n  a:\n    image: x\n    !!str extends: {file: o/c.yml, service: app}\n',
		keyspace: 'include : [x]\n',
		qkey: '"include": [x]\n',
		uesc: '"\\u0069nclude": [x]\n',
		extq: 'services:\n  a:\n    "extends": {file: o.yml, service: app}\n',
		extflow: 'services:\n  a: {extends: {file: o.yml, service: app}}\n',
		plainmultiline: 'services:\n  a:\n    ? ext\n      ends\n    : {file: o.yml}\n',
	}
	for (const [name, text] of Object.entries(probes)) {
		it(`refuses ${name}`, () => expect(raw(text).ok).toBe(false))
	}
})

describe('env-path awk on captured compose config --format json output (layout insurance)', () => {
	// Captured from `docker compose config --no-interpolate --format json` (compose
	// v2.35.1): env_file objects, a label_file list, binds (rw, ro, a file), a named
	// volume, tmpfs, nested bind options at indent 12.
	const captured = `{
  "name": "a",
  "networks": {
    "default": {
      "name": "a_default"
    }
  },
  "services": {
    "app": {
      "env_file": [
        {
          "path": "/opt/apps/a/y.env",
          "required": true
        },
        {
          "path": "/opt/apps//a.env",
          "required": true
        }
      ],
      "image": "app:latest",
      "label_file": [
        "/opt/apps/a/l.env"
      ],
      "networks": {
        "default": null
      },
      "volumes": [
        {
          "bind": {
            "create_host_path": true
          },
          "source": "/opt/apps/a",
          "target": "/app",
          "type": "bind"
        },
        {
          "bind": {
            "create_host_path": true
          },
          "read_only": true,
          "source": "/opt/apps/a/data",
          "target": "/data",
          "type": "bind"
        },
        {
          "source": "/var/run/docker.sock",
          "target": "/s",
          "type": "bind"
        },
        {
          "source": "vol",
          "target": "/v",
          "type": "volume",
          "volume": {}
        },
        {
          "target": "/t",
          "type": "tmpfs"
        }
      ]
    },
    "db": {
      "env_file": [
        {
          "path": "/opt/apps/a.db.env",
          "required": false
        }
      ],
      "image": "postgres:16",
      "networks": {
        "default": null
      }
    }
  },
  "volumes": {
    "vol": {
      "name": "a_vol"
    }
  }
}
`
	it('prints exactly the paths, the project and the writable binds', () => {
		const out = spawnSync('awk', [COMPOSE_JSON_PATHS_AWK], { input: captured }).stdout.toString().split('\n').filter(Boolean)
		expect(out).toEqual([
			'N a',
			'F /opt/apps/a/y.env',
			'F /opt/apps//a.env',
			'F /opt/apps/a/l.env',
			'V /opt/apps/a',
			'V /var/run/docker.sock',
			'F /opt/apps/a.db.env',
		])
	})
})

describe('2: quote and flow state carry across lines', () => {
	// bypass case: a quoted string opened on one line and closed on the next hid a
	// real extends key from the per-line value stripping.
	const h3: Record<string, string> = {
		sq_dq: "services:\n  a: {image: alpine, x-l: 'abc\n    b: \"q', extends: {file: o/c.yml, service: app}, x-c: \"\n    z\"}\n",
		dq_sq: "services:\n  a: {image: alpine, x-l: \"abc\n    b: 'q\", extends: {file: o/c.yml, service: app}, x-c: '\n    z'}\n",
		seq_sq: "services:\n  a: {image: alpine, x-l: ['abc\n    - \"q', extends: {file: o/c.yml, service: app}, x-c: \"\n    z\"]}\n",
		sq_dq_esc: "services:\n  a: {image: alpine, x-l: 'abc\n    b: \"q', \"ext\\u0065nds\": {file: o/c.yml, service: app}, x-c: \"\n    z\"}\n",
		root_inc: "x-a: 'abc\n  b: \"q'\ninclude: [o/c.yml]\n",
		plain_hide: 'services:\n  a: {image: alpine, x-l: abc\n    b: q extends: {file: o/c.yml, service: app}}\n',
		dqfold: 'services:\n  a: {image: x, "ext\\\n  ends": {file: o/c.yml, service: app}}\n',
		sqfold: "x-a: 'a\n  b'\nservices: {}\n",
	}
	for (const [name, text] of Object.entries(h3)) {
		it(`refuses ${name}`, () => expect(raw(text).ok).toBe(false))
	}
	it('names a quoted string that spans lines', () => {
		expect(raw(h3.sq_dq ?? '').out).toContain('line 2: a quoted string spanning lines is not supported')
	})
	it('a flow value continued on the next line gets no value stripping', () => {
		// "x" alone would be stripped as a value on its own line; inside an open flow it is not.
		expect(raw('services:\n  a: {image: x,\n    b: "\\u0065", extends: {file: o.yml}}\n').ok).toBe(false)
	})
	it('refuses what passed before single-line YAML: block scalars and a flow value over two lines', () => {
		expect(raw('services:\n  a:\n    command: |\n      echo hi\n').out).toContain('a block scalar is not supported')
		expect(raw('services:\n  a:\n    environment: {a: "x", b: [1, 2,\n      3]}\n').out).toContain('a flow collection spanning lines is not supported')
	})
	it("powder's /new compose (renderComposeYaml, every option) passes", () => {
		const yaml = renderComposeYaml({
			name: 'blog',
			dockerfilePath: './Dockerfile',
			hostPort: 3100,
			containerPort: 3000,
			envFilePath: '/opt/apps/blog.env',
			publicHost: 'blog.apps.example.com',
			healthUrl: 'https://blog.apps.example.com/api/health',
			traefik: true,
			postgres: { password: 'p4ss', dataDir: '/opt/apps/blog/pgdata' },
			kv: { dataDir: '/opt/apps/blog/kv' },
			sharedInternal: true,
		})
		expect(raw(yaml)).toEqual({ ok: true, out: '' })
	})
})
