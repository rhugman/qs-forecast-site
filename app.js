/* qs-forecast dashboard. Plain JS, no build step. Reads data/index.json, data/<slug>.json, data/weather.json
   and data/skill.json written by scripts/08_forecast.py and scripts/08b_site_skill.py, data/hindcast/<slug>.json by
   scripts/07b_site_hindcast.py; methods.md at the root.
   Three tiers (docs/dashboard-ui-review.md): the overview (map + the selected well's chart), the site page (details in
   collapsed sections), the expert pages. Plain words in the interface (LABELS), the technical term one tier away.
   Chart colours follow qsfc/plot_style.py; the outlook scale (PCT_CLASSES) shares no swatch with them. */
'use strict';

const REPO_URL = 'https://github.com/rhugman/qs-forecast-site';  // the public site repo; the code repo is private
const COLOURS = {
  obs: '#222222', median: '#1f5fa8', band: '#1f5fa8', members: '#b0b0b0', climatology: '#8c8c8c',
  reference: '#c8402d', nowcast: '#2a8f4e', anchor: '#e08a1e',
};
const SECTOR_COLOURS = { west: COLOURS.median, east: COLOURS.reference, uncertain: COLOURS.anchor };
const VARIANCE_COLOURS = { weather: COLOURS.median, parameter: COLOURS.anchor, noise: COLOURS.climatology, realisation: COLOURS.nowcast };
// Outlook: the season-end median's percentile among the site's own past season ends; class upper bounds. The colours
// are style.css --o0..--o4, a dry-to-wet scale that shares no swatch with the chart series.
const PCT_CLASSES = [
  { max: 10, cls: 'o0', colour: '#a4462c', label: 'much lower than usual' },
  { max: 30, cls: 'o1', colour: '#d09a4a', label: 'lower than usual' },
  { max: 70, cls: 'o2', colour: '#a3aaa8', label: 'near usual' },
  { max: 90, cls: 'o3', colour: '#5e9db1', label: 'higher than usual' },
  { max: 101, cls: 'o4', colour: '#2e6a86', label: 'much higher than usual' },
];
// Plain words in the interface; the technical term (dips, anchor, p50, head) lives in the methods page and the tooltips.
const LABELS = {
  dips: 'Measurements (SNIRH)', anchor: 'Last measurement', fit: 'Model fit on observed weather',
  corrected: 'Model fit + last-measurement correction (what the forecast continues from)',
  median: 'Forecast median', band90: 'Likely range, 90 %', band50: 'Likely range, 50 %',
  clim: 'Usual range for the time of year, 5-95 %', climMedian: 'Usual level for the time of year',
  head: 'Groundwater level (m above sea level)', today: 'today', seasonEnd: 'season end',
  gapModel: 'Model since the last measurement', p2080: 'P20 / P80', dry: 'P20, dry case',
};
const Z90 = 1.645, Z50 = 0.674;  // standard-normal quantiles of the 90 % and 50 % central intervals (the gap band)
const SECTOR_NAMES = { west: 'west of the aquifer', east: 'east of the aquifer', uncertain: 'near the fault' };
const ROLE_NAMES = { product: 'verified forecast', candidate: 'not yet verified' };  // config/sites.yml role, in words
const ROLE_TITLES = { product: 'product: passed the hindcast gate (Skill)', candidate: 'candidate: shown with its own band, no skill claim yet' };
const ORIGIN_NAMES = { 4: '1 Apr origin (drawdown to 30 Sep)', 10: '1 Oct origin (recovery to 31 Mar)' };
const SOURCES = [
  { name: 'SNIRH', what: 'groundwater levels (APA)', url: 'https://snirh.apambiente.pt/', licence: 'public data, APA' },
  { name: 'ERA5-Land', what: 'daily rain and ET0 via Copernicus / Google Earth Engine', url: 'https://cds.climate.copernicus.eu/', licence: 'Copernicus licence' },
  { name: 'Open-Meteo', what: 'ERA5 gap fill and ECMWF EC46 / SEAS5 members', url: 'https://open-meteo.com/', licence: 'CC BY 4.0, non-commercial' },
  { name: 'ECMWF open data', what: 'EC46 and SEAS5 forecasts', url: 'https://www.ecmwf.int/en/forecasts/datasets/open-data', licence: 'CC BY 4.0' },
  { name: 'pastas', what: 'transfer-function-noise models', url: 'https://pastas.dev/', licence: 'MIT' },
  { name: 'OpenStreetMap', what: 'map tiles', url: 'https://www.openstreetmap.org/copyright', licence: 'ODbL' },
];
const PLOT_CONFIG = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d'] };
const PLOT_FONT = { family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif', size: 12, color: '#222222' };
const DAY_MS = 86400000;
const Y_PAD = 0.06;  // fraction of the visible data range added above and below when a range button sets the y axis
const FILL_COLOURS = { observed: COLOURS.obs, era5_scaled: COLOURS.nowcast, feed_control: COLOURS.anchor };  // weather.json filled_from
const FILL_LABELS = { observed: 'ERA5-Land', era5_scaled: 'ERA5 scaled fill', feed_control: 'EC46 control fill' };
const siteCache = new Map();  // slug -> Promise of data/<slug>.json, fetched once per page (the overview and the hindcast explorer)

// ------------------------------------------------------------------------------------------ helpers
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  if (children) for (const c of children) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}
function fmt(x, d) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return 'n/a';
  return Number(x).toFixed(d === undefined ? 2 : d);
}
function fmtSigned(x, d) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return 'n/a';
  const s = Number(x).toFixed(d === undefined ? 2 : d);
  return Number(x) > 0 ? '+' + s : s;
}
function fmtPct(x) { return x === null || x === undefined ? 'n/a' : Math.round(Number(x)) + '%'; }
function ordinal(n) { const k = Math.round(Number(n)), r = k % 100, d = k % 10; return k + (r >= 11 && r <= 13 ? 'th' : d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th'); }
function fmtUTC(iso) { return iso ? iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC').replace(/Z$/, ' UTC') : 'n/a'; }
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function pctClass(p) {
  for (const c of PCT_CLASSES) if (p < c.max) return c;
  return PCT_CLASSES[PCT_CLASSES.length - 1];
}
function pctColour(p) { return p === null || p === undefined ? '#cccccc' : pctClass(Number(p)).colour; }
function addDays(iso, n) { return new Date(Date.parse(iso) + n * DAY_MS).toISOString().slice(0, 10); }
function dayOfYear(iso) {
  const d = new Date(iso);
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS) + 1;
}
function dateRange(first, last) {
  const out = [];
  for (let t = Date.parse(first); t <= Date.parse(last); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
function median(values) {
  const v = values.filter((x) => x !== null && x !== undefined && Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
function roleBadge(role) { return el('span', { class: 'badge ' + role, text: ROLE_NAMES[role] || role, title: ROLE_TITLES[role] || '' }); }
function slugOK(slug) { return /^[0-9]+-[0-9]+$/.test(slug || ''); }
// A {date_start, n, step_days} block (qsfc.pipeline.compact_daily) expanded to ISO dates.
function expandDaily(block) {
  const out = [];
  const t0 = Date.parse(block.date_start), step = (block.step_days || 1) * DAY_MS;
  for (let i = 0; i < block.n; i += 1) out.push(new Date(t0 + i * step).toISOString().slice(0, 10));
  return out;
}
// [lo, hi] of the y values whose ISO date lies in [x0, x1] over several {x, y} series, padded; null when empty.
function yRange(series, x0, x1, pad) {
  let lo = Infinity, hi = -Infinity;
  for (const s of series) {
    if (!s || !s.x || !s.y) continue;
    for (let i = 0; i < s.x.length; i += 1) {
      const v = s.y[i];
      if (s.x[i] < x0 || s.x[i] > x1 || v === null || v === undefined || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo)) return null;
  const span = hi - lo || 1;
  return [lo - pad * span, hi + pad * span];
}
// Wire a segmented control (<span class="seg"> of buttons with data-range); calls onSelect(key) and marks the button.
function segButtons(id, initial, onSelect) {
  const seg = document.getElementById(id);
  if (!seg) return;
  const buttons = [...seg.querySelectorAll('button[data-range]')];
  const mark = (key) => buttons.forEach((b) => { b.classList.toggle('on', b.dataset.range === key); b.setAttribute('aria-pressed', b.dataset.range === key); });
  seg._onSelect = onSelect;  // replaced on every call, so a chart redrawn into the same page takes the buttons over
  if (!seg.dataset.wired) {
    seg.dataset.wired = '1';
    buttons.forEach((b) => b.addEventListener('click', () => { mark(b.dataset.range); seg._onSelect(b.dataset.range); }));
  }
  mark(initial);
}
function hasPlot(id) { const n = document.getElementById(id); return Boolean(n && n.data); }

async function loadJSON(path) {
  const resp = await fetch(path, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
  return resp.json();
}
async function loadText(path) {
  const resp = await fetch(path, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`${path}: HTTP ${resp.status}`);
  return resp.text();
}
function showStatus(msg) {
  const node = document.getElementById('status');
  if (!node) return;
  node.textContent = msg;
  node.hidden = false;
}
function fail(err) {
  let msg = `Could not load the dashboard data (${err && err.message ? err.message : err}).`;
  if (location.protocol === 'file:') {
    msg += ' Browsers block fetch() of local files from a file:// page. Serve the site directory instead, '
      + 'for example "python -m http.server" inside site/ and open http://localhost:8000/.';
  }
  showStatus(msg);
  console.error(err);
}
function libMissing(id, lib) {
  const node = document.getElementById(id);
  if (node) node.innerHTML = `<div class="plot-note">${lib} did not load from its CDN, so this panel cannot be drawn. The data are still in the tables and JSON files.</div>`;
}

// ------------------------------------------------------------------------------------------ shared blocks
function renderFooter(index) {
  const node = document.getElementById('footer');
  if (!node) return;
  const src = SOURCES.map((s) => `<a href="${s.url}">${s.name}</a> (${s.what}; ${s.licence})`).join('; ');
  const stamp = index && index.generated_utc ? `Last updated ${fmtUTC(index.generated_utc)} (issue ${index.issue_date}).` : 'Last updated: not available.';
  node.innerHTML = `<div class="inner">
    <p><strong>Data sources and licences.</strong> ${src}.</p>
    <p>Research demonstration, non-commercial and unofficial. Provided as is, without warranty of any kind; the forecasts are
       probabilistic model output, not measurements, and not a decision product. Dashboard source: <a href="${REPO_URL}">${REPO_URL.replace('https://', '')}</a>.</p>
    <p>${stamp}</p></div>`;
}

function feedSummary(prov) {
  const feeds = prov.feeds || {};
  const parts = [];
  for (const key of Object.keys(feeds)) {
    const f = feeds[key];
    parts.push(`${f.model || key} (${f.n_members} members, days ${f.first_date} to ${f.last_date}, fetched ${fmtUTC(f.fetched_utc)})`);
  }
  const corr = prov.correction === 'none' ? 'not bias-corrected' : `bias correction: ${prov.correction}`;
  return { feeds: parts.join('; spliced at ' + (prov.splice_join || 'n/a') + ' onto '), correction: corr };
}

function renderProvenance(prov, target) {
  const node = document.getElementById(target);
  if (!node || !prov) return;
  const gf = prov.gap_fill || {};
  const fs = feedSummary(prov);
  const rows = [
    ['Issue date', prov.issue_date],
    ['Observed forcing (ERA5-Land) to', prov.observed_last_day],
    ['Gap fill', gf.window ? `${gf.model || 'era5'} scaled ${gf.era5_scaled ? gf.era5_scaled.first + ' to ' + gf.era5_scaled.last : 'n/a'}; feed control run ${gf.feed_control ? gf.feed_control.first + ' to ' + gf.feed_control.last : 'n/a'} (${gf.n_days} d)` : 'none'],
    ['Weather members', fs.feeds],
    ['Correction', fs.correction + (prov.correction === 'none' ? ' (raw model members)' : '')],
    ['Horizon', prov.horizon ? `${prov.horizon[0]} to ${prov.horizon[1]}` : 'n/a'],
    ['Parameter samples per member', prov.n_param],
    ['pastas', prov.pastas],
    ['Pipeline commit', prov.git_commit ? `<code>${String(prov.git_commit).slice(0, 12)}</code>` : 'n/a'],
    ['Feed licence', prov.licence],
  ];
  const dl = el('dl', { class: 'kv' });
  for (const [k, v] of rows) {
    dl.appendChild(el('dt', { text: k }));
    dl.appendChild(el('dd', { html: v === undefined || v === null ? 'n/a' : String(v) }));
  }
  node.innerHTML = '';
  node.appendChild(dl);
}

function setText(id, text) { const n = document.getElementById(id); if (n) n.textContent = text; }

// ------------------------------------------------------------------------------------------ index page
// The overview: a map of the wells coloured by outlook and, beside it, the selected well's headline numbers and chart.
// Selection is state: a marker click, a table row, the up and down arrow keys and ?site= in the URL all go through
// selectSite; the marker ring, the table row and the URL follow.
const overview = { sites: [], order: [], slug: null, range: '1y', fan: null, map: null, table: null };

async function pageIndex() {
  const index = await loadJSON('data/index.json');
  const sites = index.sites || [];
  const prov = index.provenance || {};
  renderFooter(index);
  renderStatusLine(index, sites);
  const fs = feedSummary(prov);
  setText('feed-line', `${fs.feeds}. ${fs.correction.charAt(0).toUpperCase() + fs.correction.slice(1)}.`);
  const gf = prov.gap_fill || {};
  setText('gapfill-line', `Observed forcing to ${prov.observed_last_day}; gap-filled with ${gf.model || 'era5'} (scaled) `
    + `${gf.era5_scaled ? gf.era5_scaled.first + ' to ' + gf.era5_scaled.last : 'n/a'} and the feed control run `
    + `${gf.feed_control ? gf.feed_control.first + ' to ' + gf.feed_control.last : 'n/a'}. Horizon ${prov.horizon ? prov.horizon[0] + ' to ' + prov.horizon[1] : 'n/a'}.`);
  renderProvenance(prov, 'provenance');

  overview.sites = sites;
  overview.order = outlookOrder(sites).map((s) => s.slug);
  overview.map = renderMap(sites);
  overview.table = renderSiteTable(sites);
  const seg = document.getElementById('fan-range');
  if (seg) seg.addEventListener('click', (e) => { const b = e.target.closest('button[data-range]'); if (b) overview.range = b.dataset.range; });
  document.addEventListener('keydown', (e) => {
    if (['SELECT', 'INPUT', 'TEXTAREA'].includes((e.target && e.target.tagName) || '') || !overview.order.length) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const i = overview.order.indexOf(overview.slug);
    const j = Math.min(Math.max(i + (e.key === 'ArrowDown' ? 1 : -1), 0), overview.order.length - 1);
    if (j !== i) { selectSite(overview.order[j]); e.preventDefault(); }
  });
  const wanted = new URLSearchParams(location.search).get('site');
  const bySlug = new Map(sites.map((s) => [s.slug, s]));
  const first = overview.order.find((slug) => bySlug.get(slug).role === 'product') || overview.order[0];
  const start = bySlug.has(wanted) ? wanted : first;
  if (start) await selectSite(start);
}

// Wells from the lowest to the highest outlook (season-end percentile), the ones without an outlook last, then by id.
function outlookOrder(sites) {
  const missing = (p) => p === null || p === undefined;
  return [...sites].sort((a, b) => {
    const pa = a.season_end_percentile, pb = b.season_end_percentile;
    if (missing(pa) !== missing(pb)) return missing(pa) ? 1 : -1;
    return (missing(pa) ? 0 : pa - pb) || a.site_id.localeCompare(b.site_id);
  });
}

// One line under the heading: issue date, season end, age of the measurements, wells.
function renderStatusLine(index, sites) {
  const node = document.getElementById('status-line');
  if (!node) return;
  const ages = sites.map((s) => s.anchor_age_days).filter((a) => a !== null && a !== undefined);
  const dips = sites.map((s) => s.last_dip).filter(Boolean).sort();
  const prov = index.provenance || {};
  const nProduct = sites.filter((s) => s.role === 'product').length;
  const parts = [
    `Issued <b>${index.issue_date}</b>`,
    sites.length ? `season ends <b>${sites[0].season_end}</b>${prov.horizon ? ` (forecast to ${prov.horizon[1]})` : ''}` : null,
    dips.length ? `measurements to <b>${dips[dips.length - 1]}</b> (${Math.min(...ages)} to ${Math.max(...ages)} days before issue)` : null,
    `<b>${sites.length}</b> wells, ${nProduct} verified`,
  ].filter(Boolean);
  node.innerHTML = parts.join('<span class="sep">&middot;</span>');
}

function outlookChip(p) {
  if (p === null || p === undefined || Number.isNaN(Number(p))) return el('span', { class: 'chip none', text: 'no outlook' });
  const c = pctClass(Number(p));
  return el('span', { class: 'chip ' + c.cls, text: c.label, title: `season-end median at the ${ordinal(p)} percentile of the well's past season ends` });
}

// Map: one circle marker per well filled by outlook class, a dashed outline for the wells not yet verified, a ring on
// the selected well. Returns {highlight(slug)}.
function renderMap(sites) {
  const mapNode = document.getElementById('map');
  if (typeof L === 'undefined') {
    mapNode.innerHTML = '<div class="map-note">Leaflet did not load from its CDN; the list below carries the same information.</div>';
    return { highlight: () => {} };
  }
  const map = L.map('map', { scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const markers = [];
  const ring = L.circleMarker([0, 0], { radius: 14, color: COLOURS.obs, weight: 2.5, fill: false, interactive: false });
  for (const s of sites) {
    const product = s.role === 'product';
    const m = L.circleMarker([s.lat, s.lon], {
      radius: product ? 9 : 7, color: COLOURS.obs, weight: product ? 1.5 : 1.2, dashArray: product ? null : '3 3',
      fillColor: pctColour(s.season_end_percentile), fillOpacity: 0.92,
    });
    const known = s.season_end_percentile !== null && s.season_end_percentile !== undefined;
    m.bindTooltip(`${s.site_id} &middot; ${known ? pctClass(Number(s.season_end_percentile)).label : 'no outlook'}${product ? '' : ' &middot; not yet verified'}`);
    m.on('click', () => selectSite(s.slug));
    m.addTo(map);
    markers.push(m);
  }
  const fit = () => {
    if (markers.length) map.fitBounds(L.featureGroup(markers).getBounds().pad(0.2));
    else map.setView([37.2, -8.25], 11);
  };
  // A container that has no size yet (hidden tab, pane not laid out) would fit to zoom 0; wait for it.
  if (mapNode.clientWidth > 0) fit();
  else if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { if (mapNode.clientWidth > 0) { fit(); ro.disconnect(); } });
    ro.observe(mapNode);
  } else fit();
  map.whenReady(() => { map.invalidateSize(); fit(); });  // the pane's final size may arrive after the map is created

  const legend = document.getElementById('map-legend');
  if (legend) {
    legend.innerHTML = '';
    legend.appendChild(el('span', { text: 'Outlook at the season end:' }));
    for (const c of PCT_CLASSES) {
      const sw = el('span', { class: 'sw' });
      sw.style.background = c.colour;
      legend.appendChild(el('span', {}, [sw, c.label]));
    }
    const cnd = el('span', { class: 'sw dashed' }); cnd.style.background = '#ffffff';
    legend.appendChild(el('span', {}, [cnd, 'not yet verified']));
    const sel = el('span', { class: 'sw ring' }); sel.style.background = '#ffffff';
    legend.appendChild(el('span', {}, [sel, 'selected']));
  }
  return {
    leaflet: map,
    fit,
    highlight: (slug) => {
      const s = sites.find((x) => x.slug === slug);
      if (!s) { if (map.hasLayer(ring)) map.removeLayer(ring); return; }
      ring.setLatLng([s.lat, s.lon]);
      if (!map.hasLayer(ring)) ring.addTo(map);
    },
  };
}

// The selected well: headline numbers at once, then the compact chart from data/<slug>.json (fetched once, cached).
async function selectSite(slug) {
  const s = overview.sites.find((x) => x.slug === slug);
  if (!s) return;
  overview.slug = slug;
  history.replaceState(null, '', `?site=${slug}`);
  overview.map.highlight(slug);
  overview.table.highlight(slug);
  renderSelectedHead(s);
  let d;
  try {
    d = await loadSite(slug);
  } catch (err) {
    console.warn(err);
    const fan = document.getElementById('fan');
    if (fan) { if (fan.data) Plotly.purge(fan); fan.innerHTML = `<div class="plot-note">Could not load data/${slug}.json (${err.message}).</div>`; }
    return;
  }
  if (overview.slug !== slug) return;  // another well was chosen while this one loaded
  overview.fan = renderFanChart(d, { compact: true, initial: overview.range });
  const nMembers = d.provenance && d.provenance.feeds ? Object.values(d.provenance.feeds)[0].n_members : null;
  setText('sel-note', `Measurements (black) to the last one on ${d.anchor.last_dip}, ${d.anchor.age_days} days before issue; the dashed line `
    + 'carries the model over the gap since then, inside a range that grows from zero on that day with the residual noise; from today, '
    + `the forecast median (blue) with its 50 % and 90 % likely ranges, which pool ${nMembers ? nMembers + ' ' : ''}weather members, model `
    + 'parameter samples and that same noise. The model fit and the full record are on the well\'s page.');
}

function renderSelectedHead(s) {
  const title = document.getElementById('sel-title'), chip = document.getElementById('sel-chip'), sub = document.getElementById('sel-sub');
  const link = document.getElementById('sel-link'), figs = document.getElementById('sel-figures');
  if (title) title.textContent = `Well ${s.site_id}`;
  if (chip) { const c = outlookChip(s.season_end_percentile); c.id = 'sel-chip'; chip.replaceWith(c); }
  if (sub) sub.textContent = `${SECTOR_NAMES[s.sector] || s.sector}${s.role === 'product' ? '' : ' · not yet verified'}`;
  if (link) { link.href = `site.html?site=${s.slug}`; link.hidden = false; }
  if (figs) {
    figs.innerHTML = '';
    const known = s.season_end_percentile !== null && s.season_end_percentile !== undefined;
    const items = [
      ['Last measured', `${fmt(s.last_head_masl, 1)} m`, `${s.last_dip}, ${s.anchor_age_days} days before issue`],
      [`Season end ${s.season_end}, median`, `${fmt(s.season_end_p50, 1)} m`, `likely ${fmt(s.season_end_p05, 1)} to ${fmt(s.season_end_p95, 1)} m (90 %)`],
      s.season_end_p20 === undefined || s.season_end_p20 === null ? null
        : [LABELS.dry, `${fmt(s.season_end_p20, 1)} m`, '80 % chance the level stays above'],
      ['Against past years', known ? ordinal(s.season_end_percentile) : 'n/a', 'percentile of the well’s past season-end levels'],
    ].filter(Boolean);
    for (const [k, v, t] of items) figs.appendChild(el('div', {}, [el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }), el('span', { class: 's', text: t })]));
  }
}

// ------------------------------------------------------------------------------------------ site data
// data/<slug>.json fetched once per page; a failed fetch is forgotten so the next click retries.
function loadSite(slug) {
  if (!siteCache.has(slug)) siteCache.set(slug, loadJSON(`data/${slug}.json`).catch((err) => { siteCache.delete(slug); throw err; }));
  return siteCache.get(slug);
}

// {x, y} of a {date_start, n, step_days, values} block (qsfc.pipeline.compact_daily) from the ISO day x0 on.
function sliceDaily(block, x0) {
  const t0 = Date.parse(block.date_start), step = (block.step_days || 1) * DAY_MS;
  const x = [], y = [];
  for (let i = Math.max(0, Math.ceil((Date.parse(x0) - t0) / step)); i < block.n; i += 1) {
    x.push(new Date(t0 + i * step).toISOString().slice(0, 10));
    y.push(block.values[i]);
  }
  return { x, y };
}

// The well list: one row per well from the lowest to the highest outlook; a click selects it above. Returns {highlight(slug)}.
function renderSiteTable(sites) {
  const tbody = document.querySelector('#site-table tbody');
  if (!tbody) return { highlight: () => {} };
  tbody.innerHTML = '';
  const rows = new Map();
  for (const s of outlookOrder(sites)) {
    const tr = el('tr', { class: `selectable ${s.role}`, tabindex: '0' });
    const well = el('td', {}, [el('a', { href: `site.html?site=${s.slug}`, text: s.site_id })]);
    if (s.role !== 'product') well.appendChild(el('span', { class: 'tag', text: 'not yet verified' }));
    tr.appendChild(well);
    tr.appendChild(el('td', { text: SECTOR_NAMES[s.sector] || s.sector }));
    tr.appendChild(el('td', { text: `${s.last_dip} (${s.anchor_age_days} d)` }));
    tr.appendChild(el('td', { class: 'num', text: fmt(s.season_end_p50, 1) }));
    tr.appendChild(el('td', { class: 'num', text: `${fmt(s.season_end_p05, 1)} to ${fmt(s.season_end_p95, 1)}` }));
    tr.appendChild(el('td', {}, [outlookChip(s.season_end_percentile)]));
    tr.addEventListener('click', (e) => { if (e.target.tagName !== 'A') selectSite(s.slug); });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { selectSite(s.slug); e.preventDefault(); } });
    tbody.appendChild(tr);
    rows.set(s.slug, tr);
  }
  return { highlight: (slug) => { for (const [k, tr] of rows) tr.classList.toggle('selected', k === slug); } };
}

// ------------------------------------------------------------------------------------------ site page
async function pageSite() {
  const slug = new URLSearchParams(location.search).get('site');
  let index = null;
  try { index = await loadJSON('data/index.json'); } catch (e) { console.warn(e); }
  renderFooter(index);
  if (!slugOK(slug)) {
    const list = document.getElementById('site-list');
    setText('site-title', 'Choose a well');
    if (index && list) {
      for (const s of index.sites) list.appendChild(el('li', {}, [el('a', { href: `site.html?site=${s.slug}`, text: `${s.site_id} (${s.sector}, ${s.role})` })]));
      list.hidden = false;
    }
    document.getElementById('site-body').hidden = true;
    return;
  }
  const d = await loadJSON(`data/${slug}.json`);
  document.title = `Well ${d.site_id} - Querça-Silves groundwater outlook`.replace('Querça', 'Querença');
  setText('site-title', `Well ${d.site_id}`);
  const badges = document.getElementById('site-badges');
  badges.appendChild(roleBadge(d.role));
  badges.appendChild(el('span', { class: 'badge', text: SECTOR_NAMES[d.sector] || d.sector }));
  badges.appendChild(outlookChip(d.season.p50_percentile_vs_history));

  renderSiteCards(d, null);
  renderResiduals(d);
  const fan = renderFanChart(d);
  renderScenarios(d, fan);
  renderVariance(d);
  renderSiteDetails(d);
  renderProvenance(d.provenance, 'provenance');
  // Plotly draws into a zero-size box inside a closed <details>; size the plots of a section when it opens.
  for (const sec of document.querySelectorAll('details.tier')) {
    sec.addEventListener('toggle', () => {
      if (sec.open && typeof Plotly !== 'undefined') sec.querySelectorAll('.plot').forEach((n) => { if (n.data) Plotly.Plots.resize(n); });
    });
  }
  const hcLink = document.getElementById('hindcast-link');
  if (hcLink) {
    const entry = index && index.sites ? index.sites.find((s) => s.slug === slug) : null;
    if (entry && entry.hindcast) hcLink.href = `hindcast.html?site=${slug}`;
    else setText('hindcast-line', 'No hindcast file for this site yet (scripts/07b_site_hindcast.py runs locally after the hindcast).');
  }
}

// Headline figures: the default band's numbers, or a pumping scenario's (`scen`: an entry of d.scenarios.runs) for the
// season end, tagged with the scenario. The horizon end and the extremes are in the season summary table.
function renderSiteCards(d, scen) {
  const node = document.getElementById('site-cards');
  const a = d.anchor, se = d.season;
  const tag = scen && !scen.is_default ? ` (scenario: ${SCENARIO_NAMES[scen.irrigation] || scen.irrigation} irrigation, ${ADA_NAMES[scen.ada] || scen.ada} public supply)` : '';
  const end = scen ? scen.season_end : se;
  const pct = scen ? scen.season_end.p50_percentile_vs_history : se.p50_percentile_vs_history;
  const known = pct !== null && pct !== undefined;
  const cards = [
    ['Last measured', `${fmt(a.head_masl, 1)} m`, `${a.last_dip}, ${a.age_days} days before issue`],
    [`Season end ${se.end_date}, median${tag}`, `${fmt(end.p50, 1)} m`, `likely ${fmt(end.p05, 1)} to ${fmt(end.p95, 1)} m (90 %); ${fmt(end.p25, 1)} to ${fmt(end.p75, 1)} m (50 %)`],
    end.p20 === undefined || end.p20 === null ? null : [LABELS.dry + tag, `${fmt(end.p20, 1)} m`, '80 % chance the level stays above'],
    ['Against past years' + tag, known ? ordinal(pct) : 'n/a', known ? `percentile of ${se.n_history} past season-end levels: ${pctClass(Number(pct)).label}` : `no season-end history`],
  ].filter(Boolean);
  node.innerHTML = '';
  for (const [k, v, t] of cards) node.appendChild(el('div', {}, [el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }), el('span', { class: 's', text: t })]));
}

// Pumping scenario selector (docs/plan.md step 14): irrigation level x AdA level; the fan chart's bands and the season-end
// cards follow the selection. The default (inferred x baseline) is the published band; a site whose model has no pumping
// term (m = 0, no separate stress) has six identical bands and the selector is greyed out.
const ADA_NAMES = { baseline: 'baseline', drought: 'drought draw' };
const SCENARIO_NAMES = { floor: 'reporting floor', inferred: 'inferred (central)', all_parcels: 'all parcels' };  // irrigation level (share of the crop-water-balance demand)
const SWITCH_NAMES = { arade: 'Arade storage', spi24: '24-month rain' };  // pumping.switch.indicator (docs/plan.md step 15)
const LEVEL_TEXT = {
  constant: 'constant: the 2024 irrigated footprint applied to every year',
  footprint: 'footprint: the crop-water-balance draw x the remote-sensing extent index over its 2022-2024 mean (rs_level, 0.54-1.10 over 2000-2024); 1.0 over the horizon',
};
function renderScenarios(d, fan) {
  const box = document.getElementById('scenario-controls'), text = document.getElementById('scenario-text');
  const sc = d.scenarios;
  if (!box || !sc || !sc.runs) { if (text) text.textContent = ''; return; }
  box.hidden = false;
  const state = { irrigation: sc.default.irrigation, ada: sc.default.ada };
  const group = (id, name, keys, defs, label) => {
    const fs = document.getElementById(id);
    for (const k of keys) {
      const input = el('input', { type: 'radio', name, value: k });
      if (k === state[name === 'scen-irr' ? 'irrigation' : 'ada']) input.checked = true;
      if (!sc.pumping_sensitive) input.disabled = true;
      input.addEventListener('change', () => { state[name === 'scen-irr' ? 'irrigation' : 'ada'] = k; apply(); });
      fs.appendChild(el('label', {}, [input, label(k, defs[k])]));
    }
  };
  group('scenario-irrigation', 'scen-irr', sc.order.irrigation, sc.irrigation, (k, v) => `${SCENARIO_NAMES[k] || k} (share ${fmt(v.share, 2)})`);
  group('scenario-ada', 'scen-ada', sc.order.ada, sc.ada, (k, v) => `${ADA_NAMES[k] || k}${v.ratio_to_baseline ? ` (${fmt(v.ratio_to_baseline, 1)} x the baseline${v.year ? ', ' + v.year : ''})` : ''}`);
  const def = sc.runs[sc.default.key];
  // The formulation line (docs/plan.md steps 14 and 15) stays ahead of the scenario line; old JSON without the text falls back to m.
  const m = sc.m_pump, pump = d.pumping || {};
  const formulation = sc.formulation_text || pump.formulation_text
    || `Pumping ${sc.formulation === 'net' ? `as negative recharge, m = ${fmt(m, 1)}` : `through a separate ${sc.formulation} stress`}`;
  const sw = pump.switch || null;
  const intro = `${formulation}. The irrigation level rescales the crop-water-balance draw${pump.level === 'footprint' ? ' (footprint level 1.0 over the horizon)' : ''}, `
    + `the public-supply level the AdA series${pump.mult_ada && pump.mult_ada !== m ? ` (weight ${fmt(pump.mult_ada, 1)})` : ''}`
    + (sw ? `; the drought-switching term (beta ${fmt(sw.beta, 1)} on the ${SWITCH_NAMES[sw.indicator] || sw.indicator} deficit) reads the all-parcel demand and is the same in every irrigation scenario` : '')
    + '. ';
  const apply = () => {
    const key = `${state.irrigation}_${state.ada}`;
    const run = sc.runs[key];
    if (!run) return;
    if (run.is_default) fan.setBand(d.forecast.date, d.forecast);
    else fan.setBand(sc.grid.dates, run);
    renderSiteCards(d, run.is_default ? null : run);
    const diff = run.season_end.p50 - def.season_end.p50;
    text.textContent = intro + (run.is_default
      ? `Default scenario: irrigation at the ${SCENARIO_NAMES[state.irrigation] || state.irrigation} level, public supply at its ${ADA_NAMES[state.ada]}; `
        + `this is the published band. Season-end median ${fmt(def.season_end.p50)} m.`
      : `Scenario ${SCENARIO_NAMES[state.irrigation] || state.irrigation} x AdA ${ADA_NAMES[state.ada]}: season-end median ${fmt(run.season_end.p50)} m, `
        + `${fmtSigned(diff)} m against the default (${fmt(def.season_end.p50)} m); 90 % band ${fmt(run.season_end.p05)} to ${fmt(run.season_end.p95)} m. `
        + `Bands on every ${sc.grid.step_days}nd day; same weather members, parameter samples and noise paths as the default.`);
  };
  if (!sc.pumping_sensitive) {
    box.classList.add('disabled');
    text.textContent = `No pumping scenario at this site: the dips do not carry a pumping signal the model could keep (m = 0, no pumping stress), `
      + 'so the six scenario bands are identical to the published band.';
    return;
  }
  apply();
}

function climatologyOnDates(clim, dates, key) {
  return dates.map((iso) => {
    const v = clim[key][dayOfYear(iso) - 1];
    return v === undefined ? null : v;
  });
}

// The anchor gap (overview chart): the model since the last measurement and the noise term around it. The segment is
// the record's corrected path (simulation + the anchor residual decayed), which runs from the last dip to the day before
// the forecast start, or the nowcast plus e0 exp(-t / tau) when the record is absent. The band is the forecast's own
// noise term grown from zero on the dip, sd(t) = sqrt(sigma2) k sqrt(1 - exp(-2 t / tau)), t days since the dip
// (qsfc.forecast: the published band's day h uses t = age + h, so the two join with one day of growth between them).
// Where the 1 April correction is applied the segment is shifted linearly from 0 on the dip to shift_first_day_m on the
// last day, so it meets the published band. Null on old JSON without the fields; sd null without sigma2, tau.
function anchorGap(d) {
  const a = d.anchor || {}, rec = d.record || {}, fc = d.forecast, nc = d.nowcast;
  if (!a.last_dip || !fc || !fc.date || !fc.date.length) return null;
  const lastBefore = addDays(fc.date[0], -1);
  const dayFrom = (iso) => Math.round((Date.parse(iso) - Date.parse(a.last_dip)) / DAY_MS);
  let x = [], y = [];
  if (rec.corrected && rec.corrected.date_start === a.last_dip) {
    const s = sliceDaily(rec.corrected, a.last_dip);
    x = s.x; y = s.y;
  } else if (nc && nc.date && a.e0_m !== undefined && a.tau_days) {
    nc.date.forEach((dt, i) => { if (dt >= a.last_dip) { x.push(dt); y.push(nc.head_masl[i] + a.e0_m * Math.exp(-dayFrom(dt) / a.tau_days)); } });
  } else return null;
  while (x.length && x[x.length - 1] > lastBefore) { x.pop(); y.pop(); }
  if (x.length < 2 || y.some((v) => v === null || v === undefined)) return null;
  const pp = d.postprocess || {};
  const shift = pp.applied && pp.shift_first_day_m ? Number(pp.shift_first_day_m) : 0;
  const n = x.length;
  const t = x.map(dayFrom);
  const seg = y.map((v, i) => v + shift * i / (n - 1));
  const sd = a.sigma2_m2 && a.tau_days
    ? t.map((ti) => Math.sqrt(a.sigma2_m2) * (a.noise_inflation || 1) * Math.sqrt(1 - Math.exp(-2 * ti / a.tau_days))) : null;
  const around = (z, sign) => (sd ? seg.map((v, i) => v + sign * z * sd[i]) : null);
  return { x, t, seg, sd, shift, lo90: around(Z90, -1), hi90: around(Z90, 1), lo50: around(Z50, -1), hi50: around(Z50, 1) };
}

// Fan chart. Full mode (site page): measurements, the model fit on observed forcing, the fit + last-measurement
// correction the forecast continues from, the forecast bands and median, the usual range for the time of year (head
// climatology, toggle) and the calibration window. Compact mode (overview): measurements, bands, median, today and
// the season end, nothing else (no model fit: the landing page shows what was measured and what is forecast). `record` (qsfc.pipeline.record_block) gives the full record; without it the chart
// falls back to the three-year dips and nowcast. Returns {setBand(dates, q)}: redraws the five band traces (p05, p95,
// p25, p75, p50) from another quantile set, as the pumping-scenario selector does; the y range follows the band shown.
function renderFanChart(d, opts) {
  const o = Object.assign({ target: 'fan', compact: false, rangeId: 'fan-range', climId: 'clim-toggle', residualId: 'residual', noteId: 'fan-note', initial: '1y' }, opts || {});
  const inert = { setBand: () => {} };
  if (typeof Plotly === 'undefined') { libMissing(o.target, 'Plotly'); return inert; }
  const node = document.getElementById(o.target);
  if (!node) return inert;
  if (node.data) Plotly.purge(node);
  node.innerHTML = '';
  const fc = d.forecast, nc = d.nowcast, clim = d.climatology, a = d.anchor, rec = d.record && d.record.simulation ? d.record : null;
  const hEnd = fc.date[fc.date.length - 1];
  const simX = rec ? expandDaily(rec.simulation) : nc.date;
  const simY = rec ? rec.simulation.values : nc.head_masl;
  const dips = rec ? rec.dips : d.dips;
  const corr = rec && rec.corrected && !o.compact ? { x: expandDaily(rec.corrected), y: rec.corrected.values } : null;
  const first = dips.date[0] < simX[0] ? dips.date[0] : simX[0];
  const dates = dateRange(first, hEnd);
  const climToggle = o.compact ? null : document.getElementById(o.climId);
  let climOn = Boolean(climToggle && climToggle.checked);
  const climName = `${LABELS.clim} (${clim.years[0]}-${clim.years[1]}, ${clim.n_dips} measurements, +/-${clim.window_days} d)`;
  const climBand = { p05: climatologyOnDates(clim, dates, 'p05'), p95: climatologyOnDates(clim, dates, 'p95') };
  const simName = rec
    ? `${LABELS.fit} (observed to ${rec.simulation.observed_to}, gap-filled to ${rec.simulation.last_day})`
    : `${LABELS.fit} (to ${nc.last_observed_day}, filled to ${nc.filled_to})`;
  const traces = [
    { x: dates, y: climBand.p05, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: 'clim', visible: climOn },
    { x: dates, y: climBand.p95, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(COLOURS.climatology, 0.22),
      name: climName, legendgroup: 'clim', visible: climOn, hovertemplate: 'usual range, upper %{y:.2f} m<extra></extra>' },
    { x: dates, y: climatologyOnDates(clim, dates, 'p50'), mode: 'lines', line: { width: 1, color: COLOURS.climatology, dash: 'dot' },
      name: LABELS.climMedian, legendgroup: 'clim', visible: climOn, hovertemplate: 'usual level %{y:.2f} m<extra></extra>' },
    { x: fc.date, y: fc.p05, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: 'b90' },
    { x: fc.date, y: fc.p95, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(COLOURS.band, 0.2), name: LABELS.band90, legendgroup: 'b90',
      hovertemplate: '90 % range, upper %{y:.2f} m<extra></extra>' },
    { x: fc.date, y: fc.p25, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: 'b50' },
    { x: fc.date, y: fc.p75, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(COLOURS.band, 0.45), name: LABELS.band50, legendgroup: 'b50',
      hovertemplate: '50 % range, upper %{y:.2f} m<extra></extra>' },
    { x: fc.date, y: fc.p50, mode: 'lines', line: { width: 2, color: COLOURS.median }, name: LABELS.median, hovertemplate: 'median %{y:.2f} m<extra></extra>' },
  ];
  // Band traces are 3..7 (p05, p95, p25, p75, p50) and, when the JSON carries them, 8..9 (p20, p80); the fit, the
  // corrected path, the measurements, the anchor and the gap follow.
  const hasP2080 = Array.isArray(fc.p20) && Array.isArray(fc.p80);
  if (hasP2080) traces.push(
    { x: fc.date, y: fc.p20, mode: 'lines', line: { width: 1, color: COLOURS.median, dash: 'dot' }, name: LABELS.p2080, legendgroup: 'p2080',
      hovertemplate: 'P20 %{y:.2f} m<extra></extra>' },
    { x: fc.date, y: fc.p80, mode: 'lines', line: { width: 1, color: COLOURS.median, dash: 'dot' }, showlegend: false, legendgroup: 'p2080',
      hovertemplate: 'P80 %{y:.2f} m<extra></extra>' },
  );
  if (!o.compact) traces.push({ x: simX, y: simY, mode: 'lines', line: { width: 1.3, color: COLOURS.nowcast }, name: simName, hovertemplate: 'model fit %{y:.2f} m<extra></extra>' });
  if (corr) traces.push({ x: corr.x, y: corr.y, mode: 'lines', line: { width: 1.5, color: COLOURS.median, dash: 'dash' },
    name: LABELS.corrected, hovertemplate: 'corrected %{y:.2f} m<extra></extra>' });
  traces.push({ x: dips.date, y: dips.head_masl, mode: 'markers', marker: { size: rec ? 4.5 : 6, color: COLOURS.obs },
    name: o.compact ? LABELS.dips : rec ? `${LABELS.dips} (${dips.n}, ${dips.date[0]} to ${dips.date[dips.date.length - 1]})` : `${LABELS.dips} (last 3 years)`,
    hovertemplate: 'measured %{y:.2f} m<extra></extra>' });
  traces.push({ x: [a.last_dip], y: [a.head_masl], mode: 'markers', marker: { size: 10, color: COLOURS.anchor, line: { color: COLOURS.obs, width: 1 } },
    name: o.compact ? LABELS.anchor : `${LABELS.anchor}: ${a.last_dip} (${a.age_days} d before issue)`, hovertemplate: 'last measurement %{y:.2f} m<extra></extra>' });
  const gap = o.compact ? anchorGap(d) : null;
  if (gap && gap.sd) {
    traces.push(
      { x: gap.x, y: gap.lo90, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: 'b90' },
      { x: gap.x, y: gap.hi90, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(COLOURS.band, 0.2), showlegend: false, legendgroup: 'b90',
        hovertemplate: 'since the last measurement, 90 % upper %{y:.2f} m<extra></extra>' },
      { x: gap.x, y: gap.lo50, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: 'b50' },
      { x: gap.x, y: gap.hi50, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(COLOURS.band, 0.45), showlegend: false, legendgroup: 'b50',
        hovertemplate: 'since the last measurement, 50 % upper %{y:.2f} m<extra></extra>' },
    );
  }
  if (gap) traces.push({ x: gap.x, y: gap.seg, mode: 'lines', line: { width: 1.5, color: COLOURS.median, dash: 'dash' }, name: LABELS.gapModel,
    hovertemplate: 'model since the last measurement %{y:.2f} m<extra></extra>' });

  const seasonEnd = d.season.end_date;
  const grey = '#5d6670';
  const vline = (x, colour, dash, width) => ({ type: 'line', xref: 'x', yref: 'paper', x0: x, x1: x, y0: 0, y1: 1, line: { color: colour, width: width || 1, dash } });
  const label = (x, y, text, colour, xanchor) => ({ x, y, xref: 'x', yref: 'paper', text, showarrow: false, xanchor, yanchor: 'bottom', font: { color: colour, size: 11 } });
  const shapes = [vline(d.issue_date, grey, 'solid'), vline(seasonEnd, grey, 'dot')];
  const annotations = [
    label(d.issue_date, 0.02, o.compact ? LABELS.today : `issue ${d.issue_date}`, grey, 'left'),
    label(seasonEnd, 1.0, `${LABELS.seasonEnd} ${seasonEnd}`, grey, 'left'),
  ];
  if (!o.compact) {
    shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: nc.last_observed_day, x1: nc.filled_to, y0: 0, y1: 1, fillcolor: rgba(COLOURS.nowcast, 0.08), line: { width: 0 }, layer: 'below' });
    shapes.push(vline(a.last_dip, COLOURS.anchor, 'dash', 1.5));
    annotations.push(label(a.last_dip, 1.0, `last measurement ${a.last_dip} (${a.age_days} d old)`, COLOURS.anchor, 'right'));
    if (rec) {
      const cal = rec.calibration;
      shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: cal.tmin, x1: cal.tmax, y0: 0, y1: 1, fillcolor: rgba(COLOURS.anchor, 0.06), line: { width: 0 }, layer: 'below' });
      annotations.push(label(cal.tmin, 0.02, `calibration ${cal.tmin} to ${cal.tmax} (${cal.n_obs} measurements)`, '#8a5a12', 'left'));
    }
  }
  // Range buttons: x from the key, y from the data visible in that window (Plotly autoranges y over all data).
  const starts = { '1y': addDays(d.issue_date, -365), '3y': addDays(d.issue_date, -3 * 365 - 1), full: first };
  const band = { x: fc.date, p05: fc.p05, p95: fc.p95 };  // the band shown: the default or a pumping scenario
  const visible = (x0) => yRange([
    o.compact ? null : { x: simX, y: simY }, { x: dips.date, y: dips.head_masl }, { x: band.x, y: band.p05 }, { x: band.x, y: band.p95 },
    climOn ? { x: dates, y: climBand.p05 } : null, climOn ? { x: dates, y: climBand.p95 } : null,
    gap && gap.sd ? { x: gap.x, y: gap.lo90 } : null, gap && gap.sd ? { x: gap.x, y: gap.hi90 } : null,
  ], x0, hEnd, Y_PAD);
  const layout = {
    font: PLOT_FONT, margin: o.compact ? { l: 48, r: 10, t: 24, b: 30 } : { l: 55, r: 15, t: 30, b: 40 }, hovermode: 'x unified',
    paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
    xaxis: { range: [starts[o.initial], hEnd], gridcolor: '#eeeeee' },
    yaxis: { title: { text: o.compact ? 'm above sea level' : LABELS.head }, gridcolor: '#eeeeee', zeroline: false, range: visible(starts[o.initial]) || undefined },
    legend: { orientation: 'h', y: -0.14, yanchor: 'top', font: { size: 11 } },
    shapes, annotations,
  };
  Plotly.newPlot(node, traces, layout, PLOT_CONFIG);
  let current = o.initial;
  const apply = (key) => {
    current = key;
    const x0 = starts[key], yr = visible(x0);
    Plotly.relayout(node, { 'xaxis.range': [x0, hEnd], 'yaxis.range': yr || undefined, 'yaxis.autorange': !yr });
    if (!o.compact && hasPlot(o.residualId)) Plotly.relayout(o.residualId, { 'xaxis.range': [x0, hEnd] });
  };
  segButtons(o.rangeId, o.initial, apply);
  if (!o.compact && hasPlot(o.residualId)) Plotly.relayout(o.residualId, { 'xaxis.range': [starts[o.initial], hEnd] });
  if (climToggle && !climToggle.dataset.wired) {
    climToggle.dataset.wired = '1';
    climToggle.addEventListener('change', () => {
      climOn = climToggle.checked;
      Plotly.restyle(node, { visible: climOn }, [0, 1, 2]);
      apply(current);
    });
  }
  const note = document.getElementById(o.noteId);
  if (note && !o.compact) {
    note.textContent = rec
      ? `Full record: ${dips.n} measurements from ${dips.date[0]}; the green line is the model on the observed weather from the calibration start `
        + `${rec.calibration.tmin} (shaded to ${rec.calibration.tmax}); the dashed blue line adds the residual at the last measurement, decayed with tau, `
        + `which the forecast median continues from on ${rec.join.forecast_first_day}.`
      : 'This issue carries the measurements of the last three years only; the full record is not included.';
  }
  // The band traces (3..7 and, with P20 / P80, 8..9) redrawn from another quantile set, the pumping scenarios'.
  const setBand = (x, q) => {
    band.x = x; band.p05 = q.p05; band.p95 = q.p95;
    const withP = hasP2080 && Array.isArray(q.p20) && Array.isArray(q.p80);
    const ys = [q.p05, q.p95, q.p25, q.p75, q.p50].concat(withP ? [q.p20, q.p80] : []);
    Plotly.restyle(node, { x: ys.map(() => x), y: ys }, withP ? [3, 4, 5, 6, 7, 8, 9] : [3, 4, 5, 6, 7]);
    apply(current);
  };
  return { setBand };
}

// Residual panel under the fan chart: dip minus simulation at every dip in the calibration window, the +-1 residual sd band,
// and the fit statistics of the anchor as text.
function renderResiduals(d) {
  const node = document.getElementById('residual'), text = document.getElementById('fit-text');
  if (!node) return;
  const rec = d.record && d.record.dips && d.record.dips.residual_m ? d.record : null;
  if (!rec) { node.innerHTML = '<div class="plot-note">The residual panel needs the full record, which this issue does not carry.</div>'; return; }
  if (typeof Plotly === 'undefined') { libMissing('residual', 'Plotly'); return; }
  const x = [], y = [];
  rec.dips.date.forEach((dt, i) => { const r = rec.dips.residual_m[i]; if (r !== null && r !== undefined) { x.push(dt); y.push(r); } });
  const sd = rec.fit.resid_sd_m, cal = rec.calibration, a = d.anchor;
  const hEnd = d.forecast.date[d.forecast.date.length - 1];
  const traces = [
    { x, y, mode: 'markers', marker: { size: 4, color: COLOURS.obs }, name: 'Measurement minus model', hovertemplate: 'residual %{y:+.2f} m<extra></extra>' },
    { x: [a.last_dip], y: [a.e0_m], mode: 'markers', marker: { size: 9, color: COLOURS.anchor, line: { color: COLOURS.obs, width: 1 } },
      name: `Residual at the last measurement (e0) ${fmtSigned(a.e0_m, 2)} m`, hovertemplate: 'e0 %{y:+.2f} m<extra></extra>' },
  ];
  const shapes = [
    { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: -sd, y1: sd, fillcolor: rgba(COLOURS.climatology, 0.18), line: { width: 0 }, layer: 'below' },
    { type: 'rect', xref: 'x', yref: 'paper', x0: cal.tmin, x1: cal.tmax, y0: 0, y1: 1, fillcolor: rgba(COLOURS.anchor, 0.06), line: { width: 0 }, layer: 'below' },
    { type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: '#555555', width: 1 } },
    { type: 'line', xref: 'x', yref: 'paper', x0: a.last_dip, x1: a.last_dip, y0: 0, y1: 1, line: { color: COLOURS.anchor, width: 1.5, dash: 'dash' } },
    { type: 'line', xref: 'x', yref: 'paper', x0: d.issue_date, x1: d.issue_date, y0: 0, y1: 1, line: { color: '#555555', width: 1 } },
  ];
  const layout = {
    font: PLOT_FONT, margin: { l: 55, r: 15, t: 10, b: 30 }, hovermode: 'x unified', paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
    xaxis: { range: [addDays(d.issue_date, -365), hEnd], gridcolor: '#eeeeee' },
    yaxis: { title: { text: 'Measurement - model (m)' }, gridcolor: '#eeeeee', zeroline: false },
    legend: { orientation: 'h', y: -0.2, yanchor: 'top', font: { size: 11 } }, shapes,
    annotations: [{ x: 1, y: sd, xref: 'paper', yref: 'y', text: '+1 residual sd', showarrow: false, xanchor: 'right', yanchor: 'bottom', font: { color: COLOURS.climatology, size: 10 } }],
  };
  Plotly.newPlot('residual', traces, layout, PLOT_CONFIG);
  if (text) {
    const f = rec.fit;
    text.textContent = `Fit over the calibration window ${cal.tmin} to ${cal.tmax} (${f.n_obs} dips; ${f.source}): R2 ${fmt(f.rsq, 2)}, `
      + `RMSE ${fmt(f.rmse_m, 2)} m, residual sd ${fmt(sd, 2)} m (the grey band), residual persistence tau ${fmt(f.tau_days, 0)} d. `
      + `The anchor residual e0 ${fmtSigned(a.e0_m, 2)} m on ${a.last_dip} is what the forecast decays from.`;
  }
}

function renderVariance(d) {
  const node = document.getElementById('variance');
  const v = d.forecast && d.forecast.variance;
  if (!v || !v.total) { node.innerHTML = '<div class="plot-note">No variance decomposition in this issue.</div>'; return; }
  if (typeof Plotly === 'undefined') { libMissing('variance', 'Plotly'); return; }
  const comps = ['weather', 'parameter', 'realisation', 'noise'].filter((k) => Array.isArray(v[k]));
  const traces = comps.map((k) => ({
    x: d.forecast.date, y: v[k], customdata: v[k], stackgroup: 'one', groupnorm: 'percent', mode: 'lines', line: { width: 0.5, color: VARIANCE_COLOURS[k] },
    fillcolor: rgba(VARIANCE_COLOURS[k], 0.75), name: k, hovertemplate: `${k} %{y:.0f} % (%{customdata:.3f} m&sup2;)<extra></extra>`,
  }));
  const layout = {
    font: PLOT_FONT, margin: { l: 55, r: 15, t: 10, b: 40 }, hovermode: 'x unified', paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
    xaxis: { gridcolor: '#eeeeee' }, yaxis: { title: { text: 'Share of the forecast variance (%)' }, range: [0, 100], gridcolor: '#eeeeee' },
    legend: { orientation: 'h', y: -0.15, yanchor: 'top', font: { size: 11 } },
    shapes: [{ type: 'line', xref: 'x', yref: 'paper', x0: d.season.end_date, x1: d.season.end_date, y0: 0, y1: 1, line: { color: '#555555', width: 1, dash: 'dot' } }],
  };
  Plotly.newPlot('variance', traces, layout, PLOT_CONFIG);

  const i = Math.max(0, d.forecast.date.indexOf(d.season.end_date));
  const last = d.forecast.date.length - 1;
  const share = (k, j) => (v.total[j] > 0 ? 100 * v[k][j] / v.total[j] : 0);
  const line = (j, label) => `${label}: total variance ${fmt(v.total[j], 3)} m&sup2; (sd ${fmt(Math.sqrt(v.total[j]), 2)} m) = `
    + comps.map((k) => `${k} ${Math.round(share(k, j))} %`).join(', ') + '.';
  document.getElementById('variance-text').innerHTML = `<p class="note">${line(i, 'At the season end ' + d.season.end_date)}<br>${line(last, 'At the horizon end ' + d.forecast.date[last])}</p>`;
}

function kv(rows) {
  const dl = el('dl', { class: 'kv' });
  for (const [k, v] of rows) {
    dl.appendChild(el('dt', { text: k }));
    dl.appendChild(el('dd', { text: v === undefined || v === null ? 'n/a' : String(v) }));
  }
  return dl;
}

const MONTH_ABBR = { 4: 'Apr', 6: 'Jun', 8: 'Aug' };  // config/postprocess.json node labels
const PP_NAMES = {  // qsfc.postprocess.PRODUCT_PREDICTORS, in words
  rain6_anom: 'winter rain anomaly (mm)', rain12_anom: '12-month rain anomaly (mm)',
  arade_anom: 'Arade storage anomaly (hm3)', rs_level: 'footprint level', anchor_pct: 'anchor head percentile',
  e0: 'residual at the anchor (m)', e0_prev: "previous origin's residual (m)", ada12_hm3: 'AdA 12-month volume (hm3)',
};

function renderSiteDetails(d) {
  const s = d.spec, a = d.anchor, r = d.realisations, se = d.season, c = d.coordinates || {}, pump = d.pumping || null;
  const spec = document.getElementById('spec');
  spec.innerHTML = '';
  const irrigation = s.irrig ? 'yes (lagged-deficit proxy)' : s.irrig_cwb ? 'yes (crop-water balance)' : 'no';
  const rows = [
    ['Role', d.role + (d.role === 'product' ? ' (passed the hindcast gate)' : ' (not yet promoted by the hindcast)')],
    ['Sector', d.sector],
    ['Structure', d.label],
    ['Response function', s.rfunc],
    ['Recharge model', s.recharge],
    ['Irrigation stress (separate term)', irrigation],
    ['Public-supply (AdA) stress (separate term)', s.ada ? 'yes' : 'no'],
  ];
  if (pump) {
    const m = pump.m_pump || 0, fp = pump.level === 'footprint', sw = pump.switch || null;
    const ma = pump.mult_ada === undefined || pump.mult_ada === null ? m : pump.mult_ada;
    rows.push(['Pumping as negative recharge, m', m > 0
      ? `${fmt(m, 1)}: the recharge term's precipitation is P - [${fmt(m, 1)} x crop-water-balance irrigation${fp ? ' x footprint level' : ''}`
        + ` + ${fmt(ma, 1)} x public supply as a depth${sw ? ` + ${fmt(sw.beta, 1)} x all-parcel demand x ${SWITCH_NAMES[sw.indicator] || sw.indicator} deficit` : ''}], same response and gain as recharge`
      : `0 (${pump.sensitive ? 'the pumping enters through the separate stress above' : 'no pumping term: the dips do not carry a pumping signal the split sample can identify'})`]);
    if (m > 0) {
      if (pump.formulation_text) rows.push(['Formulation', pump.formulation_text]);
      if (pump.level) rows.push(['Irrigation level', LEVEL_TEXT[pump.level] || pump.level]);
      if (pump.mult_ada !== undefined && pump.mult_ada !== null) rows.push(['Public-supply (AdA) weight m_a',
        `${fmt(ma, 1)}${ma === m ? ' (= m)' : ' (a weight of its own: the two wellfields lie 1-3 km from the western wells)'}`]);
      if (pump.level) rows.push(['Drought switching', sw
        ? `beta = ${fmt(sw.beta, 1)} x the all-parcel demand x the ${SWITCH_NAMES[sw.indicator] || sw.indicator} deficit (extra pumping when surface allocations are cut)`
        : 'none']);
      rows.push([`Head effect of the current pumping, ${pump.effect_years || 'n/a'}`,
        `mean drawdown ${fmt(pump.effect_mean_m)} m, summer peak ${fmt(pump.effect_summer_m)} m (largest ${fmt(pump.effect_max_m)} m on ${pump.effect_max_date})`]);
    }
  }
  const pp = d.postprocess || null;
  if (pp) {
    rows.push(['1 April correction (conditional bias and spread)', pp.applied
      ? `${fmtSigned(pp.shift_at_season_end_m, 2)} m at the season end, spread x${fmt(pp.spread, 2)}`
        + ` (node weights ${Object.entries(pp.node_weights || {}).map(([k, v]) => `1 ${MONTH_ABBR[k] || k} ${fmt(v, 2)}`).join(', ') || 'none'};`
        + ` fitted on the hindcast, ${(pp.config && pp.config.years ? pp.config.years.join('-') : 'n/a')}, leave-one-year-out)`
      : `not applied (${pp.reason})`]);
    if (pp.applied) {
      rows.push(['Correction shift along the horizon', `${fmtSigned(pp.shift_first_day_m, 2)} m on the first day to `
        + `${fmtSigned(pp.shift_horizon_end_m, 2)} m at the horizon end: the shift is the standardised bias times the band's own `
        + `width, so it is near zero where the forecast is anchored on an observed dip and largest at the season end`]);
      rows.push(['Correction inputs at this issue', Object.entries(pp.predictors || {})
        .filter(([k]) => !k.startsWith('_')).map(([k, v]) => `${PP_NAMES[k] || k} ${fmt(v, 2)}`).join('; ')]);
    }
  }
  rows.push(
    ['Calibration window', `${s.tmin} to ${s.tmax}`],
    ['Location', `${fmt(c.lat, 5)} N, ${fmt(-c.lon, 5)} W (EPSG:3763 ${fmt(c.x_3763, 0)}, ${fmt(c.y_3763, 0)})`],
    ['Input realisations', r ? `${r.mode}: ${r.names.map((n, i) => `${n} (${fmt(r.weights[i], 3)})`).join(', ')}` : 'baseline only'],
  );
  spec.appendChild(kv(rows));
  const anchor = document.getElementById('anchor');
  anchor.innerHTML = '';
  anchor.appendChild(kv([
    ['Last measurement (the anchor)', `${a.last_dip}, ${fmt(a.head_masl)} m above sea level, ${a.age_days} d before issue`],
    ['Residual at the anchor (e0)', `${fmtSigned(a.e0_m, 3)} m`],
    ['Residual persistence (tau)', `${fmt(a.tau_days, 0)} d`],
    ['Residual variance (sigma2)', `${fmt(a.sigma2_m2, 3)} m2`],
    ['Fit anchor', `${a.fit_anchor_tmax} (written ${a.fit_anchor_written}, ${a.fit_age_days} d old)`],
    ['New dips since the fit', a.n_new_dips],
    ['Refit decision', a.refit],
  ]));
  const season = document.getElementById('season-table');
  season.innerHTML = `<thead><tr><th></th><th class="num">p05</th><th class="num">p25</th><th class="num">p50</th><th class="num">p75</th><th class="num">p95</th></tr></thead>`;
  const tb = el('tbody');
  const row = (label, vals) => {
    const tr = el('tr'); tr.appendChild(el('td', { text: label }));
    for (const x of vals) tr.appendChild(el('td', { class: 'num', text: fmt(x) }));
    tb.appendChild(tr);
  };
  row(`Season end ${se.end_date}`, [se.p05, se.p25, se.p50, se.p75, se.p95]);
  row(`Horizon end ${se.horizon_end}`, [se.horizon_end_p05, se.horizon_end_p25, se.horizon_end_p50, se.horizon_end_p75, se.horizon_end_p95]);
  row(`Horizon minimum (median on ${se.date_min_p50})`, [se.min_p05, null, se.min_p50, null, se.min_p95]);
  row(`Horizon maximum (median on ${se.date_max_p50})`, [se.max_p05, null, se.max_p50, null, se.max_p95]);
  season.appendChild(tb);
}

// Raw against corrected season-end scores of the 1 April conditional correction (docs/plan.md step 16 d).
// The gate that promotes a site to `product` is on the uncorrected band, which the page says.
function renderPostprocess(sk) {
  const node = document.getElementById('pp-body');
  const wrap = document.getElementById('pp-section');
  if (!node || !wrap) return;
  const pp = sk.postprocess || {};
  if (!pp.available) {
    wrap.hidden = false;
    node.innerHTML = '';
    node.appendChild(el('p', { class: 'note', text: pp.message || 'The hindcast tables carry no corrected variant yet.' }));
    return;
  }
  wrap.hidden = false;
  node.innerHTML = '';
  const cfg = pp.config || {};
  node.appendChild(el('p', { class: 'note', text: `${pp.message} Fitted on ${cfg.years ? cfg.years.join('-') : 'n/a'} `
    + `at the nodes ${(cfg.node_months || []).map((m) => '1 ' + (MONTH_ABBR[m] || m)).join(', ')} in the `
    + `${(pp.sectors || []).join(', ') || 'no'} sector; predictors ${(cfg.predictors || []).join(', ')}. `
    + `Not applied to: ${cfg.not_applied || 'n/a'}.` }));
  const apr = (pp.medians || {}).apr;
  if (apr) {
    node.appendChild(el('p', { text: `Over the ${apr.n_sites} corrected sites at the 1 April origin, the median season-end `
      + `CRPSS goes ${fmtSigned(apr.end_crpss, 3)} to ${fmtSigned(apr.end_crpss_pp, 3)}, the median absolute error of the `
      + `median ${fmt(apr.end_mae, 2)} m to ${fmt(apr.end_mae_pp, 2)} m and the 90 % coverage ${fmt(apr.end_cov_90, 2)} `
      + `to ${fmt(apr.end_cov_90_pp, 2)} (nominal 0.90).` }));
  }
  const table = el('table', { class: 'scores' });
  table.innerHTML = '<thead><tr><th>Site</th><th>Origin</th><th class="num">CRPSS</th><th class="num">CRPSS corrected</th>'
    + '<th class="num">MAE (m)</th><th class="num">MAE corrected</th><th class="num">cov 90</th>'
    + '<th class="num">cov 90 corrected</th></tr></thead>';
  const tb = el('tbody');
  for (const r of pp.sites || []) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: r.slug }));
    tr.appendChild(el('td', { text: r.init_month === 4 ? '1 Apr' : '1 Oct' }));
    for (const k of ['end_crpss', 'end_crpss_pp', 'end_mae', 'end_mae_pp', 'end_cov_90', 'end_cov_90_pp']) {
      tr.appendChild(el('td', { class: 'num', text: r[k] === null || r[k] === undefined ? '-' : fmt(r[k], k.startsWith('end_crpss') ? 3 : 2) }));
    }
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  node.appendChild(table);
}

// ------------------------------------------------------------------------------------------ skill page
async function pageSkill() {
  let index = null;
  try { index = await loadJSON('data/index.json'); } catch (e) { console.warn(e); }
  renderFooter(index);
  const sk = await loadJSON('data/skill.json');
  setText('skill-stamp', sk.generated_utc ? `skill.json written ${fmtUTC(sk.generated_utc)}` : '');
  if (!sk.available) {
    showStatus(sk.message || 'The hindcast has not been scored yet; the skill page is empty.');
    document.getElementById('skill-body').hidden = true;
    return;
  }
  setText('gate-rule', sk.rule || '');
  const src = sk.sources ? Object.entries(sk.sources).map(([k, v]) => `${k}: ${v.path}${v.modified_utc ? ' (' + fmtUTC(v.modified_utc) + ')' : ''}`).join('; ') : '';
  setText('skill-sources', src);
  const siteMeta = {};
  for (const s of sk.sites || []) siteMeta[s.slug] = s;
  const inits = [4, 10];
  renderStatements(sk);
  renderPostprocess(sk);
  for (const init of inits) {
    renderLeadChart(sk, init, 'crpss', `crpss-${init}`, siteMeta, { title: 'CRPSS vs head climatology', zero: true });
    renderLeadChart(sk, init, 'cov_90', `cov-${init}`, siteMeta, { title: '90 % coverage', nominal: 0.9, band: sk.gate_cov90 || [0.8, 0.98] });
    renderAgeChart(sk, init, `age-${init}`, siteMeta);
  }
  renderHeadlineTable(sk, siteMeta);
  renderRolesTable(sk, siteMeta);
  // One origin at a time: the by-lead, coverage and anchor-age charts of the other origin sit in a hidden panel.
  segButtons('origin-switch', '4', (key) => {
    for (const panel of document.querySelectorAll('.origin-panel')) {
      panel.hidden = panel.dataset.origin !== key;
      if (!panel.hidden && typeof Plotly !== 'undefined') panel.querySelectorAll('.plot').forEach((n) => { if (n.data) Plotly.Plots.resize(n); });
    }
  });
}

function renderStatements(sk) {
  const node = document.getElementById('statements');
  node.innerHTML = '';
  for (const init of [4, 10]) {
    const rows = (sk.statements || []).filter((r) => r.init_month === init);
    if (!rows.length) continue;
    node.appendChild(el('h3', { text: ORIGIN_NAMES[init] }));
    const ul = el('ul', { class: 'statements' });
    for (const r of rows) ul.appendChild(el('li', { class: r.beats_climatology ? '' : 'none', text: r.text }));
    node.appendChild(ul);
  }
}

function leadBinsOf(sk) { return sk.lead_bins || ['0-30', '30-60', '60-90', '90-120', '120-150', '150-180', '180+']; }

function renderLeadChart(sk, init, col, target, siteMeta, opts) {
  if (typeof Plotly === 'undefined') { libMissing(target, 'Plotly'); return; }
  const bins = leadBinsOf(sk);
  const rows = (sk.by_lead || []).filter((r) => r.init_month === init && r.age_months === 0 && bins.includes(r.lead_bin));
  const slugs = [...new Set(rows.map((r) => r.slug))].sort();
  const traces = [];
  const perBin = bins.map(() => []);
  for (const slug of slugs) {
    const esp = rows.filter((r) => r.slug === slug && r.variant === 'esp');
    const y = bins.map((b) => { const r = esp.find((q) => q.lead_bin === b); return r ? r[col] : null; });
    y.forEach((v, i) => { if (v !== null) perBin[i].push(v); });
    const meta = siteMeta[slug] || {};
    const product = meta.role === 'product';
    traces.push({
      x: bins, y, mode: 'lines+markers', name: `${meta.site_id || slug}${product ? ' (verified)' : ''}`,
      line: { width: product ? 2 : 1, color: SECTOR_COLOURS[meta.sector] || '#888888', dash: product ? 'solid' : 'dot' },
      marker: { size: product ? 6 : 4 }, opacity: product ? 1 : 0.7,
      hovertemplate: `${meta.site_id || slug} %{x} d: %{y:.2f}<extra></extra>`,
    });
  }
  traces.push({ x: bins, y: perBin.map((v) => median(v)), mode: 'lines+markers', name: 'median of sites (ESP)', line: { width: 3, color: '#222222' }, marker: { size: 7 },
    hovertemplate: 'median %{y:.2f}<extra></extra>' });
  const known = rows.filter((r) => r.variant === 'known');
  if (known.length) {
    const y = bins.map((b) => median(known.filter((r) => r.lead_bin === b).map((r) => r[col])));
    traces.push({ x: bins, y, mode: 'lines', name: 'median of sites, known forcing (ceiling)', line: { width: 2, color: '#222222', dash: 'dash' }, hovertemplate: 'known %{y:.2f}<extra></extra>' });
  }
  const shapes = [];
  if (opts.zero) shapes.push({ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: COLOURS.reference, width: 1 } });
  if (opts.nominal !== undefined) shapes.push({ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: opts.nominal, y1: opts.nominal, line: { color: COLOURS.reference, width: 1 } });
  if (opts.band) shapes.push({ type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: opts.band[0], y1: opts.band[1], fillcolor: rgba(COLOURS.nowcast, 0.08), line: { width: 0 }, layer: 'below' });
  const layout = {
    font: PLOT_FONT, margin: { l: 50, r: 10, t: 30, b: 40 }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
    title: { text: `${opts.title}, ${ORIGIN_NAMES[init]}`, font: { size: 13 }, x: 0 },
    xaxis: { title: { text: 'Lead (days after the origin)' }, type: 'category', categoryorder: 'array', categoryarray: bins, gridcolor: '#eeeeee' },
    yaxis: { title: { text: opts.title }, gridcolor: '#eeeeee', zeroline: false, range: col === 'cov_90' ? [0, 1.02] : undefined },
    legend: { orientation: 'h', y: -0.25, yanchor: 'top', font: { size: 10 } }, shapes,
  };
  Plotly.newPlot(target, traces, layout, PLOT_CONFIG);
}

function renderAgeChart(sk, init, target, siteMeta) {
  if (typeof Plotly === 'undefined') { libMissing(target, 'Plotly'); return; }
  const rows = (sk.anchor_age || []).filter((r) => r.init_month === init);
  const ages = [...new Set(rows.map((r) => r.age_months))].sort((a, b) => a - b);
  const slugs = [...new Set(rows.map((r) => r.slug))].sort();
  const traces = [];
  const perAge = ages.map(() => []);
  for (const slug of slugs) {
    const y = ages.map((age) => { const r = rows.find((q) => q.slug === slug && q.age_months === age); return r ? r.crpss : null; });
    y.forEach((v, i) => { if (v !== null) perAge[i].push(v); });
    const meta = siteMeta[slug] || {};
    const product = meta.role === 'product';
    traces.push({ x: ages, y, mode: 'lines+markers', name: `${meta.site_id || slug}${product ? ' (verified)' : ''}`,
      line: { width: product ? 2 : 1, color: SECTOR_COLOURS[meta.sector] || '#888888', dash: product ? 'solid' : 'dot' }, marker: { size: product ? 6 : 4 }, opacity: product ? 1 : 0.7,
      hovertemplate: `${meta.site_id || slug}, anchor %{x} months old: %{y:.2f}<extra></extra>` });
  }
  traces.push({ x: ages, y: perAge.map((v) => median(v)), mode: 'lines+markers', name: 'median of sites', line: { width: 3, color: '#222222' }, marker: { size: 7 } });
  const layout = {
    font: PLOT_FONT, margin: { l: 50, r: 10, t: 30, b: 40 }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
    title: { text: `Season-end CRPSS by anchor age, ${ORIGIN_NAMES[init]}`, font: { size: 13 }, x: 0 },
    xaxis: { title: { text: 'Age of the last dip at the origin (months)' }, tickvals: ages, gridcolor: '#eeeeee' },
    yaxis: { title: { text: 'CRPSS vs head climatology' }, gridcolor: '#eeeeee', zeroline: false },
    legend: { orientation: 'h', y: -0.25, yanchor: 'top', font: { size: 10 } },
    shapes: [{ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: COLOURS.reference, width: 1 } }],
  };
  Plotly.newPlot(target, traces, layout, PLOT_CONFIG);
}

function signedCell(x, d) {
  const td = el('td', { class: 'num', text: fmtSigned(x, d) });
  if (x !== null && x !== undefined) td.classList.add(Number(x) > 0 ? 'pos' : 'neg');
  return td;
}

function renderHeadlineTable(sk, siteMeta) {
  const tbody = document.querySelector('#headline-table tbody');
  tbody.innerHTML = '';
  const rows = [...(sk.headline || [])].sort((a, b) => (a.slug + a.init_month).localeCompare(b.slug + b.init_month));
  for (const r of rows) {
    const meta = siteMeta[r.slug] || {};
    const tr = el('tr', { class: meta.role || '' });
    tr.appendChild(el('td', {}, [el('a', { href: `site.html?site=${r.slug}`, text: meta.site_id || r.slug })]));
    tr.appendChild(el('td', { text: r.sector || meta.sector || '' }));
    tr.appendChild(el('td', { text: r.init_month === 4 ? '1 Apr' : '1 Oct' }));
    tr.appendChild(el('td', { class: 'num', text: r.n_years }));
    tr.appendChild(signedCell(r.end_crpss));
    tr.appendChild(el('td', { class: 'num', text: `${fmtSigned(r.end_crpss_lo)} to ${fmtSigned(r.end_crpss_hi)}` }));
    tr.appendChild(el('td', { class: 'num', text: fmt(r.end_cov_90) }));
    tr.appendChild(el('td', { class: 'num', text: fmt(r.end_mae) }));
    tr.appendChild(signedCell(r.end_crpss_known));
    tr.appendChild(signedCell(r.end_crpss_persist));
    tr.appendChild(signedCell(r.traj_crpss));
    tr.appendChild(el('td', { class: 'num', text: fmt(r.traj_cov_90) }));
    tr.appendChild(signedCell(r.extreme_crpss));
    tbody.appendChild(tr);
  }
}

function renderRolesTable(sk, siteMeta) {
  const tbody = document.querySelector('#roles-table tbody');
  tbody.innerHTML = '';
  for (const r of [...(sk.roles || [])].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const meta = siteMeta[r.slug] || {};
    const tr = el('tr', { class: r.role || '' });
    tr.appendChild(el('td', {}, [el('a', { href: `site.html?site=${r.slug}`, text: meta.site_id || r.slug })]));
    tr.appendChild(el('td', { text: r.sector || '' }));
    tr.appendChild(signedCell(r.end_crpss_apr));
    tr.appendChild(signedCell(r.end_crpss_lo_apr));
    tr.appendChild(signedCell(r.end_crpss_oct));
    tr.appendChild(signedCell(r.end_crpss_lo_oct));
    tr.appendChild(el('td', { class: 'num', text: fmt(r.traj_cov_90) }));
    tr.appendChild(el('td', {}, [roleBadge(r.role || 'candidate')]));
    tr.appendChild(el('td', { text: r.verdict || '' }));
    tbody.appendChild(tr);
  }
}

// ------------------------------------------------------------------------------------------ weather page
async function pageWeather() {
  let index = null;
  try { index = await loadJSON('data/index.json'); } catch (e) { console.warn(e); }
  renderFooter(index);
  const w = await loadJSON('data/weather.json');
  const feeds = w.feeds || {}, sp = w.splice || {}, corr = w.correction || {};
  setText('issue-date', w.issue_date);
  setText('members-line', `${w.members.n} members (control + ${w.members.n - 1}): `
    + Object.values(feeds).map((f) => `${f.model} run of ${f.first_date}, fetched ${fmtUTC(f.fetched_utc)}`).join('; '));
  setText('splice-line', `${sp.near || 'EC46'} to ${sp.join_last_near_day}, ${sp.far || 'SEAS5'} from ${sp.far_first_day}`);
  const corrText = corr.status === 'none' ? 'not bias-corrected (raw model members)' : `bias correction: ${corr.status}`;
  setText('correction-line', corrText + (corr.status === 'none' && corr.reason ? ` - ${corr.reason}` : ''));
  const ob = w.observed;
  setText('weather-summary', `Observed forcing (ERA5-Land) to ${ob.observed_last_day}, gap-filled to ${ob.filled_to}; horizon ${w.horizon.date[0]} `
    + `to ${w.horizon.date[w.horizon.date.length - 1]} (${w.horizon.n_days} d). Members are ${corrText}.`);

  const hEnd = w.horizon.date[w.horizon.date.length - 1];
  const starts = { '6m': addDays(w.issue_date, -182), '2y': ob.date[0] };
  const initial = '6m';
  const panels = [
    renderWeatherPanel(w, 'prec_mm', 'w-prec', { bars: true, title: 'Rain (mm/d)', x0: starts[initial], hEnd }),
    renderWeatherPanel(w, 'et0_mm', 'w-et0', { bars: false, title: 'ET0 (mm/d)', x0: starts[initial], hEnd }),
  ].filter(Boolean);
  segButtons('weather-range', initial, (key) => panels.forEach((p) => p.setRange(starts[key])));
  const toggle = document.getElementById('members-toggle');
  if (toggle) toggle.addEventListener('change', () => panels.forEach((p) => p.showMembers(toggle.checked)));
  renderCumulative(w);
  renderProvenance(w.provenance, 'provenance');
}

// One variable: observed history coloured by fill source, member spaghetti, 50/90 % bands and median, splice and issue lines.
// Returns {setRange(x0), showMembers(on)} for the page controls, or null when Plotly is missing.
function renderWeatherPanel(w, v, target, opts) {
  if (typeof Plotly === 'undefined') { libMissing(target, 'Plotly'); return null; }
  const ob = w.observed, hz = w.horizon.date, mem = w.members[v] || [], q = w.quantiles[v];
  const hover = `%{y:.1f} mm (%{customdata})<extra></extra>`;
  const traces = [];
  if (opts.bars) {
    traces.push({ type: 'bar', x: ob.date, y: ob[v], marker: { color: ob.filled_from.map((s) => FILL_COLOURS[s] || COLOURS.obs) }, width: DAY_MS,
      customdata: ob.filled_from.map((s) => FILL_LABELS[s] || s), name: 'Observed daily rain (colour: source)', hovertemplate: 'observed ' + hover });
  } else {
    traces.push({ x: ob.date, y: ob[v], mode: 'lines', line: { width: 1.2, color: COLOURS.obs }, customdata: ob.filled_from.map((s) => FILL_LABELS[s] || s),
      name: 'Observed daily ET0', hovertemplate: 'observed ' + hover });
    const fx = [], fy = [], fcol = [];
    ob.date.forEach((dt, i) => { if (ob.filled_from[i] !== 'observed') { fx.push(dt); fy.push(ob[v][i]); fcol.push(FILL_COLOURS[ob.filled_from[i]] || COLOURS.anchor); } });
    traces.push({ x: fx, y: fy, mode: 'markers', marker: { size: 5, color: fcol }, name: 'Gap-filled days (green ERA5 scaled, orange EC46 control)', hoverinfo: 'skip' });
  }
  const memberIdx = [];
  mem.forEach((vals, i) => {
    memberIdx.push(traces.length);
    traces.push({ x: hz, y: vals, mode: 'lines', line: { width: 0.6, color: COLOURS.members }, opacity: 0.5, name: `Members (${w.members.n})`,
      legendgroup: 'members', showlegend: i === 0, hoverinfo: 'skip' });
  });
  traces.push(
    { x: hz, y: q.p05, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: 'b90' },
    { x: hz, y: q.p95, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(COLOURS.band, 0.2), name: 'Members 90 % (p05-p95)', legendgroup: 'b90', hovertemplate: 'p95 %{y:.1f} mm<extra></extra>' },
    { x: hz, y: q.p25, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: 'b50' },
    { x: hz, y: q.p75, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(COLOURS.band, 0.45), name: 'Members 50 % (p25-p75)', legendgroup: 'b50', hovertemplate: 'p75 %{y:.1f} mm<extra></extra>' },
    { x: hz, y: q.p50, mode: 'lines', line: { width: 2, color: COLOURS.median }, name: 'Member median', hovertemplate: 'p50 %{y:.1f} mm<extra></extra>' },
  );
  const gf = w.gap_fill || {};
  const sp = w.splice || {};
  const shapes = [
    { type: 'line', xref: 'x', yref: 'paper', x0: w.issue_date, x1: w.issue_date, y0: 0, y1: 1, line: { color: '#555555', width: 1 } },
    { type: 'line', xref: 'x', yref: 'paper', x0: sp.join_last_near_day, x1: sp.join_last_near_day, y0: 0, y1: 1, line: { color: COLOURS.reference, width: 1, dash: 'dash' } },
  ];
  if (gf.window) shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: gf.window[0], x1: gf.window[1], y0: 0, y1: 1, fillcolor: rgba(COLOURS.nowcast, 0.08), line: { width: 0 }, layer: 'below' });
  const annotations = [
    { x: w.issue_date, y: 1.0, xref: 'x', yref: 'paper', text: `issue ${w.issue_date}`, showarrow: false, xanchor: 'right', yanchor: 'bottom', font: { color: '#555555', size: 11 } },
    { x: sp.join_last_near_day, y: 1.0, xref: 'x', yref: 'paper', text: `${sp.near || 'EC46'} | ${sp.far || 'SEAS5'} from ${sp.far_first_day}`, showarrow: false, xanchor: 'left', yanchor: 'bottom', font: { color: COLOURS.reference, size: 11 } },
  ];
  const series = [{ x: ob.date, y: ob[v] }, { x: hz, y: q.p95 }, { x: hz, y: q.p05 }].concat(mem.map((vals) => ({ x: hz, y: vals })));
  const yr = (x0) => { const r = yRange(series, x0, opts.hEnd, Y_PAD); return r ? [Math.min(0, r[0]), r[1]] : null; };
  const layout = {
    font: PLOT_FONT, margin: { l: 55, r: 15, t: 30, b: 40 }, hovermode: 'x unified', paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', barmode: 'overlay', bargap: 0,
    xaxis: { range: [opts.x0, opts.hEnd], gridcolor: '#eeeeee' },
    yaxis: { title: { text: opts.title }, gridcolor: '#eeeeee', zeroline: false, range: yr(opts.x0) || undefined },
    legend: { orientation: 'h', y: -0.12, yanchor: 'top', font: { size: 11 } }, shapes, annotations,
  };
  Plotly.newPlot(target, traces, layout, PLOT_CONFIG);
  return {
    setRange: (x0) => { const r = yr(x0); Plotly.relayout(target, { 'xaxis.range': [x0, opts.hEnd], 'yaxis.range': r || undefined, 'yaxis.autorange': !r }); },
    showMembers: (on) => { if (memberIdx.length) Plotly.restyle(target, { visible: on }, memberIdx); },
  };
}

// Cumulative rain from the issue date: member spaghetti and bands against the same calendar window in every observed year.
function renderCumulative(w) {
  const node = document.getElementById('w-cum'), text = document.getElementById('cum-text');
  if (!node) return;
  const c = w.cumulative_prec_mm;
  if (!c || !c.quantiles) { node.innerHTML = '<div class="plot-note">No cumulative-rain block in this issue.</div>'; return; }
  if (typeof Plotly === 'undefined') { libMissing('w-cum', 'Plotly'); return; }
  const hz = w.horizon.date, q = c.quantiles, cl = c.climatology || null;
  const traces = [];
  if (cl) {
    traces.push(
      { x: hz, y: cl.p05, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: 'clim' },
      { x: hz, y: cl.p95, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(COLOURS.climatology, 0.22), legendgroup: 'clim',
        name: `Observed years ${cl.years[0]}-${cl.years[1]} (${cl.n_years}), 5-95 % of the same window`, hovertemplate: 'climatology p95 %{y:.0f} mm<extra></extra>' },
      { x: hz, y: cl.p50, mode: 'lines', line: { width: 1.2, color: COLOURS.climatology, dash: 'dot' }, legendgroup: 'clim', name: 'Observed years, median', hovertemplate: 'climatology p50 %{y:.0f} mm<extra></extra>' },
    );
  }
  (w.members.prec_mm || []).forEach((vals, i) => {
    let s = 0;
    const cum = vals.map((v) => { s += Math.max(v, 0); return Math.round(s * 10) / 10; });  // raw feed noise below 0 does not count
    traces.push({ x: hz, y: cum, mode: 'lines', line: { width: 0.6, color: COLOURS.members }, opacity: 0.5, name: `Members (${w.members.n})`, legendgroup: 'members', showlegend: i === 0, hoverinfo: 'skip' });
  });
  traces.push(
    { x: hz, y: q.p05, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: 'b90' },
    { x: hz, y: q.p95, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(COLOURS.band, 0.2), name: 'Members 90 % (p05-p95)', legendgroup: 'b90', hovertemplate: 'p95 %{y:.0f} mm<extra></extra>' },
    { x: hz, y: q.p25, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: 'b50' },
    { x: hz, y: q.p75, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(COLOURS.band, 0.45), name: 'Members 50 % (p25-p75)', legendgroup: 'b50', hovertemplate: 'p75 %{y:.0f} mm<extra></extra>' },
    { x: hz, y: q.p50, mode: 'lines', line: { width: 2, color: COLOURS.median }, name: 'Member median', hovertemplate: 'p50 %{y:.0f} mm<extra></extra>' },
  );
  const sp = w.splice || {};
  const layout = {
    font: PLOT_FONT, margin: { l: 55, r: 15, t: 30, b: 40 }, hovermode: 'x unified', paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
    xaxis: { gridcolor: '#eeeeee' }, yaxis: { title: { text: 'Cumulative rain since issue (mm)' }, gridcolor: '#eeeeee', rangemode: 'tozero' },
    legend: { orientation: 'h', y: -0.12, yanchor: 'top', font: { size: 11 } },
    shapes: [{ type: 'line', xref: 'x', yref: 'paper', x0: sp.join_last_near_day, x1: sp.join_last_near_day, y0: 0, y1: 1, line: { color: COLOURS.reference, width: 1, dash: 'dash' } }],
    annotations: [{ x: sp.join_last_near_day, y: 1.0, xref: 'x', yref: 'paper', text: `${sp.near || 'EC46'} | ${sp.far || 'SEAS5'}`, showarrow: false, xanchor: 'left', yanchor: 'bottom', font: { color: COLOURS.reference, size: 11 } }],
  };
  Plotly.newPlot('w-cum', traces, layout, PLOT_CONFIG);
  if (text) {
    const last = hz.length - 1;
    let line = `By ${hz[last]} the member median accumulates ${fmt(q.p50[last], 0)} mm (90 % of members between ${fmt(q.p05[last], 0)} and ${fmt(q.p95[last], 0)} mm).`;
    if (cl) {
      const ratio = cl.p50[last] > 0 ? 100 * q.p50[last] / cl.p50[last] : null;
      line += ` The same calendar window (${cl.window[0]} to ${cl.window[1]}) accumulated a median ${fmt(cl.p50[last], 0)} mm over ${cl.n_years} observed years `
        + `(5-95 %: ${fmt(cl.p05[last], 0)} to ${fmt(cl.p95[last], 0)} mm); the member median is ${ratio === null ? 'n/a' : Math.round(ratio) + ' %'} of it.`;
    }
    text.innerHTML = `<p class="note">${line}</p>`;
  }
}

// ------------------------------------------------------------------------------------------ methods page
async function pageMethods() {
  let index = null;
  try { index = await loadJSON('data/index.json'); } catch (e) { console.warn(e); }
  renderFooter(index);
  const node = document.getElementById('methods');
  const text = await loadText('methods.md');
  if (typeof marked !== 'undefined' && marked.parse) {
    node.innerHTML = marked.parse(text);
  } else {
    node.innerHTML = '';
    node.appendChild(el('p', { class: 'note', text: 'The markdown renderer did not load; showing the source text.' }));
    node.appendChild(el('pre', { text }));
  }
}

// ------------------------------------------------------------------------------------------ hindcast page
// data/hindcast/<slug>.json (scripts/07b_site_hindcast.py): every origin of the walk-forward hindcast as a forecast, next to
// what happened. The simulation line and the dips before the origin come from the site's own data/<slug>.json record.
const HC_LOOKBACK_DAYS = { '1y': 365, '3y': 3 * 365 + 1 };  // d; record shown before the origin
const HC_COLOURS = { truth: COLOURS.reference, known: '#444444', simulation: COLOURS.nowcast };
const INIT_COLOURS = { 4: COLOURS.anchor, 10: COLOURS.median };  // strip chart: 1 Apr and 1 Oct origins
const hindcastCache = new Map();  // slug -> Promise of data/hindcast/<slug>.json

function loadHindcast(slug) {
  if (!hindcastCache.has(slug)) hindcastCache.set(slug, loadJSON(`data/hindcast/${slug}.json`).catch((err) => { hindcastCache.delete(slug); throw err; }));
  return hindcastCache.get(slug);
}

// {x, y} of a compact daily block (qsfc.pipeline.compact_daily) between the ISO days x0 and x1 inclusive.
function sliceDailyBetween(block, x0, x1) {
  const s = sliceDaily(block, x0);
  const x = [], y = [];
  for (let i = 0; i < s.x.length && s.x[i] <= x1; i += 1) { x.push(s.x[i]); y.push(s.y[i]); }
  return { x, y };
}

async function pageHindcast() {
  const index = await loadJSON('data/index.json');
  renderFooter(index);
  const sites = (index.sites || []).filter((s) => s.hindcast);
  const body = document.getElementById('hc-body');
  const hb = index.hindcast || {};
  if (!sites.length) {
    showStatus('No hindcast files are listed in data/index.json. Run scripts/07_hindcast.py and scripts/07b_site_hindcast.py locally '
      + 'and commit site/data/hindcast/ (the hindcast cache is not part of the weekly job).');
    body.hidden = true;
    return;
  }
  setText('hc-stamp', hb.generated_utc ? `${hb.n_sites} sites with a hindcast file, ${hb.n_origins} origins ${hb.origins_from} to ${hb.origins_to}; written ${fmtUTC(hb.generated_utc)}.` : '');
  const params = new URLSearchParams(location.search);
  const wanted = params.get('site');
  const first = sites.find((s) => s.role === 'product') || sites[0];
  const state = {
    slug: sites.some((s) => s.slug === wanted) ? wanted : first.slug, origin: params.get('origin'), lookback: '1y',
    show: { truth: true, known: true, clim: true, pp: true }, h: null, site: null, siteError: null,
  };
  const siteSel = document.getElementById('hc-site'), originSel = document.getElementById('hc-origin');
  for (const s of sites) siteSel.appendChild(el('option', { value: s.slug, text: `${s.site_id} (${s.sector}, ${s.role})` }));
  siteSel.value = state.slug;

  const updateURL = () => history.replaceState(null, '', `?site=${state.slug}&origin=${state.origin}`);
  const draw = () => {
    const b = state.h.by_origin.find((o) => o.origin === state.origin);
    if (!b) return;
    renderHindcastChart(state.h, b, state.site, state);
    renderHindcastScores(state.h, b);
    renderHindcastStrip(state.h, b.origin, (origin) => setOrigin(origin));
    renderHindcastMembersNote(state.h, b);
  };
  const setOrigin = (origin) => {
    if (!state.h.origins.includes(origin)) return;
    state.origin = origin;
    originSel.value = origin;
    updateURL();
    draw();
  };
  const stepOrigin = (k) => {
    const list = state.h.origins, i = list.indexOf(state.origin);
    const j = Math.min(Math.max(i + k, 0), list.length - 1);
    if (j !== i) setOrigin(list[j]);
  };
  const loadSiteData = async () => {
    const [h, site] = await Promise.all([
      loadHindcast(state.slug),
      loadSite(state.slug).catch((err) => { console.warn(err); state.siteError = err.message; return null; }),
    ]);
    state.h = h;
    state.site = site;
    if (site) state.siteError = null;
    renderHindcastHeader(h, index);
    originSel.innerHTML = '';
    for (const o of h.origins) originSel.appendChild(el('option', { value: o, text: `${o} (${o.slice(5, 7) === '04' ? '1 Apr' : '1 Oct'})` }));
    if (!h.origins.includes(state.origin)) state.origin = h.origins[h.origins.length - 1];
    originSel.value = state.origin;
    updateURL();
    draw();
  };

  siteSel.addEventListener('change', () => { state.slug = siteSel.value; loadSiteData().catch(fail); });
  originSel.addEventListener('change', () => setOrigin(originSel.value));
  document.getElementById('hc-prev').addEventListener('click', () => stepOrigin(-1));
  document.getElementById('hc-next').addEventListener('click', () => stepOrigin(1));
  document.addEventListener('keydown', (e) => {
    if (['SELECT', 'INPUT', 'TEXTAREA'].includes((e.target && e.target.tagName) || '') || !state.h) return;
    if (e.key === 'ArrowLeft') { stepOrigin(-1); e.preventDefault(); } else if (e.key === 'ArrowRight') { stepOrigin(1); e.preventDefault(); }
  });
  segButtons('hc-range', state.lookback, (key) => { state.lookback = key; draw(); });
  for (const [id, key] of [['truth-toggle', 'truth'], ['known-toggle', 'known'], ['hc-clim-toggle', 'clim'],
                           ['pp-toggle', 'pp']]) {
    const t = document.getElementById(id);
    if (!t) continue;
    t.checked = state.show[key];
    t.addEventListener('change', () => { state.show[key] = t.checked; draw(); });
  }
  const noteToggle = document.getElementById('members-note-toggle');
  noteToggle.addEventListener('change', () => { document.getElementById('hc-members-note').hidden = !noteToggle.checked; });
  await loadSiteData();
}

function renderHindcastHeader(h, index) {
  document.title = `${h.site_id} hindcasts - Querença-Silves groundwater outlook`;
  setText('hc-title', `Well ${h.site_id}: hindcast explorer`);
  const badges = document.getElementById('hc-badges');
  badges.innerHTML = '';
  badges.appendChild(roleBadge(h.role));
  badges.appendChild(el('span', { class: 'badge', text: `sector: ${h.sector}` }));
  if (h.label) badges.appendChild(el('span', { class: 'badge', text: h.label }));
  const sm = h.summary || {}, hl = h.headline || {};
  const med = (init) => (sm[init] ? fmtSigned(sm[init].end_crpss_median) : 'n/a');
  const pooled = (init) => (hl[init] ? `${fmtSigned(hl[init].end_crpss)} [${fmtSigned(hl[init].end_crpss_lo)}, ${fmtSigned(hl[init].end_crpss_hi)}]` : 'n/a');
  const cov = (init) => (sm[init] && sm[init].cov_90 !== null ? fmt(sm[init].cov_90) : 'n/a');
  const k = h.inflation || {};
  setText('hc-summary', `${h.n_origins} origins ${h.origins[0]} to ${h.origins[h.origins.length - 1]}`
    + (h.n_origins_configured > h.n_origins ? ` (${h.n_origins_configured - h.n_origins} skipped for too few dips before the origin)` : '')
    + `. Median season-end CRPSS vs head climatology over origins: 1 Apr ${med('4')}, 1 Oct ${med('10')} `
    + `(pooled over all origins, with the 90 % bootstrap interval: ${pooled('4')} and ${pooled('10')}). `
    + `Trajectory coverage of the 90 % band: ${cov('4')} and ${cov('10')}. Noise inflation k ${fmt(k.k)} `
    + `(leave-one-year-out ${fmt(k.k_loyo_min)} to ${fmt(k.k_loyo_max)}; the bands use the origin year's value).`);
  const links = document.getElementById('hc-links');
  links.innerHTML = `<a href="site.html?site=${h.slug}">Open the site page</a> (today's forecast and the full record) &middot; `
    + `<a href="skill.html">Skill</a> (the scores across all sites) &middot; <a href="methods.html">Methods and data</a>.`;
  const stamp = document.getElementById('hc-stamp');
  if (stamp && h.generated_utc && !stamp.textContent) stamp.textContent = `Hindcast file written ${fmtUTC(h.generated_utc)}.`;
  void index;
}

// The fan chart of one origin: record before it (dips, the current model's simulation), the anchor, the ESP band and median,
// the known-forcing median, head climatology, the truth dips after the origin, the season-end line. Redrawn with Plotly.react.
function renderHindcastChart(h, b, site, state) {
  const node = document.getElementById('hc-fan');
  if (typeof Plotly === 'undefined') { libMissing('hc-fan', 'Plotly'); return; }
  const grid = expandDaily(b.esp);
  const x0 = addDays(b.origin, -HC_LOOKBACK_DAYS[state.lookback]), hEnd = b.esp.last_day;
  const rec = site && site.record && site.record.simulation ? site.record : null;
  const sim = rec ? sliceDailyBetween(rec.simulation, x0, hEnd) : null;
  const before = { x: [], y: [] };
  if (rec) rec.dips.date.forEach((dt, i) => { if (dt >= x0 && dt < b.origin) { before.x.push(dt); before.y.push(rec.dips.head_masl[i]); } });
  const truth = b.truth || { date: [], head_masl: [] };
  const clim = b.climatology || {};
  const known = b.known && b.known.p50 ? b.known.p50 : null;
  const traces = [
    { x: grid, y: clim.p05, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: 'clim', visible: state.show.clim },
    { x: grid, y: clim.p95, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(COLOURS.climatology, 0.22), legendgroup: 'clim', visible: state.show.clim,
      name: 'Head climatology 5-95 % (dips of the years before the origin, +/-15 d)', hovertemplate: 'climatology p95 %{y:.2f} m<extra></extra>' },
    { x: grid, y: clim.p50, mode: 'lines', line: { width: 1, color: COLOURS.climatology, dash: 'dot' }, legendgroup: 'clim', visible: state.show.clim,
      name: 'Climatology median', hovertemplate: 'climatology p50 %{y:.2f} m<extra></extra>' },
    { x: grid, y: b.esp.p05, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: 'b90' },
    { x: grid, y: b.esp.p95, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(COLOURS.band, 0.2), legendgroup: 'b90',
      name: 'Hindcast 90 % band (p05-p95)', hovertemplate: 'p95 %{y:.2f} m<extra></extra>' },
    { x: grid, y: b.esp.p25, mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false, legendgroup: 'b50' },
    { x: grid, y: b.esp.p75, mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: rgba(COLOURS.band, 0.45), legendgroup: 'b50',
      name: 'Hindcast 50 % band (p25-p75)', hovertemplate: 'p75 %{y:.2f} m<extra></extra>' },
    { x: grid, y: b.esp.p50, mode: 'lines', line: { width: 2, color: COLOURS.median }, name: `Hindcast median (ESP, ${b.n_members || 'n/a'} weather members)`,
      hovertemplate: 'p50 %{y:.2f} m<extra></extra>' },
    { x: grid, y: known || [], mode: 'lines', line: { width: 1.5, color: HC_COLOURS.known, dash: 'dash' }, visible: Boolean(known) && state.show.known,
      name: 'Median with the weather that actually came (known forcing)', hovertemplate: 'known forcing p50 %{y:.2f} m<extra></extra>' },
    { x: grid, y: (b.postprocess && b.postprocess.p05) || [], mode: 'lines', line: { width: 0 }, hoverinfo: 'skip',
      showlegend: false, legendgroup: 'pp', visible: Boolean(b.postprocess) && state.show.pp },
    { x: grid, y: (b.postprocess && b.postprocess.p95) || [], mode: 'lines', line: { width: 0 }, fill: 'tonexty',
      fillcolor: rgba(COLOURS.nowcast, 0.16), legendgroup: 'pp', visible: Boolean(b.postprocess) && state.show.pp,
      name: 'Corrected 5-95 % (1 April conditional correction)', hovertemplate: 'corrected p95 %{y:.2f} m<extra></extra>' },
    { x: grid, y: (b.postprocess && b.postprocess.p50) || [], mode: 'lines',
      line: { width: 1.8, color: COLOURS.nowcast, dash: 'dashdot' }, legendgroup: 'pp',
      visible: Boolean(b.postprocess) && state.show.pp,
      name: (b.postprocess ? `Corrected median (shift z ${fmtSigned(b.postprocess.z_bias, 2)}, spread x${fmt(b.postprocess.spread, 2)})`
        : 'Corrected median'), hovertemplate: 'corrected p50 %{y:.2f} m<extra></extra>' },
  ];
  if (sim) traces.push({ x: sim.x, y: sim.y, mode: 'lines', line: { width: 1.3, color: HC_COLOURS.simulation },
    name: `Current model's simulation on observed forcing (fit to ${rec.calibration.tmax}; not the hindcast's refit)`, hovertemplate: 'simulation %{y:.2f} m<extra></extra>' });
  traces.push({ x: before.x, y: before.y, mode: 'markers', marker: { size: 5, color: COLOURS.obs }, name: 'Measurements before the origin', hovertemplate: 'measured %{y:.2f} m<extra></extra>' });
  traces.push({ x: truth.date, y: truth.head_masl, mode: 'markers', marker: { size: 7, color: HC_COLOURS.truth, line: { color: COLOURS.obs, width: 0.8 } },
    visible: state.show.truth, name: `What actually happened: ${truth.n || truth.date.length} measurements after the origin`, hovertemplate: 'observed %{y:.2f} m<extra></extra>' });
  const se = b.season_end || {};
  if (se.date) traces.push({ x: [se.date], y: [se.truth], mode: 'markers', marker: { size: 11, color: HC_COLOURS.truth, symbol: 'diamond', line: { color: COLOURS.obs, width: 1 } },
    visible: state.show.truth, name: `Season-end dip ${se.date}`, hovertemplate: 'season-end dip %{y:.2f} m<extra></extra>' });
  const a = b.anchor || {};
  traces.push({ x: [a.date], y: [a.head_masl], mode: 'markers', marker: { size: 10, color: COLOURS.anchor, line: { color: COLOURS.obs, width: 1 } },
    name: `Last measurement before the origin (the anchor), ${a.date} (${a.age_days} d old)`, hovertemplate: 'anchor %{y:.2f} m<extra></extra>' });

  const series = [sim, before, { x: grid, y: b.esp.p05 }, { x: grid, y: b.esp.p95 },
    state.show.truth ? { x: truth.date, y: truth.head_masl } : null,
    state.show.clim ? { x: grid, y: clim.p05 } : null, state.show.clim ? { x: grid, y: clim.p95 } : null,
    state.show.known && known ? { x: grid, y: known } : null];
  const yr = yRange(series, x0, hEnd, Y_PAD);
  const vline = (x, colour, dash, width) => ({ type: 'line', xref: 'x', yref: 'paper', x0: x, x1: x, y0: 0, y1: 1, line: { color: colour, width: width || 1, dash } });
  const label = (x, y, text, colour, xanchor) => ({ x, y, xref: 'x', yref: 'paper', text, showarrow: false, xanchor, yanchor: 'bottom', font: { color: colour, size: 11 } });
  const layout = {
    font: PLOT_FONT, margin: { l: 55, r: 15, t: 30, b: 40 }, hovermode: 'x unified', paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
    xaxis: { range: [x0, hEnd], gridcolor: '#eeeeee' },
    yaxis: { title: { text: LABELS.head }, gridcolor: '#eeeeee', zeroline: false, range: yr || undefined, autorange: !yr },
    legend: { orientation: 'h', y: -0.12, yanchor: 'top', font: { size: 11 } },
    shapes: [vline(a.date, COLOURS.anchor, 'dash', 1.5), vline(b.origin, '#555555', 'solid', 1), vline(se.target, '#555555', 'dot', 1)],
    annotations: [
      label(a.date, 1.0, `anchor ${a.date} (${a.age_days} d old)`, COLOURS.anchor, 'right'),
      label(b.origin, 0.02, `origin ${b.origin}`, '#555555', 'left'),
      label(se.target, 1.0, `season end ${se.target}`, '#555555', 'right'),  // the target sits near the right edge: anchor the text inside
    ],
  };
  Plotly.react(node, traces, layout, PLOT_CONFIG);
  const note = document.getElementById('hc-note');
  if (note) {
    const parts = [`Origin ${b.origin}: the model was refit on the ${site && site.record ? '' : 'SNIRH '}dips before the origin and anchored on the last one `
      + `(${a.date}, ${fmt(a.head_masl)} m, residual e0 ${fmtSigned(a.e0_m)} m, ${a.age_days} d old); the band is the ESP variant with noise inflation k ${fmt(b.noise_k)}, `
      + `${b.n_members || 'n/a'} weather members x ${b.n_param || 'n/a'} parameter sets, over ${h.window_days} days (season ${h.horizon_days} d${h.grid && h.grid.thinned ? `; quantiles on every ${h.grid.step_days}nd day` : ''}).`];
    parts.push(h.note);
    if (!rec) parts.push(state.siteError ? `The site file data/${h.slug}.json could not be loaded (${state.siteError}), so the simulation line and the dips before the origin are not shown.`
      : 'The site file carries no full record, so the simulation line and the dips before the origin are not shown.');
    note.textContent = parts.join(' ');
  }
}

function renderHindcastScores(h, b) {
  const node = document.getElementById('hc-scores');
  const s = b.scores || {}, se = b.season_end || {}, a = b.anchor || {};
  const skillCard = (k, v, sub) => {
    const val = el('span', { class: 'v', text: fmtSigned(v) });
    if (v !== null && v !== undefined) val.classList.add(Number(v) > 0 ? 'pos' : 'neg');
    return el('div', {}, [el('span', { class: 'k', text: k }), val, el('span', { class: 's', text: sub })]);
  };
  const card = (k, v, sub) => el('div', {}, [el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v }), el('span', { class: 's', text: sub })]);
  node.innerHTML = '';
  node.appendChild(card('Trajectory CRPS', s.crps !== undefined ? `${fmt(s.crps)} m` : 'n/a', `head climatology ${fmt(s.crps_clim)} m; ${s.n_dips || 0} dips in the window`));
  node.appendChild(skillCard('CRPSS vs head climatology', s.crpss, `known forcing (the weather that came) ${fmtSigned(s.known_crpss)}`));
  node.appendChild(card('Coverage of the 90 % band', s.cov_90 !== undefined ? fmt(s.cov_90) : 'n/a', `50 % band ${fmt(s.cov_50)}; nominal 0.90 and 0.50`));
  if (se.date) {
    node.appendChild(card('Season-end error (median - dip)', `${fmtSigned(s.end_err)} m`,
      `dip ${se.date} ${fmt(se.truth)} m (target ${se.target}); ${s.end_in_90 ? 'inside' : 'outside'} the 90 % band; known forcing ${fmtSigned(s.known_end_err)} m`));
    node.appendChild(skillCard('Season-end CRPSS', s.end_crpss, `CRPS ${fmt(s.end_crps)} m vs climatology ${fmt(s.end_crps_clim)} m; season extreme ${fmtSigned(s.extreme_crpss)}`));
  } else {
    node.appendChild(card('Season end', 'no dip', `no dip within ${h.end_half_width_days} d of ${se.target}; season extreme CRPSS ${fmtSigned(s.extreme_crpss)}`));
  }
  node.appendChild(card('Anchor', `${a.age_days} d old`, `${a.date}, ${fmt(a.head_masl)} m, e0 ${fmtSigned(a.e0_m)} m; tau ${fmt(b.tau_days, 0)} d, sigma2 ${fmt(b.sigma2_m2, 3)} m2, k ${fmt(b.noise_k)}`));
}

// Season-end CRPSS of every origin of the site; the selected one outlined; click -> onPick(origin). Handlers attach once.
function renderHindcastStrip(h, selected, onPick) {
  const node = document.getElementById('hc-strip');
  if (typeof Plotly === 'undefined') { libMissing('hc-strip', 'Plotly'); return; }
  const traces = [];
  for (const init of [4, 10]) {
    const rows = h.by_origin.filter((b) => b.init_month === init);
    traces.push({
      x: rows.map((b) => b.origin), y: rows.map((b) => (b.scores && b.scores.end_crpss !== undefined ? b.scores.end_crpss : null)),
      customdata: rows.map((b) => b.origin), mode: 'lines+markers', line: { width: 0.8, color: INIT_COLOURS[init] }, marker: { size: 7, color: INIT_COLOURS[init] },
      name: init === 4 ? '1 Apr origins' : '1 Oct origins', connectgaps: false,
      hovertemplate: '%{customdata}: season-end CRPSS %{y:.2f}<extra></extra>',
    });
  }
  const sel = h.by_origin.find((b) => b.origin === selected);
  const selY = sel && sel.scores && sel.scores.end_crpss !== undefined ? sel.scores.end_crpss : 0;
  traces.push({ x: [selected], y: [selY], customdata: [selected], mode: 'markers', marker: { size: 14, color: 'rgba(0,0,0,0)', line: { color: COLOURS.obs, width: 2 } },
    name: `selected origin ${selected}${sel && sel.scores && sel.scores.end_crpss !== undefined ? '' : ' (no season-end dip)'}`, hovertemplate: 'selected %{customdata}<extra></extra>' });
  const layout = {
    font: PLOT_FONT, margin: { l: 55, r: 15, t: 10, b: 40 }, paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff', hovermode: 'closest',
    xaxis: { gridcolor: '#eeeeee', range: [addDays(h.origins[0], -120), addDays(h.origins[h.origins.length - 1], 120)] },
    yaxis: { title: { text: 'Season-end CRPSS' }, gridcolor: '#eeeeee', zeroline: false },
    legend: { orientation: 'h', y: -0.2, yanchor: 'top', font: { size: 11 } },
    shapes: [{ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0, y1: 0, line: { color: COLOURS.reference, width: 1 } }],
  };
  Plotly.react(node, traces, layout, PLOT_CONFIG);
  if (!node.dataset.wired) {
    node.dataset.wired = '1';
    node.on('plotly_click', (ev) => { const p = ev.points && ev.points[0]; if (p && p.customdata) onPick(String(p.customdata)); });
  }
}

function renderHindcastMembersNote(h, b) {
  const node = document.getElementById('hc-members-note');
  if (!node) return;
  const v = h.variants || {};
  node.textContent = `Members at origin ${b.origin}: ${b.n_members || 'n/a'} weather members x ${b.n_param || 'n/a'} parameter samples, each with 20 noise paths. `
    + `${v.esp || ''}. Known forcing: ${v.known || ''}. The member paths themselves are not carried in the hindcast file; the bands summarise them.`;
}

// ------------------------------------------------------------------------------------------ dispatch
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  const run = { index: pageIndex, site: pageSite, skill: pageSkill, methods: pageMethods, weather: pageWeather, hindcast: pageHindcast }[page];
  if (run) run().catch(fail);
});
