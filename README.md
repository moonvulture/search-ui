# Message Search

A web front end for searching messages stored in Elasticsearch. It combines **semantic search** (search by meaning, using a `semantic_text` field) with keyword search, and lays the results out in three panes:

```
┌───────────────────────────────────────────────────────────────────────┐
│  Search box                                              Dark mode ◯  │
├──────────────┬───────────────────────────┬────────────────────────────┤
│ Filters      │ Message feed              │ Message details            │
│              │                           │                            │
│ Sort by      │ ┌───────────────────────┐ │ id            k9Xw0ZpQ     │
│ Facets       │ │ ALERT  DE  Oct 7      │ │ classification alert       │
│ (from .env)  │ │ Severe thunderstorm…  │ │ country       DE           │
│              │ └───────────────────────┘ │ pubDate       Oct 7, 7:10  │
│ Published    │ ┌───────────────────────┐ │ …every other field…        │
│ Date range   │ │ ADVISORY  AT  Oct 7   │ │                            │
│              │ │ Brenner motorway…     │ │ Message                    │
│              │ └───────────────────────┘ │ Full message text…         │
└──────────────┴───────────────────────────┴────────────────────────────┘
```

- **Left:** filters. Facets are configured in `.env`; the Published presets and the custom date range use the date field.
- **Middle:** a two-line summary per message. Click one to open it.
- **Right:** every attribute of the selected message, then the full text. Close or Esc clears it. Below 1200 px wide, this pane slides in over the feed.

Other features: autocomplete while typing, sorting by relevance or date, dark mode (follows the OS, remembers the choice), and shareable URLs (filters and search live in the address bar).

## Contents

- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Configuration (.env)](#configuration-env)
- [Changing fields: what to edit](#changing-fields-what-to-edit)
- [Elasticsearch setup](#elasticsearch-setup)
- [Development](#development)
- [Building the container image](#building-the-container-image)
- [Deploying with Podman (air-gapped)](#deploying-with-podman-air-gapped)
- [nginx and the F5](#nginx-and-the-f5)
- [Troubleshooting](#troubleshooting)

## How it works

```
Browser ──/api/*──► Express server (:3001) ──HTTPS + API key──► Elasticsearch
   ▲                     │
   └──── built UI ◄──────┘   (the server also serves client/dist)
```

- **The browser never talks to Elasticsearch directly.** It sends search state (search term, filters, page) to the server's `/api` routes. The API key stays on the server.
- **The server decides the query.** `buildQuery()` in `server/index.js` runs a hybrid search: a `semantic` query on the semantic field plus a keyword `match` on the message field. Facet filters are added automatically.
- **Field names come from `.env`.** The server reads them at startup and hands them to the browser through `GET /api/config`. That is why one built image works against indexes with different field names.
- **Autocomplete is cheap.** It uses a keyword prefix query on the message field, not semantic search, so typing does not trigger an embedding per keystroke.

Built with [Search UI](https://www.elastic.co/docs/reference/search-ui) (React) and Express. All Elastic packages are pinned to the same version (1.24.2); upgrade them together.

## Project layout

```
.
├── Dockerfile              Three-stage image build (client build → server deps → runtime)
├── compose.yaml            Optional: run the image with Docker Compose
├── client/                 React app (Vite)
│   ├── index.html          Page shell; applies the saved theme before first paint
│   └── src/
│       ├── App.jsx         Layout, facets, feed, details pane, date range, dark mode
│       ├── App.css         Theme colors (CSS variables) and all styling
│       └── main.jsx        React entry point
└── server/
    ├── index.js            Express API: /api/config, /api/search, /api/autocomplete
    ├── .env.example        Template for server/.env
    └── .env                Your settings (never committed, never baked into the image)
```

## Configuration (.env)

The server reads `server/.env` in development, or the file passed to the container (`/opt/es-search/.env` in the Podman setup below). Copy `server/.env.example` to start.

**Connection**

| Variable | Default | Purpose |
|---|---|---|
| `ES_URL` | *(required)* | Elasticsearch endpoint, e.g. `https://es.internal:9200` |
| `ES_API_KEY` | *(required)* | Encoded API key, read-only on the index |
| `ES_INDEX` | `messages` | Index (or alias / pattern) to search |

**Fields**

| Variable | Default | Used for |
|---|---|---|
| `FIELD_MESSAGE` | `message` | Text field: keyword search, autocomplete, full text in the details pane |
| `FIELD_SUMMARY` | same as `FIELD_MESSAGE` | What the feed cards show, e.g. `title` |
| `FIELD_SEMANTIC` | `message_semantic` | `semantic_text` field: meaning-based search. Never sent to the browser |
| `FIELD_DATE` | `pubDate` | Date field: Published presets, date range, sorting, card date |
| `FIELD_CLASSIFICATION` | `classification` | Coloured badge on cards; colours come from `BADGE_COLORS` |
| `FIELD_COUNTRY` | `country` | Text shown next to the badge on cards |
| `FIELD_LINK` | `link` | URL field, shown as a clickable link in the details pane. Empty to disable |
| `FACETS` | classification and country | Sidebar filters, see below |
| `BADGE_COLORS` | `alert:red,advisory:amber,info:blue` | Badge colour per value, see below |
| `HIDDEN_FIELDS` | *(none)* | Comma-separated fields never sent to the browser. Add `_id` to hide the id row |

Notes on field names:
- `name.keyword` style names work. Cards and details show the base field (`name`).
- Nested fields such as `geo.country` work.
- Facet fields must be `keyword` fields.

**Facets**

```
FACETS=classification:Classification,country:Country:search,source:Source
```

- Each entry is `field:Label`. Filters appear in the order listed.
- Add `:search` for a filter box inside the facet, handy for long lists.
- Several values can be ticked at once (OR), and the counts for the other values stay visible.
- Leave `FACETS` unset to get classification and country.

**Badge colours**

```
BADGE_COLORS=secret:red,confidential:amber,restricted:purple,unclassified:green
```

- Each entry is `value:colour`. Colours: `red`, `amber`, `blue`, `green`, `purple`, `gray`.
- Matching ignores case, so `secret` also colours `SECRET`.
- Values not listed are gray.
- The colours themselves (light and dark versions) are CSS variables at the top of `client/src/App.css` (`--red-bg`, `--red-fg`, …). Change them there if you want different shades.

**Hiding the document id:** `_id` is not part of the document body, so it can't be removed from the search response; the app needs it to tell messages apart. Listing `_id` (or `id`) in `HIDDEN_FIELDS` hides the id row in the details pane.

**Server and proxy**

| Variable | Default | Purpose |
|---|---|---|
| `TRUST_PROXY` | `1` | Proxies in front of the app: nginx = `1`, F5 + nginx = `2`. Needed for correct client IPs in rate limiting |
| `PORT` | `3001` | Listen port |
| `HOST` | `127.0.0.1` | Listen address. The image sets `0.0.0.0` |
| `NODE_EXTRA_CA_CERTS` | *(none)* | Path to an internal CA bundle, so Node trusts an on-prem Elasticsearch certificate |

Format rules: one `KEY=value` per line, no quotes needed, and **no comments at the end of a line**. Some tools pass `TRUST_PROXY=2   # F5` through as the literal value `2   # F5`. Put comments on their own lines.

Prefer `NODE_EXTRA_CA_CERTS` over `NODE_TLS_REJECT_UNAUTHORIZED=0`. The latter turns off certificate checks for every connection the app makes.

## Changing fields: what to edit

| You want to… | Edit |
|---|---|
| Add a **sidebar filter** | `.env` only: add `field:Label` to the `FACETS` line |
| Show a field in the **details pane** | Nothing. Every field in the document already shows there automatically |
| Hide a field from the details pane | `.env` only: `HIDDEN_FIELDS` (`_id` hides the id row) |
| Show a different field on the **feed cards** (e.g. title instead of message) | `.env` only: `FIELD_SUMMARY` |
| Colour a **badge value** | `.env` only: `BADGE_COLORS` |
| Point an existing role at a different field name (message, date, badge, country, link, semantic) | `.env` only: the matching `FIELD_*` line |
| Give a field a **new job**, like a second label on the feed cards or a new kind of filter | Code: `server/index.js` *and* `client/src/App.jsx` |

After editing `.env`, restart the server (`sudo systemctl restart es-search`) and refresh the page. No client build and no image rebuild are needed, because `.env` is read when the server starts.

The defaults at the top of `server/index.js` (`FIELD_MESSAGE = "message"` and so on) are only fallbacks for lines missing from `.env`. Don't edit them to change field names; use `.env`, so the same code and image work on every network.

To see what the running app is using:

```bash
curl -s localhost:3001/api/config
```

## Elasticsearch setup

**Index mapping** (Kibana Dev Tools). Adjust names to your data:

```json
PUT messages
{
  "mappings": {
    "properties": {
      "pubDate":          { "type": "date" },
      "classification":   { "type": "keyword" },
      "country":          { "type": "keyword" },
      "link":             { "type": "keyword", "index": false },
      "message":          { "type": "text", "copy_to": "message_semantic" },
      "message_semantic": { "type": "semantic_text" }
    }
  }
}
```

With `copy_to`, documents only need `message`; Elasticsearch fills `message_semantic` and generates the embeddings. Without an `inference_id`, `semantic_text` uses the default ELSER endpoint.

On an **air-gapped cluster**, ELSER cannot download itself. Install it manually (Elastic documents this as the air-gapped ELSER install) *before* creating the index, or the mapping fails when it tries to deploy the model.

**Read-only API key**

```json
POST /_security/api_key
{
  "name": "message-search-ui",
  "role_descriptors": {
    "search_only": {
      "indices": [{ "names": ["messages"], "privileges": ["read", "view_index_metadata"] }]
    }
  }
}
```

Put the `encoded` value from the response into `ES_API_KEY`. If searches fail with a 403 mentioning inference, add the `monitor_inference` cluster privilege to the key.

## Development

Requires Node 20.19 or newer (Node 22 recommended).

```bash
cd server && cp .env.example .env    # fill in ES_URL and ES_API_KEY
npm install
cd ../client && npm install
```

**Iterating on the UI (hot reload):**

```bash
cd server && npm run dev      # API on :3001, restarts on server changes
cd client && npm run dev      # UI on :5173, reloads on every save; proxies /api to :3001
```

Open `http://localhost:5173` (VS Code Remote-SSH forwards the port).

**Running it like production, without a container:**

```bash
cd client && npm run build    # writes client/dist
cd ../server && npm start     # serves UI + API on :3001
```

When the server runs as a systemd service (`es-search`) straight from the project folder:

| Changed | Do |
|---|---|
| `client/src/*` | `npm run build` in `client/`, then hard-refresh (Ctrl+Shift+R). No restart needed |
| `server/index.js` or `.env` | `sudo systemctl restart es-search` |

Only one thing can listen on port 3001: either the systemd service or a container, not both.

## Building the container image

The `Dockerfile` builds the client inside the image, so it does not depend on your local `client/dist`. The base image and npm registry can be overridden for networks with internal mirrors:

```dockerfile
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS client-build
ARG NPM_REGISTRY
...
RUN --mount=type=cache,target=/root/.npm \
    if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi && npm ci
```

**With internet access (Docker):**

```bash
docker build -t es-search:latest .
docker save es-search:latest | gzip > es-search.tar.gz
```

**On a network with an internal registry and npm mirror (Podman):**

```bash
sudo podman login registry.yourcorp.internal
sudo podman build --format docker \
  --build-arg NODE_IMAGE=registry.yourcorp.internal/library/node:22-alpine \
  --build-arg NPM_REGISTRY=https://nexus.yourcorp.internal/repository/npm-proxy/ \
  -t es-search:latest .
```

- `--format docker` keeps the `HEALTHCHECK`; Podman's default format drops it.
- `sudo` puts the image in root's image store, where the systemd service looks for it.
- `package-lock.json` points at `registry.npmjs.org`; npm swaps in `NPM_REGISTRY` automatically.

**Build speed.** The Dockerfile copies `package.json` and `package-lock.json` and runs `npm ci` *before* copying the source. A change to `App.jsx` or `index.js` reuses the cached install, so only the client build and the final layers run; the build log shows those steps as `CACHED` / `Using cache`. `npm ci` runs again only when a `package*.json` file or a build argument changes, and then the npm cache mount (`--mount=type=cache,target=/root/.npm`) avoids downloading packages that are already cached.

If every build reinstalls everything, check that you're not passing `--no-cache`, that you always build with the same `sudo` (root and your user have separate caches), that the `--build-arg` values are identical each time, and that `BUILDAH_LAYERS` isn't set to `false`.

Check an image before shipping it:

```bash
docker run --rm es-search:latest ls /app/server /app/client/dist
```

`.env` is excluded by `.dockerignore` and is never part of the image.

## Deploying with Podman (air-gapped)

**1. Load the image and add the config**

```bash
sudo podman load -i es-search.tar.gz      # skip if you built it on this machine
sudo podman images                        # note the name, e.g. localhost/es-search:latest

sudo mkdir -p /opt/es-search
sudo cp .env /opt/es-search/.env          # this network's ES_URL, API key, FIELD_*, FACETS
sudo chmod 600 /opt/es-search/.env
```

**2. Run it as a service** with a Quadlet file, `/etc/containers/systemd/es-search.container` (needs Podman 4.4 or newer):

```ini
[Unit]
Description=Message Search
Wants=network-online.target
After=network-online.target

[Container]
Image=localhost/es-search:latest
ContainerName=es-search
EnvironmentFile=/opt/es-search/.env
PublishPort=127.0.0.1:3001:3001
# Internal CA: copy the PEM to /opt/es-search/ca.pem (chmod 644), then uncomment
# Volume=/opt/es-search/ca.pem:/etc/ssl/certs/internal-ca.pem:ro,Z
# Environment=NODE_EXTRA_CA_CERTS=/etc/ssl/certs/internal-ca.pem

[Service]
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl start es-search
systemctl status es-search
sudo podman ps                            # "(healthy)" after ~30 s
curl -s localhost:3001/api/config
```

There is no `systemctl enable` for Quadlet units; the `[Install]` section starts it at boot.

**Updating**

```bash
sudo podman load -i es-search.tar.gz      # or podman build, as above
sudo systemctl restart es-search          # recreates the container from the new image
sudo podman image prune                   # optional: remove the old image
```

`/opt/es-search/.env` is untouched by updates.

**Without Quadlet (or with Docker)**, the equivalent one-off command:

```bash
docker run -d --name es-search --restart unless-stopped \
  --env-file /opt/es-search/.env -p 127.0.0.1:3001:3001 es-search:latest
```

## nginx and the F5

nginx is the only thing exposed on the host; the app stays on `127.0.0.1:3001`. On RHEL, `/etc/nginx/conf.d/search.conf`:

```nginx
map $http_x_forwarded_proto $fwd_proto {
    default $http_x_forwarded_proto;
    ""      $scheme;
}

server {
    listen 80 default_server;
    server_name _;

    # Optional: only the F5 may connect
    # allow 10.0.0.10;
    # deny  all;

    gzip on;
    gzip_types text/css application/javascript application/json;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $fwd_proto;
    }
}
```

```bash
sudo sed -i 's/ default_server//' /etc/nginx/nginx.conf   # let this site be the default
sudo setsebool -P httpd_can_network_connect 1              # SELinux: allow nginx → :3001
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="10.0.0.10/32" port port="80" protocol="tcp" accept'
sudo firewall-cmd --reload
sudo nginx -t && sudo systemctl enable --now nginx
```

**F5 checklist**

- Enable **X-Forwarded-For insertion** in the HTTP profile, and set `TRUST_PROXY=2`. Otherwise all users share one rate-limit bucket.
- Health monitor: `GET /`, expect 200. Don't monitor `/api/search`; every call runs a semantic query.
- Restrict port 80 on the host to the F5's IPs so nobody can bypass it.
- If the F5 re-encrypts to the backend, change nginx to `listen 443 ssl default_server;` with a certificate under `/etc/pki/nginx/`.

**Rate limits** (per client IP, in `server/index.js`): 30 searches and 120 autocomplete requests per minute.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| UI changes don't appear | Old `client/dist`, or old image | Dev box: `npm run build` in `client/`. Container: rebuild the image, then restart. Hard-refresh the browser |
| 502 Bad Gateway, nginx log says "Permission denied" | SELinux | `sudo setsebool -P httpd_can_network_connect 1` |
| 502, nginx log says "Connection refused" | App not running | `systemctl status es-search`, then `journalctl -u es-search -n 50` |
| "Could not load configuration" on the page | `/api/config` unreachable | Check the server is running and nginx proxies `/api` |
| Search fails, server log shows a certificate error | Internal CA not trusted | Mount the CA and set `NODE_EXTRA_CA_CERTS` |
| Search fails mentioning inference or a missing model | ELSER not deployed or no permission | Check `GET _ml/trained_models/_stats`; add `monitor_inference` to the API key |
| A facet is empty | Field isn't `keyword`, or wrong name | Use the `.keyword` sub-field; check `curl -s localhost:3001/api/config` |
| A field shows the wrong value on cards | `FIELD_*` points at the wrong field | Fix `.env`, restart |
| Users get "Too many requests" | Everyone shares one IP for rate limiting | F5 X-Forwarded-For insertion plus `TRUST_PROXY=2` |
| Every build reinstalls npm packages | Cache not reused | See *Build speed* above |
| A badge value has no colour | Not in `BADGE_COLORS`, or misspelled | Add `value:colour`; case doesn't matter |
| Image builds but has no health status | Built in OCI format | Rebuild with `podman build --format docker` |
| Service can't find the image | Image loaded without `sudo` | `sudo podman load` / `sudo podman build`; root and users have separate image stores |
