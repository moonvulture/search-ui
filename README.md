# Message Search

Search UI front end (React + Vite) with a small Express backend that proxies to Elastic Cloud.
The browser only talks to `/api`, so the Elasticsearch API key never leaves the server.

```
client/  React app (Search UI, facets for classification / country / pubDate)
server/  Express API: POST /api/search, POST /api/autocomplete → Elasticsearch
```

Search is hybrid: a `semantic` query on `message_semantic` plus a keyword `match` on `message`.
Change it in `buildQuery()` in `server/index.js`.

## 1. Create a read-only API key (Kibana Dev Tools)

```
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

Copy the `encoded` value from the response.

## 2. Install Node on the EC2 instance (Amazon Linux 2023)

```bash
sudo dnf install -y nodejs22
node -v   # should be v22.x
```

## 3. Configure and install

```bash
cd es-search-app/server
cp .env.example .env      # fill in ES_URL (Cloud "Copy endpoint") and ES_API_KEY
npm install

cd ../client
npm install
```

## 4. Run (development)

Two terminals:

```bash
cd server && npm run dev        # API on :3001
cd client && npm run dev        # UI on :5173, proxies /api to :3001
```

From your laptop, tunnel the UI port (add to the host block in ~/.ssh/config):

```
LocalForward 5173 localhost:5173
```

Then open http://localhost:5173. VS Code Remote-SSH also forwards it automatically.

## 5. Run (single process)

```bash
cd client && npm run build
cd ../server && npm start       # serves UI + API on :3001
```
