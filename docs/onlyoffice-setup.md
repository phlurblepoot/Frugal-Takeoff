# ONLYOFFICE Document Editor — Setup Guide

Frugal Takeoff's document editing (PDFs, Word files, spreadsheets) runs in
**ONLYOFFICE Docs Community Edition**, a free, self-hosted editor. It runs as a
**second container** next to the app. Your documents stay in the app's data
folder; ONLYOFFICE only holds a temporary working copy while a file is open.

This guide sets up the **test** environment on Unraid behind Cloudflare and
Nginx Proxy Manager, using the subdomain **`docs-test.<your-domain>`**.
Production is the same steps with its own subdomain and secret (§7).

When you're done, **Settings → Document Editor** in the app should show three
green **Working** checks. If one fails, its message says what to fix, and §6
covers the common cases.

Project checklist: `docs/superpowers/specs/2026-09-25-onlyoffice-checklist.md`.

---

## 1. How the pieces talk to each other

```
 Browser ──HTTPS──▶ Cloudflare ──▶ Nginx Proxy Manager ──▶ onlyoffice-test container   (1)
                                                     └──▶ Frugal Takeoff test container

 Frugal Takeoff ──http, Docker network──▶ ONLYOFFICE                                    (2)
 ONLYOFFICE     ──http, Docker network──▶ Frugal Takeoff                                (3)
```

1. **Browsers** load the editor from ONLYOFFICE's own public HTTPS address:
   `ONLYOFFICE_PUBLIC_URL`, e.g. `https://docs-test.example.com`.
2. **The app** talks to ONLYOFFICE directly over the Docker network:
   `ONLYOFFICE_INTERNAL_URL`, e.g. `http://onlyoffice-test`.
3. **ONLYOFFICE** downloads files from the app and sends saves back over the
   Docker network: `APP_INTERNAL_URL`, e.g. `http://frugal-takeoff-test:3000`.

All three must work. The Settings tab checks each one separately.

Every request between the two servers is signed with a **shared secret**. The
app's `ONLYOFFICE_JWT_SECRET` and ONLYOFFICE's `JWT_SECRET` must be the same
value.

---

## 2. Before you start

- **Memory:** ONLYOFFICE recommends **4 GB of RAM** and 2 CPU cores for itself.
  Check free memory on the Unraid **Dashboard** (or run `free -h` in the Unraid
  terminal). The image is about 1.3 GB to download.
- **Make a shared secret.** In the Unraid terminal, run:

  ```bash
  openssl rand -hex 32
  ```

  Keep the output somewhere safe; you'll paste it into both containers. Use a
  different secret for production.
- **The test app image.** Every push to the `onlyoffice` branch builds
  `ghcr.io/phlurblepoot/frugal-takeoff:onlyoffice`. Point your existing test
  container at that tag (§4).

---

## 3. A shared Docker network

The app and ONLYOFFICE need to reach each other by container name, so put them
on the same user-defined Docker network.

1. Unraid → **Settings → Docker**: set **Preserve user defined networks** to
   **Yes**. (Stop the Docker service to change it if needed, then start it
   again.) Without this, Unraid forgets the network on reboot.
2. In the Unraid terminal:

   ```bash
   docker network create frugal
   ```

3. When editing each container below, set **Network Type** to **Custom: frugal**.

If your test app container already uses a custom network, use that one instead
of creating `frugal`.

**Nginx Proxy Manager** can either join this network too (then it forwards to
container names), or stay where it is and forward to the Unraid server's IP and
a mapped port. §5 covers both.

---

## 4. Containers

### 4.1 ONLYOFFICE (new container)

Unraid → **Docker → Add Container**:

| Field | Value |
|---|---|
| Name | `onlyoffice-test` |
| Repository | `onlyoffice/documentserver:9.4.0.1` (a pinned version: never `latest`) |
| Network Type | `Custom: frugal` |
| Port | Container port `80` → host port `8088`. Only needed if Nginx Proxy Manager reaches containers by IP:port. |
| Variable `JWT_SECRET` | the secret from §2 |
| Variable `ALLOW_PRIVATE_IP_ADDRESS` | `true` |

Leave everything else at its default. In particular, don't set `JWT_ENABLED`
(already on), `JWT_HEADER` or `JWT_IN_BODY`.

- **`ALLOW_PRIVATE_IP_ADDRESS=true`** is required. The app sits on a private
  Docker address, and without this ONLYOFFICE refuses to download files from it
  or send saves back.
- **Volumes are optional.** ONLYOFFICE keeps no permanent data; saved documents
  live in the app's data folder. If you want its logs kept across restarts for
  troubleshooting, map `/var/log/onlyoffice` to e.g.
  `/mnt/user/appdata/onlyoffice-test/logs`.

Start it and give it a minute or two. First start takes a while.

### 4.2 Frugal Takeoff test app (existing container)

Edit your existing test container:

| Field | Value |
|---|---|
| Repository | `ghcr.io/phlurblepoot/frugal-takeoff:onlyoffice` |
| Network Type | `Custom: frugal` (the same network as ONLYOFFICE) |
| Variable `ONLYOFFICE_PUBLIC_URL` | `https://docs-test.<your-domain>` |
| Variable `ONLYOFFICE_INTERNAL_URL` | `http://onlyoffice-test` |
| Variable `APP_INTERNAL_URL` | `http://<this container's name>:3000`, e.g. `http://frugal-takeoff-test:3000` |
| Variable `ONLYOFFICE_JWT_SECRET` | the same secret as ONLYOFFICE's `JWT_SECRET` |

The container names in the internal URLs must match what Unraid shows in the
**Name** column; Docker resolves them on the shared network.

**If the two containers can't share a network**, use the Unraid server's IP and
the mapped ports instead:
- `ONLYOFFICE_INTERNAL_URL=http://<unraid-ip>:8088`
- `APP_INTERNAL_URL=http://<unraid-ip>:<test app host port>`

`ALLOW_PRIVATE_IP_ADDRESS=true` covers this too.

### 4.3 docker-compose instead of Unraid

`docker-compose.yml` in the repo already defines both services on one network.
Create a `.env` file next to it containing
`ONLYOFFICE_JWT_SECRET=<your secret>`. Uncomment and set
`ONLYOFFICE_PUBLIC_URL`, then run `docker compose up -d`. The internal URLs
(`http://onlyoffice`, `http://app:3000`) are already set for that file.

---

## 5. Public address: Cloudflare + Nginx Proxy Manager

Browsers need to reach ONLYOFFICE on its own HTTPS subdomain.

### 5.1 Cloudflare

1. **DNS → Records → Add record:** name `docs-test`, pointing at the same place
   as your app's record (same type and target). **Proxied** (orange cloud) is
   fine.
2. **Network → WebSockets:** must be **On** (it is by default). The editor
   keeps a live WebSocket connection open.
3. If you use **Rocket Loader** (Speed → Optimization), turn it off for
   `docs-test` with a Configuration Rule. It rewrites scripts and can break the
   editor.

Cloudflare's free plan limits uploads to 100 MB per request, the same limit the
app already has, so nothing changes there.

### 5.2 Nginx Proxy Manager

**Hosts → Proxy Hosts → Add Proxy Host.**

On the **Details** tab:

| Field | Value |
|---|---|
| Domain Names | `docs-test.<your-domain>` |
| Scheme | `http` |
| Forward Hostname / IP | `onlyoffice-test` if NPM is on the `frugal` network; otherwise the Unraid server's IP |
| Forward Port | `80` if NPM is on the `frugal` network; otherwise `8088` |
| **Websockets Support** | **On** (required) |
| Block Common Exploits | Your usual choice. If the editor misbehaves, try it off. |

On the **SSL** tab: use the same kind of certificate as your app's proxy host
(Let's Encrypt, or a Cloudflare Origin certificate), with **Force SSL** on.

### 5.3 Quick check

Open `https://docs-test.<your-domain>/healthcheck` in a browser. It should show
**`true`**.

---

## 6. Check it in the app, and fix what fails

Sign in to the test app as an admin → **Settings → Document Editor**. You
should see your three addresses, the ONLYOFFICE version, and three **Working**
checks. **Check again** re-runs them after you change something. Restart the
app container after changing its variables.

| Check / message | What to fix |
|---|---|
| **"ONLYOFFICE isn't set up yet"** listing variables | Add the listed variables to the app container (§4.2) and restart it. |
| **Browser:** "couldn't load …/api.js" | The public path (§5). Check the Cloudflare DNS record, the NPM proxy host (Websockets on, SSL certificate) and that `ONLYOFFICE_PUBLIC_URL` is exactly the subdomain. `/healthcheck` (§5.3) should load in the same browser. |
| **Browser:** "This app is open over HTTPS, so browsers block…" | `ONLYOFFICE_PUBLIC_URL` starts with `http://`. It must be `https://`. |
| **App → ONLYOFFICE:** "Couldn't reach ONLYOFFICE … (ENOTFOUND / ECONNREFUSED / timed out)" | `ONLYOFFICE_INTERNAL_URL` is wrong, the ONLYOFFICE container isn't running (or is still starting), or the two containers aren't on the same network (§3). |
| **App → ONLYOFFICE:** "answered HTTP 404…" / "did not answer like an ONLYOFFICE Document Server" | `ONLYOFFICE_INTERNAL_URL` points at something else (e.g. the proxy, or the wrong port). |
| **App → ONLYOFFICE:** "rejected this app's signature" | The secrets differ. Make the app's `ONLYOFFICE_JWT_SECRET` and ONLYOFFICE's `JWT_SECRET` identical, then restart both. |
| **ONLYOFFICE → app:** "couldn't download a test file from this app" | `APP_INTERNAL_URL` is wrong (container name, port `3000`), or `ALLOW_PRIVATE_IP_ADDRESS=true` is missing on ONLYOFFICE. |
| **ONLYOFFICE → app:** "reached this app … but the test conversion still failed" | Networking is fine. Check the ONLYOFFICE container log for the error. |

If the editor itself later loads but looks broken after an ONLYOFFICE upgrade,
purge Cloudflare's cache for `docs-test`.

---

## 7. Production (later, when the project is merged)

Repeat §3–§6 for production with:
- its own ONLYOFFICE container (e.g. `onlyoffice`)
- its own subdomain (e.g. `docs.<your-domain>`)
- its **own secret**

The production app container gets the same four variables pointing at those.
Take a backup first (Settings → Backup), as for any release.

## 8. Upgrading ONLYOFFICE

The version is pinned on purpose. To upgrade:
1. Read ONLYOFFICE's changelog for the new version.
2. Change the tag on the test container.
3. Check **Settings → Document Editor** and open a few documents.
4. Then do the same on production.

The pinned version in `docker-compose.yml` should move with it.

## 9. What is stored where

- **Documents and versions:** in the app's data folder, covered by the app's
  backups as always.
- **ONLYOFFICE container:** only temporary working copies and logs. Nothing in
  it needs backing up.
- **The shared secret:** in both containers' settings. If it's lost, make a new
  one and set it in both.
