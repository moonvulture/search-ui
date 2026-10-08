import { createContext, useContext, useEffect, useMemo, useState } from "react";
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

// Facets need a keyword field (e.g. "country.keyword"), but the value shown on the card
// comes from the original field in _source ("country"), so strip ".keyword" for display.
const displayField = (f) => (f || "").replace(/\.keyword$/, "");

// Read a field from a result, including nested paths like "geo.country".
function getField(result, path) {
  if (!path) return undefined;
  if (result[path]?.raw !== undefined) return result[path].raw;
  const [top, ...rest] = path.split(".");
  return rest.reduce((v, key) => (v == null ? v : v[key]), result[top]?.raw);
}

// Field names come from the server (/api/config), which reads them from .env.
const FieldsContext = createContext(null);
const useFields = () => useContext(FieldsContext);

function buildConfig(f) {
  const show = (name) => (name ? { [displayField(name)]: { raw: {} } } : {});
  return {
    apiConnector: connector,
    alwaysSearchOnInitialLoad: true,
    trackUrlState: true,
    hasA11yNotifications: true, // screen readers announce result counts
    searchQuery: {
      search_fields: { [f.message]: {} },
      result_fields: {
        ...show(f.message),
        ...show(f.summary),
        ...show(f.date),
        ...show(f.classification),
        ...show(f.country),
        ...show(f.link),
      },
      // Each filter allows several values at once (OR), with counts for the others kept
      disjunctiveFacets: f.facets.map((x) => x.field),
      facets: {
        ...Object.fromEntries(f.facets.map((x) => [x.field, { type: "value", size: 30 }])),
        [f.date]: {
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
    // Dropdown under the search box while typing. Keyword prefix match on the message
    // field, so it's cheap: no semantic/ELSER inference per keystroke.
    autocompleteQuery: {
      results: {
        resultsPerPage: 5,
        search_fields: { [f.message]: {} },
        result_fields: {
          [displayField(f.message)]: { snippet: { size: 100, fallback: true } },
          ...show(f.link),
        },
      },
    },
  };
}

const sortOptions = (f) => [
  { name: "Relevance", value: [] },
  { name: "Newest first", value: [{ field: f.date, direction: "desc" }] },
  { name: "Oldest first", value: [{ field: f.date, direction: "asc" }] },
];

const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "";

// Only render real web links (blocks javascript: and malformed values).
function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// Which message is open in the details pane.
const SelectionContext = createContext(null);
const useSelection = () => useContext(SelectionContext);

// Middle pane: one short summary per message. Click to open it on the right.
function MessageResult({ result }) {
  const f = useFields();
  const { selectedId, setSelectedId } = useSelection();
  const id = result.id?.raw;
  const cls = getField(result, displayField(f.classification));
  const country = getField(result, displayField(f.country));
  const selected = id === selectedId;
  return (
    <li className="msg-item">
      <button
        type="button"
        className={`msg${selected ? " msg--selected" : ""}`}
        aria-pressed={selected}
        onClick={() => setSelectedId(id)}
      >
        <span className="msg-meta">
          {cls && <span className={`badge badge--${f.badgeColors[String(cls).toLowerCase()] || "gray"}`}>{cls}</span>}
          {country && <span className="country">{country}</span>}
          <time>{fmtDate(getField(result, displayField(f.date)))}</time>
        </span>
        <span className="msg-text">{getField(result, displayField(f.summary))}</span>
      </button>
    </li>
  );
}

// Turn a document into a flat list of [name, value] rows, e.g. geo.country = "DE".
function flattenAttributes(value, prefix = "", out = []) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) flattenAttributes(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    const text = Array.isArray(value)
      ? value.map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ")
      : value === null || value === undefined ? "" : String(value);
    if (text !== "") out.push([prefix, text]);
  }
  return out;
}

// Right pane: every attribute of the open message, then the full message text.
function MessageDetails() {
  const f = useFields();
  const { results } = useSearch();
  const { selectedId, setSelectedId } = useSelection();
  const result = results.find((r) => r.id?.raw === selectedId);

  // Esc closes the pane
  useEffect(() => {
    if (!result) return;
    const onKey = (e) => e.key === "Escape" && setSelectedId(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [result, setSelectedId]);

  if (!result) {
    return (
      <aside className="details details--empty" aria-label="Message details">
        <p>Select a message to see its details.</p>
      </aside>
    );
  }

  const source = result._meta?.rawHit?._source ?? {};
  const messageField = displayField(f.message);
  const dateField = displayField(f.date);
  const linkField = displayField(f.link);
  const lead = [displayField(f.classification), displayField(f.country), dateField];
  const rank = (name) => (lead.includes(name) ? lead.indexOf(name) : lead.length);
  const rows = flattenAttributes(source)
    .filter(([name]) => name !== messageField)
    .sort((x, y) => rank(x[0]) - rank(y[0]) || x[0].localeCompare(y[0]));

  const renderValue = (name, value) => {
    if (name === dateField) return fmtDate(value) || value;
    const url = name === linkField ? safeUrl(value) : null;
    return url ? <a href={url.href} target="_blank" rel="noopener noreferrer">{value}</a> : value;
  };

  return (
    <aside className="details details--open" aria-label="Message details">
      <header className="details-head">
        <h2>Message details</h2>
        <button type="button" className="details-close" onClick={() => setSelectedId(null)}>Close</button>
      </header>
      <dl className="details-attrs">
        {f.showId && <div><dt>id</dt><dd>{result.id?.raw}</dd></div>}
        {rows.map(([name, value]) => (
          <div key={name}><dt>{name}</dt><dd>{renderValue(name, value)}</dd></div>
        ))}
      </dl>
      <h3>Message</h3>
      <p className="details-message">{getField(result, messageField)}</p>
    </aside>
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

// Custom date range: two date pickers that set a range filter on the date field.
// Dates are taken in the viewer's local time zone, from 00:00 on "From" to 23:59 on "To".
const CUSTOM_RANGE = "Custom range";

function DateRangeFilter() {
  const { date: dateField } = useFields();
  const { filters, setFilter, removeFilter } = useSearch();
  const active = filters
    .find((x) => x.field === dateField)
    ?.values.find((v) => v?.name === CUSTOM_RANGE);

  const [from, setFrom] = useState(active?.fromDay ?? "");
  const [to, setTo] = useState(active?.toDay ?? "");
  const invalid = from && to && from > to;

  const apply = () => {
    if (invalid || (!from && !to)) return;
    const value = { name: CUSTOM_RANGE, fromDay: from, toDay: to };
    if (from) value.from = new Date(`${from}T00:00:00`).toISOString();
    if (to) value.to = new Date(`${to}T23:59:59.999`).toISOString();
    setFilter(dateField, value, "all"); // replaces any other date filter
  };

  const clear = () => {
    setFrom("");
    setTo("");
    if (active) removeFilter(dateField, active, "all");
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

function SearchApp({ fields: f }) {
  const config = useMemo(() => buildConfig(f), [f]);
  const sorts = useMemo(() => sortOptions(f), [f]);
  const [selectedId, setSelectedId] = useState(null);
  const selection = useMemo(() => ({ selectedId, setSelectedId }), [selectedId]);
  return (
    <FieldsContext.Provider value={f}>
    <SelectionContext.Provider value={selection}>
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
                        titleField: displayField(f.message),
                        urlField: f.link ? displayField(f.link) : undefined,
                        linkTarget: "_blank",
                        shouldTrackClickThrough: false,
                      }}
                    />
                    <ThemeToggle />
                  </div>
                }
                sideContent={
                  <div>
                    {wasSearched && <Sorting label="Sort by" sortOptions={sorts} />}
                    {f.facets.map((x) => (
                      <Facet
                        key={x.field}
                        field={x.field}
                        label={x.label}
                        filterType="any"
                        isFilterable={x.searchable}
                      />
                    ))}
                    <Facet field={f.date} label="Published" />
                    <DateRangeFilter />
                  </div>
                }
                bodyContent={
                  <div className="panes">
                    <section className="feed" aria-label="Message feed">
                      <div className="feed-head">
                        {wasSearched && <PagingInfo />}
                        {wasSearched && <ResultsPerPage />}
                      </div>
                      <Results resultView={MessageResult} />
                      <Paging />
                    </section>
                    <MessageDetails />
                  </div>
                }
              />
            </ErrorBoundary>
          </div>
        )}
      </WithSearch>
    </SearchProvider>
    </SelectionContext.Provider>
    </FieldsContext.Provider>
  );
}

// Load field names from the server, then start the search UI.
export default function App() {
  const [fields, setFields] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((cfg) => setFields(cfg.fields))
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="app-status">Could not load configuration ({error}).</p>;
  if (!fields) return <p className="app-status">Loading…</p>;
  return <SearchApp fields={fields} />;
}
