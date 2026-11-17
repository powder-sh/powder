---
name: Bug report
about: Something in powder does not work as the docs say
labels: bug
---

<!-- A security problem? Do not open an issue: see SECURITY.md. -->

**What happened**

**What you expected**

**Steps to reproduce**

1.

**Version**

The version at the bottom of the sidebar, or `version` in `/api/health` (signed in).

**Setup**

- Server OS and `docker compose version`:
- Proxy (Traefik or nginx):
- Installed with `bin/install.sh` or upgraded from an older version:

**Logs**

The failing step of the deploy log, or `docker logs powder` / `docker logs powder-worker`. Remove secrets, hostnames and IPs you do not want public.
