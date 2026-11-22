// Host nginx vhost files in the shapes found on nginx servers (invented names).
// Most are the zero-downtime bridge layout: a named upstream with the app's loopback
// port as the primary and the bridge port (app port + 10000) as `backup`, used by
// `proxy_pass http://<upstream>`, plus a www redirect block in the same file.
// Shared by the discovery tests and the awk/TypeScript upstream parity test.

/** The bridge layout as the deploy-time checks expect it (NGINX_BRIDGE_AWK). */
export const SHOP_BRIDGE_VHOST = `upstream shop_app {
    server 127.0.0.1:3017 max_fails=0;
    # powder zero-downtime bridge (label powder.bridge.host-port=13017), only up during a deploy swap
    server 127.0.0.1:13017 backup;
}
server {
    listen 80;
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/shop.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem;
    server_name shop.example.com;
    location /assets/ {
        proxy_pass http://shop_app;
        proxy_next_upstream error timeout;
        expires 30d;
    }
    location / {
        proxy_pass http://shop_app;
        proxy_next_upstream error timeout;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
server {
    listen 80;
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/shop.example.com/fullchain.pem;
    server_name www.shop.example.com;
    return 301 https://shop.example.com$request_uri;
}
`

/** Tabs, an inline comment after an entry, and a second vhost (another file) on the
 *  same upstream. */
export const BLOG_BRIDGE_VHOST = `upstream blog_app {
\tserver 127.0.0.1:3001 max_fails=0;   # app
\tserver 127.0.0.1:13001 backup;   # bridge
}
server {
\tlisten 443 ssl http2;
\tserver_name blog.example.com;
\tlocation / { proxy_pass http://blog_app; proxy_next_upstream error timeout; }
}
`
export const BLOG_STATS_VHOST = `server {
\tlisten 443 ssl;
\tserver_name stats.blog.example.com;
\tlocation / { proxy_pass http://blog_app/stats/; }
}
`

/** A bridge layout whose primary lacks max_fails=0 (the per-server scan flags it). */
export const API_BRIDGE_VHOST_NO_MAXFAILS = `upstream demo_api {
    server 127.0.0.1:3022;
    server 127.0.0.1:13022 backup;
}
server {
    listen 443 ssl;
    server_name api.demo.example.com;
    location / { proxy_pass http://demo_api; }
}
`

/** The older direct form, still on some servers. */
export const LEGACY_DIRECT_VHOST = `server {
    listen 443 ssl;
    server_name legacy.example.com www.legacy.example.com;
    location / { proxy_pass http://127.0.0.1:3005; }
}
`

/** The host files in sites-enabled, by file name. */
export const HOST_VHOST_FILES: Record<string, string> = {
	'shop.example.com': SHOP_BRIDGE_VHOST,
	'blog.example.com': BLOG_BRIDGE_VHOST,
	'stats.blog.example.com': BLOG_STATS_VHOST,
	'api.demo.example.com': API_BRIDGE_VHOST_NO_MAXFAILS,
	'legacy.example.com': LEGACY_DIRECT_VHOST,
}

/** What `nginx -T` prints for those files on the host (the deploy-time checks read this). */
export function hostNginxDump(): string {
	return [
		'# configuration file /etc/nginx/nginx.conf:',
		'user www-data;',
		'http {',
		`\tlog_format main '$remote_addr $upstream_addr "#x" $upstream_response_time';`,
		'\tinclude /etc/nginx/sites-enabled/*;',
		'}',
		...Object.entries(HOST_VHOST_FILES).map(([f, body]) => `# configuration file /etc/nginx/sites-enabled/${f}:\n${body}`),
	].join('\n')
}

/** The routes discovery must find in those files: primaries only, never a bridge port,
 *  and nothing for the www redirect block. */
export const HOST_VHOST_ROUTES = [
	{ host: '127.0.0.1', port: 3001, urls: ['https://blog.example.com', 'https://stats.blog.example.com'] },
	{ host: '127.0.0.1', port: 3005, urls: ['https://legacy.example.com', 'https://www.legacy.example.com'] },
	{ host: '127.0.0.1', port: 3017, urls: ['https://shop.example.com'] },
	{ host: '127.0.0.1', port: 3022, urls: ['https://api.demo.example.com'] },
]

/** A proxy container's `nginx -T` with an upstream on a docker DNS name. */
export const CONTAINER_NGINX_T = `# configuration file /etc/nginx/nginx.conf:
http {
    include /etc/nginx/conf.d/*.conf;
# configuration file /etc/nginx/conf.d/notes.conf:
upstream notes_up {
    server notes-web:3000 max_fails=0;
}
server {
    listen 443 ssl;
    server_name notes.example.com;
    location / { proxy_pass http://notes_up; }
}
}
`

/** One vhost file routing several apps through a `map $host` defined in conf.d. */
export const CONF_D_HOST_MAP = `map $host $app_backend {
    default        127.0.0.1:3999;
    hostnames;
    alpha.example.com   127.0.0.1:3101;
    beta.example.com    127.0.0.1:3102;
    gamma.example.com   gamma_up;
    ~^preview-.*$       127.0.0.1:3199;
    orphan.example.com  127.0.0.1:3103;
}
upstream gamma_up {
    server 127.0.0.1:3104 max_fails=0;
    server 127.0.0.1:13104 backup;
}
map $http_user_agent $is_bot { default 0; ~bot 1; }
`
export const MAPPED_APPS_VHOST = `server {
    listen 443 ssl;
    server_name alpha.example.com beta.example.com gamma.example.com unmapped.example.com;
    location / { proxy_pass http://$app_backend; proxy_set_header Host $host; }
}
`

/** The port-map shape: a fixed host with the port from a map. */
export const PORT_MAP_VHOST = `map $http_host $app_port {
    default 3000;
    orders.example.com 3201;
    desk.example.com 3202;
}
server {
    listen 443 ssl;
    server_name orders.example.com desk.example.com;
    location / { proxy_pass http://127.0.0.1:$app_port; }
}
`

/** The routes the map fixtures must give (on top of the direct proxy_pass of
 *  127.0.0.1:$app_port, which as before yields a portless route that matches nothing). */
export const MAP_ROUTES = [
	{ host: '127.0.0.1', port: 3101, urls: ['https://alpha.example.com'] },
	{ host: '127.0.0.1', port: 3102, urls: ['https://beta.example.com'] },
	{ host: '127.0.0.1', port: 3104, urls: ['https://gamma.example.com'] },
	{ host: '127.0.0.1', port: 3201, urls: ['https://orders.example.com'] },
	{ host: '127.0.0.1', port: 3202, urls: ['https://desk.example.com'] },
]

/** A host `nginx -T` with conf.d and sites-enabled. With `appSpaceFile`, it also
 *  includes that file (a path under app space) whose content spoofs a header line and
 *  claims a hostname: discovery must then read nothing of the host config. `root`
 *  stands for /etc/nginx (tests point it at a temp dir, since the headers must name
 *  files that exist). */
export function hostNginxDumpWithConfD(appSpaceFile?: string, root = '/etc/nginx'): string {
	return [
		`# configuration file ${root}/nginx.conf:`,
		'http {',
		`\tinclude ${root}/conf.d/*.conf;`,
		`\tinclude ${root}/sites-enabled/*;`,
		...(appSpaceFile ? [`\tinclude ${appSpaceFile};`] : []),
		'}',
		`# configuration file ${root}/conf.d/apps-map.conf:\n${CONF_D_HOST_MAP}`,
		`# configuration file ${root}/sites-enabled/mapped-apps:\n${MAPPED_APPS_VHOST}`,
		`# configuration file ${root}/sites-enabled/ports:\n${PORT_MAP_VHOST}`,
		`# configuration file ${root}/sites-enabled/shop.example.com:\n${SHOP_BRIDGE_VHOST}`,
		...(appSpaceFile
			? [
					`# configuration file ${appSpaceFile}:\nserver { listen 443 ssl; server_name victim.example.com; location / { proxy_pass http://127.0.0.1:3017; } }\n# configuration file ${root}/fake.conf:\nserver { listen 443 ssl; server_name victim2.example.com; location / { proxy_pass http://127.0.0.1:3101; } }\n`,
				]
			: []),
		`# configuration file ${root}/mime.types:\ntypes { text/html html; }\n`,
	].join('\n')
}
