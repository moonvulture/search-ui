import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ElasticsearchAPIConnector from "@elastic/search-ui-elasticsearch-connector";
import rateLimit from "express-rate-limit";

const {
  ES_URL,
  ES_API_KEY,
  ES_INDEX = "messages",
  PORT = 3001,
  HOST = "127.0.0.1", // the Docker image sets 0.0.0.0
  TRUST_PROXY = "1", // number of proxies in front (nginx = 1, F5 + nginx = 2)
} = process.env;

if (!ES_URL || !ES_API_KEY) {
  console.error("Set ES_URL and ES_API_KEY in server/.env (see .env.example)");
  process.exit(1);
}

// Hybrid query: semantic match on message_semantic + keyword match on message.
// Facet filters (country, classification, pubDate) are added by the connector automatically.
function buildQuery(state) {
  const term = (state.searchTerm || "").trim();
  if (!term) return { match_all: {} };
  return {
    bool: {
      should: [
        { semantic: { field: "message_semantic", query: term } },
        { match: { message: { query: term, boost: 0.5 } } },
      ],
    },
  };
}

const connector = new ElasticsearchAPIConnector({
  host: ES_URL,
  apiKey: ES_API_KEY,
  index: ES_INDEX,
  getQueryFn: (state) => buildQuery(state),
});

const app = express();
app.use(express.json());
app.set("trust proxy", Number(TRUST_PROXY)); // real client IPs from X-Forwarded-For
app.use("/api/search", rateLimit({ windowMs: 60_000, limit: 30 }));
app.use("/api/autocomplete", rateLimit({ windowMs: 60_000, limit: 120 }));

app.post("/api/search", async (req, res) => {
  try {
    const { state, queryConfig } = req.body;
    res.json(await connector.onSearch(state, queryConfig));
  } catch (err) {
    console.error("search error:", err?.meta?.body?.error ?? err);
    res.status(500).json({ error: "Search failed" });
  }
});

app.post("/api/autocomplete", async (req, res) => {
  try {
    const { state, queryConfig } = req.body;
    res.json(await connector.onAutocomplete(state, queryConfig));
  } catch (err) {
    console.error("autocomplete error:", err?.meta?.body?.error ?? err);
    res.status(500).json({ error: "Autocomplete failed" });
  }
});

// In production, serve the built React app from the same server.
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../client/dist");
app.use(express.static(dist));
app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));

app.listen(Number(PORT), HOST, () => console.log(`API listening on http://${HOST}:${PORT}`));
