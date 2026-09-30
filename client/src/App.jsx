import { useEffect, useState } from "react";
import {
  SearchProvider,
  SearchBox,
  Results,
  Facet,
  PagingInfo,
  ResultsPerPage,
  Paging,
  Sorting,
  ErrorBoundary,
  WithSearch,
  useSearch,
} from "@elastic/react-search-ui";
import { Layout } from "@elastic/react-search-ui-views";
import { ApiProxyConnector } from "@elastic/search-ui-elasticsearch-connector/api-proxy";
import "@elastic/react-search-ui-views/lib/styles/styles.css";
import "./App.css";

// All Elasticsearch traffic goes through our backend at /api; no credentials in the browser.
const connector = new ApiProxyConnector({ basePath: "/api" });

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

const config = {
  apiConnector: connector,
  alwaysSearchOnInitialLoad: true,
  trackUrlState: true,
  hasA11yNotifications: true,
  searchQuery: {
    search_fields: { message: {} },
    result_fields: {
      message: { raw: {} },
      pubDate: { raw: {} },
      classification: { raw: {} },
      country: { raw: {} },
      link: { raw: {} },
    },
    autocompleteQuery: {
      results: {
        resultsPerPage: 5,
        search_fields: { message: {} },
        result_fields: {
          message: { snippet: { size: 100, fallback: true } },
          link: { raw: {} },
        },
      },
    },
    disjunctiveFacets: ["classification", "country"],
    facets: {
      classification: { type: "value", size: 10 },
      country: { type: "value", size: 30 },
      pubDate: {
        type: "range",
        ranges: [
          { from: daysAgo(1), name: "Last 24 hours" },
          { from: daysAgo(7), name: "Last 7 days" },
          { from: daysAgo(30), name: "Last 30 days" },
          { to: daysAgo(30), name: "Older" },
        ],
      },
    },
  },
};

const SORT_OPTIONS = [
  { name: "Relevance", value: [] },
  { name: "Newest first", value: [{ field: "pubDate", direction: "desc" }] },
  { name: "Oldest first", value: [{ field: "pubDate", direction: "asc" }] },
];

const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "";

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null; // not a parseable URL at all
  }
}

function MessageResult({ result }) {
  const cls = result.classification?.raw;
  const link = result.link?.raw;
  const url = safeUrl(result.link?.raw);
  return (
    <li className="msg">
      <div className="msg-meta">
        {cls && <span className={`badge badge-${cls}`}>{cls}</span>}
        {result.country?.raw && <span className="country">{result.country.raw}</span>}
        <time>{fmtDate(result.pubDate?.raw)}</time>
      </div>
      <p className="msg-text">{result.message?.raw}</p>
      {url && (
        <a className="msg-link" href={url.href} target="_blank" rel="noopener noreferrer">
          {url.hostname} ↗
        </a>
      )}
    </li>
  );
}

// Dark mode: starts from the saved choice, or the OS setting if none saved.
// index.html applies it before first paint so the page doesn't flash white.
function ThemeToggle() {
  const [theme, setTheme] = useState(
    () => document.documentElement.dataset.theme || "light"
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("theme", theme); } catch { /* private mode */ }
  }, [theme]);

  const isDark = theme === "dark";
  return (
    <label className="theme-switch">
      <span className="theme-switch__label">Dark mode</span>
      <button
        type="button"
        role="switch"
        aria-checked={isDark}
        aria-label="Dark mode"
        className="theme-switch__track"
        onClick={() => setTheme(isDark ? "light" : "dark")}
      >
        <span className="theme-switch__thumb" />
      </button>
    </label>
  );
}

// Custom date range: two date pickers that set a range filter on pubDate.
// Dates are taken in the viewer's local time zone, from 00:00 on "From" to 23:59 on "To".
const CUSTOM_RANGE = "Custom range";

function DateRangeFilter() {
  const { filters, setFilter, removeFilter } = useSearch();
  const active = filters
    .find((f) => f.field === "pubDate")
    ?.values.find((v) => v?.name === CUSTOM_RANGE);

  const [from, setFrom] = useState(active?.fromDay ?? "");
  const [to, setTo] = useState(active?.toDay ?? "");
  const invalid = from && to && from > to;

  const apply = () => {
    if (invalid || (!from && !to)) return;
    const value = { name: CUSTOM_RANGE, fromDay: from, toDay: to };
    if (from) value.from = new Date(`${from}T00:00:00`).toISOString();
    if (to) value.to = new Date(`${to}T23:59:59.999`).toISOString();
    setFilter("pubDate", value, "all"); // replaces any other pubDate filter
  };

  const clear = () => {
    setFrom("");
    setTo("");
    if (active) removeFilter("pubDate", active, "all");
  };

  return (
    <fieldset className="sui-facet date-range">
      <legend className="sui-facet__title">Date range</legend>
      <label>
        <span>From</span>
        <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label>
        <span>To</span>
        <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
      </label>
      {invalid && <p className="date-range__error">"From" must be before "To".</p>}
      <div className="date-range__actions">
        <button type="button" onClick={apply} disabled={invalid || (!from && !to)}>Apply</button>
        {(active || from || to) && (
          <button type="button" className="date-range__clear" onClick={clear}>Clear</button>
        )}
      </div>
    </fieldset>
  );
}

export default function App() {
  return (
    <SearchProvider config={config}>
      <WithSearch mapContextToProps={({ wasSearched }) => ({ wasSearched })}>
        {({ wasSearched }) => (
          <div className="App">
            <ErrorBoundary>
              <Layout
                header={
                  <div className="header-row">
                    <SearchBox
                      inputProps={{ placeholder: "Search messages by meaning, e.g. \"power problems\"" }}
                      autocompleteMinimumCharacters={3}
                      debounceLength={300}
                      autocompleteResults={{
                        sectionTitle: "Matching messages",
                        titleField: "message",
                        urlField: "link",
                        linkTarget: "_blank",
                        shouldTrackClickThrough: false,
                      }}
                    />
                    <ThemeToggle />
                  </div>
                }
                sideContent={
                  <div>
                    {wasSearched && <Sorting label="Sort by" sortOptions={SORT_OPTIONS} />}
                    <Facet field="classification" label="Classification" filterType="any" />
                    <Facet field="country" label="Country" filterType="any" isFilterable />
                    <Facet field="pubDate" label="Published" />
                    <DateRangeFilter />
                  </div>
                }
                bodyContent={<Results resultView={MessageResult} />}
                bodyHeader={
                  <>
                    {wasSearched && <PagingInfo />}
                    {wasSearched && <ResultsPerPage />}
                  </>
                }
                bodyFooter={<Paging />}
              />
            </ErrorBoundary>
          </div>
        )}
      </WithSearch>
    </SearchProvider>
  );
}
