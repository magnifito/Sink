# Docker

Docker is an optional deployment target. Cloudflare remains the default for
existing build and deployment commands. The Docker image runs the Nuxt Node
server as a non-root user without a Cloudflare account. One persistent volume
holds SQLite, images, and link backups. This deployment supports one host and one
app process. Do not run multiple replicas against the volume or use a network
filesystem.

## Run locally

Create a private runtime environment file. Keep the existing `.env` for the
Cloudflare development server if you still use it.

```bash
umask 077
printf 'NUXT_SITE_TOKEN=%s\n' "$(openssl rand -hex 32)" > .env.docker
docker compose --env-file .env.docker up --build -d
docker compose --env-file .env.docker ps
```

Open `http://localhost:7466`. Use `NUXT_SITE_TOKEN` from `.env.docker` to sign in.
Node mode requires a runtime token of at least 32 characters. The image does not
include local `.env` files. Compose passes `.env.docker` to the container; add
optional `NUXT_*` runtime settings there as needed.

The database schema initializes on startup. Later startups apply new migrations
once and reject changed migration files. Rebuilding or replacing the container
keeps the volume. `docker compose down -v` deletes the data; do not use it during
normal upgrades.

`GET /_health` checks database access. It returns no private data.

## Redirect the homepage

To redirect visitors to your main website instead of showing the Sink homepage,
add this setting to `.env.docker`:

```dotenv
NUXT_PUBLIC_HOME_URL=https://example.com
```

Apply configuration changes with `docker compose --env-file .env.docker up -d`.
No image rebuild is needed for this setting. Requests to `/`, including those
with query strings, return a `302` redirect to the configured URL. Query strings
are not forwarded. Leave the setting empty to show the default homepage.

Open `/dashboard` directly to sign in. Short links keep their normal behavior.
This setting hides the public greeting; it does not hide the dashboard route or
replace site-token authentication.

## Run on your own server

1. Install Docker Engine and Docker Compose on the server.
2. Copy or clone this repository onto the server.
3. Create `.env.docker` and start the app with the commands above.
4. Point your domain's DNS record to the server's public IP address.
5. Configure an HTTPS reverse proxy on the host to forward requests to `127.0.0.1:7466`.
6. Check the health status, sign in, create a link, and check the redirect.

The standard `compose.yaml` creates its own Docker network and persistent volume.
It binds the app to the host's loopback interface. Set `SINK_PORT` in `.env.docker`
to change the host port. The container listens on port `3000`.

For accurate visitor counts behind a reverse proxy, add `NUXT_TRUST_PROXY=true`
to `.env.docker` and run the Compose start command again. Configure the proxy to
replace untrusted forwarded headers with the real client IP and request protocol.
Keep the app reachable only through that proxy. Leave this setting off for direct
access. DNS and TLS can use any provider.

If a CDN or another proxy sits in front of your reverse proxy, configure the
reverse proxy to trust only that upstream's published IP ranges and to take the
client IP from its forwarded header. Otherwise Sink records the upstream's edge
address, and visitor counts, geo reports and country redirects reflect the CDN
location instead of the visitor.

## Features and limits

| Feature                                                    | Docker behavior                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Links, tags, search, expiry, passwords, import/export, MCP | Uses the existing app and validation rules                                         |
| Database                                                   | SQLite at `/data/sink.sqlite`; write-ahead logging and atomic batches              |
| Cache                                                      | Reads SQLite directly; no KV or Redis service                                      |
| Images                                                     | Files under `/data/objects`; SQLite maps object keys to opaque filenames           |
| Click analytics and realtime dashboard                     | Local, unsampled records; same filters and timezone buckets                        |
| Analytics retention                                        | 90 days by default; set `NUXT_ANALYTICS_RETENTION_DAYS` to a positive integer      |
| Link backups                                               | Automatic once per UTC day while running; manual backup also works                 |
| Webhooks                                                   | Uses the configured URL and secret; graceful shutdown waits for in-flight delivery |
| AI slug and metadata generation                            | Disabled; endpoints return `501 AI not enabled`. Enter values manually             |
| Geo routing, city/country analytics, globe locations       | Uses an optional local City or Country MMDB database; see setup below              |

Cloudflare IP geolocation and Workers AI are not available merely because the
site's DNS uses Cloudflare. The Node app does not trust arbitrary geo headers.
Browser, device, referrer, language, visit counts, and time charts still work.

## Local geo lookup

Set `NUXT_GEO_DATABASE_PATH` to a readable GeoLite2 or GeoIP2 City/Country
`.mmdb` file inside the container. City databases also supply city, region,
timezone and coordinates where available. Country databases supply country
redirects and country reports, without city or globe data.

For automatic downloads, create a MaxMind account and license key. Add these
two private values to a separate `.env.geo` file (use `.env.geo.example` as
the template). Do not put updater credentials in `.env.docker`, which the
app reads:

```dotenv
GEOIPUPDATE_ACCOUNT_ID=your-account-id
GEOIPUPDATE_LICENSE_KEY=your-license-key
```

Start the app with the optional Compose override:

```bash
docker compose --env-file .env.docker --env-file .env.geo -f compose.yaml -f compose.geo.yaml up --build -d
```

The official `geoipupdate` container downloads GeoLite2-City to a separate
persistent volume every 24 hours. Sink mounts that volume read-only. Only the
updater receives MaxMind credentials. Use both Compose files for subsequent
start/stop/update commands. The normal Compose command still runs without geo.

Sink checks for a changed database every 60 seconds. It validates the replacement
before swapping its in-memory reader. A failed or missing replacement keeps the
last valid reader. Before the first successful download, geo reports remain empty
and country redirects use their normal target. A missing or damaged database
does not prevent startup or normal redirects. If the updater fails, check its
logs and account/license configuration; Sink never downloads data during a click.

Behind a reverse proxy, set `NUXT_TRUST_PROXY=true` and configure the proxy to
replace untrusted forwarded headers. With this option off, Sink locates the
direct peer only. Private, reserved and unknown addresses yield no location.
IPv4 and IPv6 both work. Client-supplied Cloudflare geo headers never control
Node redirects, location reports or globe coordinates.

`GET /api/geo/status` requires the normal admin credential. It reports `disabled`,
`unavailable` or `ready`, the database type, its build date and whether the last
reload failed. It exposes neither filesystem paths nor visitor IPs. Check the
build date to detect old data. The public `/_health` endpoint remains a database
health check and does not require geo to be ready.

You can use an existing licensed database instead of the updater. Mount its
directory read-only into the app and set the path. Replace the file atomically
when updating it. Do not copy a database into the Docker image. Include the geo
volume in host backup procedures if you need to restore without a fresh download.

This product includes GeoLite2 data created by MaxMind, available from
[MaxMind](https://www.maxmind.com/), when you enable GeoLite2 lookup. See the
[database update guide](https://dev.maxmind.com/geoip/updating-databases/) and
[official updater Docker setup](https://github.com/maxmind/geoipupdate/blob/main/doc/docker.md).
IP location is approximate; do not use it as an access control. Geo lookup does
not require storing raw IPs, but the existing analytics collector still stores
them. This feature does not change analytics privacy policy.

This is independent hosting, not offline browsing: user-supplied link targets,
configured webhooks, and the app's existing external favicon/marketing assets can
still make network requests.

## Backups, restore, and upgrades

Automatic link backups contain links and tags, not analytics or image files.
They use the same persistent volume and do not protect against loss of the host.
Object filenames are opaque; use the app's link export for a portable JSON export.
Keep copies of the complete volume outside the host. Monitor disk space and
rotate old backup objects; automatic link backups do not currently expire.

For a complete, consistent volume snapshot, stop the app before copying `/data`:

```bash
mkdir -p backups
docker compose --env-file .env.docker stop sink
docker cp "$(docker compose --env-file .env.docker ps -aq sink)":/data ./backups/sink-data
docker compose --env-file .env.docker start sink
```

Use a new snapshot directory each time. Store the token separately. For restore,
stop a fresh container, copy the snapshot contents into its `/data`, set ownership
to UID/GID `1000:1000`, then start the matching app image. The SQLite database and
the `objects` directory must come from the same snapshot. Do not copy only the
main SQLite file while the app is running; WAL files can hold committed writes.

Before an upgrade, save both the volume snapshot and the previous image tag.
Rebuild and replace the container. Check health and a short link. To roll back
across a schema change, restore the matching snapshot and previous image together.

To move existing Cloudflare links, export them from the old dashboard and import
them into the new one. Check passwords and expiry, and copy/re-upload images
before DNS cutover. Link JSON does not transfer stored images or historical
Analytics Engine records. Docker never reads or changes the old Cloudflare store.

## Development verification

```bash
pnpm test:node
pnpm build:node
pnpm test:node:integration
```

The normal `pnpm build` and Worker tests still target Cloudflare. Rebuild for the
matching runtime before each integration suite.

To run the integration checks against a Docker container, set `SINK_TEST_URL` and
`NUXT_SITE_TOKEN`. Use a disposable test instance: these checks create links,
images, click records, and backups. Without `SINK_TEST_URL`, the script uses a
temporary data directory and an available local port, and removes its data when
it finishes.
