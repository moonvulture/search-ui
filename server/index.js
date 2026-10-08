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

  // Field names in your index. Defaults match the original "messages" mapping.
  FIELD_MESSAGE = "message", // text field: keyword search, autocomplete, display
  FIELD_SEMANTIC = "message_semantic", // semantic_text field: meaning-based search
  FIELD_DATE = "pubDate", // date field: Published facet, date range, sorting
  FIELD_CLASSIFICATION = "classification", // keyword field: facet + badge
  FIELD_COUNTRY = "country", // keyword field: facet
  FIELD_LINK = "link", // optional URL field ("" to disable)
  HIDDEN_FIELDS = "", // comma-separated fields never sent to the browser
  FACETS, // sidebar filters, e.g. "classification:Classification,country:Country:search"
} = process.env;

// FACETS is a comma-separated list of field:Label[:search] entries, shown in that order.
// ":search" adds a filter box inside the facet (useful for long lists).
// Without FACETS, the sidebar shows classification and country as before.
function parseFacets(spec) {
  return spec
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [field, label, option] = entry.split(":").map((x) => x.trim());
      return { field, label: label || field, searchable: option === "search" };
    })
    .filter((facet) => facet.field);
}
const FACET_LIST = parseFacets(
  FACETS ?? `${FIELD_CLASSIFICATION}:Classification,${FIELD_COUNTRY}:Country:search`
);

const FIELDS = {
  message: FIELD_MESSAGE,
  date: FIELD_DATE,
  classification: FIELD_CLASSIFICATION,
  country: FIELD_COUNTRY,
  link: FIELD_LINK,
};

if (!ES_URL || !ES_API_KEY) {
  console.error("Set ES_URL and ES_API_KEY in server/.env (see .env.example)");
  process.exit(1);
}

// Hybrid query: semantic match on FIELD_SEMANTIC + keyword match on FIELD_MESSAGE.
// Facet filters (country, classification, pubDate) are added by the connector automatically.
function buildQuery(state) {
  const term = (state.searchTerm || "").trim();
  if (!term) return { match_all: {} };
  return {
    bool: {
      should: [
        { semantic: { field: FIELD_SEMANTIC, query: term } },
        { match: { [FIELD_MESSAGE]: { query: term, boost: 0.5 } } },
      ],
    },
  };
}

// The details pane lists every attribute of a message, so return the whole document
// except the embeddings field and anything listed in HIDDEN_FIELDS.
const SOURCE_EXCLUDES = [
  FIELD_SEMANTIC,
  ...HIDDEN_FIELDS.split(",").map((x) => x.trim()).filter(Boolean),
];

const connector = new ElasticsearchAPIConnector({
  host: ES_URL,
  apiKey: ES_API_KEY,
  index: ES_INDEX,
  getQueryFn: (state) => buildQuery(state),
  interceptSearchRequest: ({ requestBody }, next) =>
    next({ ...requestBody, _source: { excludes: SOURCE_EXCLUDES } }),
});

const app = express();
app.use(express.json());
app.set("trust proxy", Number(TRUST_PROXY)); // real client IPs from X-Forwarded-For
app.use("/api/search", rateLimit({ windowMs: 60_000, limit: 30 }));
app.use("/api/autocomplete", rateLimit({ windowMs: 60_000, limit: 120 }));

// Field names for the browser, so the same built client works against any index layout.
app.get("/api/config", (_req, res) => res.json({ fields: { ...FIELDS, facets: FACET_LIST } }));

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
