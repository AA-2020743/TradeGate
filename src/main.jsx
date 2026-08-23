import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { formatPercent, formatTimestamp, formatUsd, useEquityResearch, useMarketHistory, usePlatformData, useTechnicalAnalytics } from './liveData.js';
import { buildRoute, parseRoute } from './routing.js';
import { addSymbolToList, normalizeWatchlists } from './watchlistRules.js';
import { SCREENER_COLUMNS, ariaSortFor, nextSortState, sortRows } from './screenerSort.js';

const navItems = [
  ['⌘', 'Overview'],
  ['◌', 'Markets'],
  ['▥', 'Equities'],
  ['◇', 'Metals'],
  ['▦', 'Screener'],
  ['◫', 'Watchlists'],
  ['◔', 'Macro'],
  ['⇄', 'Forex'],
  ['₿', 'Crypto'],
];

const watchlist = [
  { ticker: 'NVDA', name: 'NVIDIA Corp.', color: '#75d95d' },
  { ticker: 'AAPL', name: 'Apple Inc.', color: '#f2a447' },
  { ticker: 'GLD', name: 'SPDR Gold Shares', color: '#c4a7ff' },
  { ticker: 'BTC', name: 'Bitcoin', color: '#ff7c4d' },
];

const watchlistSymbols = watchlist.map((asset) => asset.ticker);

const newsWireItems = (platformData) => {
  const decode = (text) => text.replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const relativeTime = (iso) => {
    if (!iso) return '';
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (!Number.isFinite(minutes) || minutes < 0) return '';
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
    return `${Math.round(minutes / 1440)}d ago`;
  };
  return (platformData?.news?.items ?? []).map((item) => ({ ...item, title: decode(item.title), time: relativeTime(item.publishedAt) }));
};

const fxOutlook = [
  ['USD', 'Strength', '68', 'positive', 'Growth and carry support'],
  ['EUR', 'Neutral', '49', 'neutral', 'Policy gap stabilizing'],
  ['JPY', 'Weakness', '36', 'negative', 'Wide rate differential'],
  ['GBP', 'Neutral', '53', 'neutral', 'Sticky inflation support'],
  ['CHF', 'Strength', '62', 'positive', 'Safe-haven bid'],
  ['AUD', 'Strength', '59', 'positive', 'Metals and China impulse'],
  ['CAD', 'Neutral', '51', 'neutral', 'Oil offsets rate drag'],
  ['NZD', 'Weakness', '43', 'negative', 'Growth sensitivity'],
  ['CNY/CNH', 'Weakness', '41', 'negative', 'Managed policy bias'],
];


const heatmapColumns = [
  ['score', 'Score'],
  ['regime', 'Regime'],
  ['trend', 'Trend'],
  ['momentum', 'Momentum'],
  ['volatility', 'Volatility'],
  ['crowding', 'Crowding'],
  ['alignment', 'Alignment'],
];


// Market plumbing has no keyless public source. Each row names the feed it
// needs rather than showing a reading nobody measured.
const physicalMarket = [
  ['LBMA vs futures', 'LBMA benchmark prices (licensed)'],
  ['Spot/futures spread', 'Spot fixings alongside COMEX settlements'],
  ['Futures basis', 'Full COMEX forward curve'],
  ['Physical premiums', 'Regional dealer premium survey'],
  ['Supply stress', 'Refinery and mine output filings'],
  ['Delivery stress', 'Exchange registered-stock reports'],
];

function Sparkline({ color, values }) {
  const points = values.map((value, index) => `${index * (100 / (values.length - 1))},${40 - value}`).join(' ');
  return <svg className="sparkline" viewBox="0 0 100 42" preserveAspectRatio="none"><polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}

function correlationTone(value) {
  return value > 0.2 ? 'correlation-positive' : value < -0.2 ? 'correlation-negative' : 'correlation-neutral';
}

function scoreTone(value) {
  if (!Number.isFinite(value)) return 'neutral';
  return value >= 60 ? 'positive' : value <= 40 ? 'negative' : 'neutral';
}

function buildChartGeometry(points, width = 640, height = 220) {
  if (points.length < 2) return null;
  const values = points.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const spread = high - low || 1;
  const coordinates = values.map((value, index) => ({
    x: index * (width / (values.length - 1)),
    y: 8 + ((high - value) / spread) * (height - 16),
  }));
  const polyline = coordinates.map(({ x, y }) => `${x},${y}`).join(' ');

  return {
    polyline,
    area: `M${coordinates[0].x},${coordinates[0].y} ${coordinates.slice(1).map(({ x, y }) => `L${x},${y}`).join(' ')} L${width},${height} L0,${height}Z`,
    currentY: coordinates.at(-1).y,
    open: values[0],
    high,
    low,
    latest: values.at(-1),
  };
}

function formatChartLabel(timestamp, includeTime) {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat('en-US', includeTime
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

function normalizeSparkline(values) {
  if (!values.length) return [];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const spread = maximum - minimum || 1;
  return values.map((value) => 5 + (((value - minimum) / spread) * 30));
}

function formatLiquidityValue(value) {
  if (!Number.isFinite(value)) return 'Unavailable';
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000) return `${value < 0 ? '-' : ''}$${(absolute / 1_000_000).toFixed(2)}T`;
  if (absolute >= 1_000) return `${value < 0 ? '-' : ''}$${(absolute / 1_000).toFixed(1)}B`;
  return `${value < 0 ? '-' : ''}$${absolute.toFixed(0)}M`;
}

function LiquidityHistoryChart({ history, range, onRangeChange, expanded = false, label = 'net US liquidity' }) {
  const [hoveredIndex, setHoveredIndex] = React.useState(null);
  const [pinnedIndex, setPinnedIndex] = React.useState(null);
  const latestDate = new Date(history.at(-1)?.date).getTime();
  const rangeDays = { '1Y': 366, '3Y': 1_096, '5Y': 1_827 };
  const cutoff = rangeDays[range] && Number.isFinite(latestDate) ? latestDate - (rangeDays[range] * 86_400_000) : null;
  const points = history.filter((point) => Number.isFinite(point.value) && point.date && (cutoff === null || new Date(point.date).getTime() >= cutoff));
  const width = 920;
  const height = expanded ? 390 : 220;
  const padding = { top: 20, right: 18, bottom: 34, left: 62 };
  const values = points.map((point) => point.value);
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const spread = high - low || 1;
  const coordinates = points.map((point, index) => ({
    x: padding.left + (index * ((width - padding.left - padding.right) / Math.max(1, points.length - 1))),
    y: padding.top + (((high - point.value) / spread) * (height - padding.top - padding.bottom)),
  }));
  const polyline = coordinates.map((point) => `${point.x},${point.y}`).join(' ');
  const requestedIndex = pinnedIndex ?? hoveredIndex ?? (points.length ? points.length - 1 : null);
  const activeIndex = requestedIndex === null ? null : Math.min(requestedIndex, points.length - 1);
  const activePoint = activeIndex === null ? null : points[activeIndex];
  const activeCoordinate = activeIndex === null ? null : coordinates[activeIndex];
  const priorPoint = activeIndex !== null && activeIndex >= 13 ? points[activeIndex - 13] : null;
  const change13w = priorPoint?.value ? ((activePoint.value / priorPoint.value) - 1) * 100 : null;
  const labelIndexes = points.length ? [0, .25, .5, .75, 1].map((position) => Math.round((points.length - 1) * position)) : [];

  const selectNearest = (event, pin = false) => {
    if (!points.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const chartStart = padding.left / width;
    const chartWidth = (width - padding.left - padding.right) / width;
    const ratio = Math.min(1, Math.max(0, (((event.clientX - bounds.left) / bounds.width) - chartStart) / chartWidth));
    const index = Math.round(ratio * (points.length - 1));
    setHoveredIndex(index);
    if (pin) setPinnedIndex((current) => current === index ? null : index);
  };

  if (points.length < 2) return <div className="liquidity-history-empty">No aligned liquidity history is available.</div>;
  return <div className={`liquidity-history-workspace ${expanded ? 'expanded' : ''}`}>
    <div className="liquidity-history-toolbar">
      <div><b>{formatLiquidityValue(activePoint?.value)}</b><span>{activePoint?.date ?? 'No date'}{Number.isFinite(change13w) ? ` · 13W ${change13w >= 0 ? '+' : ''}${change13w.toFixed(2)}%` : ''}</span></div>
      <div className="window-buttons">{['1Y', '3Y', '5Y', 'All'].map((item) => <button className={range === item ? 'selected' : ''} key={item} onClick={() => { onRangeChange(item); setPinnedIndex(null); }}>{item}</button>)}</div>
    </div>
    <div className="liquidity-history-plot" onPointerMove={selectNearest} onPointerLeave={() => setHoveredIndex(null)} onClick={(event) => selectNearest(event, true)}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Calculated ${label} from ${points[0].date} through ${points.at(-1).date}`}>
        <defs><linearGradient id={expanded ? 'liquidity-fill-expanded' : 'liquidity-fill'} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#78c968" stopOpacity=".28"/><stop offset="1" stopColor="#78c968" stopOpacity=".02"/></linearGradient></defs>
        {[0, .25, .5, .75, 1].map((position) => { const y = padding.top + (position * (height - padding.top - padding.bottom)); return <g key={position}><line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="liquidity-grid-line"/><text x={padding.left - 9} y={y + 4} textAnchor="end" className="liquidity-axis-label">{formatLiquidityValue(high - (position * spread))}</text></g>; })}
        <path d={`M${coordinates[0].x},${height - padding.bottom} L${coordinates.map((point) => `${point.x},${point.y}`).join(' L')} L${coordinates.at(-1).x},${height - padding.bottom} Z`} fill={`url(#${expanded ? 'liquidity-fill-expanded' : 'liquidity-fill'})`}/>
        <polyline points={polyline} fill="none" stroke="#71c45f" strokeWidth={expanded ? 2.5 : 2} vectorEffect="non-scaling-stroke"/>
        {activeCoordinate && <g><line x1={activeCoordinate.x} x2={activeCoordinate.x} y1={padding.top} y2={height - padding.bottom} className="liquidity-crosshair"/><circle cx={activeCoordinate.x} cy={activeCoordinate.y} r="5" className="liquidity-active-point" vectorEffect="non-scaling-stroke"/></g>}
        {labelIndexes.map((index) => <text key={`${points[index].date}-${index}`} x={coordinates[index].x} y={height - 8} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} className="liquidity-axis-label">{new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit' }).format(new Date(points[index].date))}</text>)}
      </svg>
      {activeCoordinate && <div className={`liquidity-point-tooltip ${activeCoordinate.x > width * .78 ? 'align-right' : ''}`} style={{ left: `${(activeCoordinate.x / width) * 100}%`, top: `${(activeCoordinate.y / height) * 100}%` }}><b>{activePoint.date}</b><span>{formatLiquidityValue(activePoint.value)}</span><small>{pinnedIndex === activeIndex ? 'Pinned · click to release' : 'Click to pin point'}</small></div>}
    </div>
    <p className="liquidity-vintage-note">Current-vintage FRED reconstruction. Use for exploratory replay; a look-ahead-safe backtest requires point-in-time ALFRED vintages.</p>
  </div>;
}

function LiquidityChartDialog({ history, title, description, label, onClose }) {
  const [range, setRange] = React.useState('All');
  React.useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);
  return <div className="liquidity-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="liquidity-dialog panel" role="dialog" aria-modal="true" aria-labelledby="liquidity-dialog-title">
      <header><div><p className="section-kicker">HISTORICAL MODEL INSPECTOR</p><h2 id="liquidity-dialog-title">{title}</h2><p>{description}</p></div><button className="liquidity-dialog-close" onClick={onClose} aria-label="Close liquidity chart">×</button></header>
      <LiquidityHistoryChart history={history} range={range} onRangeChange={setRange} expanded label={label} />
    </section>
  </div>;
}

class WorkspaceErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Workspace render failed:', error, info?.componentStack);
  }

  componentDidUpdate(previousProps) {
    // Moving to another workspace clears the failure, so one bad payload does
    // not strand the user on an error screen.
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <section className="workspace-error panel">
      <p className="section-kicker">WORKSPACE UNAVAILABLE</p>
      <h3>This workspace could not be rendered.</h3>
      <p>A value in the {this.props.resetKey} payload was not the shape the view expected, so the panel was stopped rather than left half-drawn. Every other workspace is unaffected — pick one from the sidebar, or reload once the provider recovers.</p>
      <code>{this.state.error?.message ?? String(this.state.error)}</code>
    </section>;
  }
}

function App() {
  const initialRoute = React.useRef(parseRoute(window.location.hash, watchlistSymbols)).current;
  const [activeNav, setActiveNav] = React.useState(initialRoute.nav);
  const [period, setPeriod] = React.useState('1D');
  const [selectedTicker, setSelectedTicker] = React.useState(initialRoute.symbol ?? 'NVDA');
  const [theme, setTheme] = React.useState(() => window.localStorage.getItem('tradegate-theme') ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [commandIndex, setCommandIndex] = React.useState(0);
  const searchInputRef = React.useRef(null);
  const routeSynced = React.useRef(false);
  const platformData = usePlatformData();
  const history = useMarketHistory(selectedTicker, period);
  const technical = useTechnicalAnalytics(selectedTicker);
  const nvdaSpark = useMarketHistory('NVDA', '1M');
  const aaplSpark = useMarketHistory('AAPL', '1M');
  const gldSpark = useMarketHistory('GLD', '1M');
  const btcSpark = useMarketHistory('BTC', '1M');
  const sparkByTicker = { NVDA: nvdaSpark, AAPL: aaplSpark, GLD: gldSpark, BTC: btcSpark };
  const quotesByKey = Object.fromEntries((platformData.markets?.assets ?? []).map((asset) => [asset.key, asset]));
  const hydratedWatchlist = watchlist.map((asset) => ({ ...asset, quote: quotesByKey[asset.ticker] ?? null }));
  const selectedAsset = hydratedWatchlist.find((asset) => asset.ticker === selectedTicker) ?? hydratedWatchlist[0];
  const selectedQuote = selectedAsset.quote;
  const technicalModel = technical.data?.model;
  const chartGeometry = buildChartGeometry(history.data?.points ?? []);
  const historyLabels = history.data?.points?.length ? [0, .25, .5, .75, 1].map((position) => {
    const index = Math.min(history.data.points.length - 1, Math.round((history.data.points.length - 1) * position));
    return formatChartLabel(history.data.points[index].timestamp, period === '1D' || period === '5D');
  }) : [];
  const commands = [
    { label: 'Overview', detail: 'Workspace', action: () => setActiveNav('Overview') },
    { label: 'Multi-asset heatmap', detail: 'Markets', action: () => setActiveNav('Markets') },
    { label: 'Equities research', detail: 'Global indices and sectors', action: () => setActiveNav('Equities') },
    { label: 'Precious metals research', detail: 'Metals', action: () => setActiveNav('Metals') },
    { label: 'Macro research', detail: 'Liquidity and regime', action: () => setActiveNav('Macro') },
    { label: 'Forex research', detail: 'Momentum and CFTC positioning', action: () => setActiveNav('Forex') },
    { label: 'Crypto research', detail: 'Bitcoin cycle and dollar tailwind', action: () => setActiveNav('Crypto') },
    { label: 'S&P 500 screener', detail: 'Calculated cross-sectional screens', action: () => setActiveNav('Screener') },
    { label: 'Watchlists', detail: 'Local lists with live signals', action: () => setActiveNav('Watchlists') },
    ...watchlist.map((asset) => ({ label: asset.ticker, detail: asset.name, action: () => { setSelectedTicker(asset.ticker); setActiveNav('Overview'); } })),
  ];
  const matchingCommands = commands.filter((command) => `${command.label} ${command.detail}`.toLowerCase().includes(searchQuery.toLowerCase()));

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem('tradegate-theme', theme);
  }, [theme]);

  React.useEffect(() => {
    const onHashChange = () => {
      const route = parseRoute(window.location.hash, watchlistSymbols);
      setActiveNav(route.nav);
      if (route.symbol) setSelectedTicker(route.symbol);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  React.useEffect(() => {
    const next = buildRoute(activeNav, activeNav === 'Overview' ? selectedTicker : null);
    if (window.location.hash !== next) {
      // The first render adopts whatever the address bar already held, so it
      // must not push a duplicate entry the user has to press Back through.
      if (routeSynced.current) window.location.hash = next;
      else window.history.replaceState(null, '', next);
    }
    routeSynced.current = true;
  }, [activeNav, selectedTicker]);

  React.useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchQuery('');
        setCommandIndex(0);
        setSearchOpen(true);
      }
      if (event.key === 'Escape') setSearchOpen(false);
      if (searchOpen && matchingCommands.length) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setCommandIndex((index) => (index + 1) % matchingCommands.length);
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setCommandIndex((index) => (index - 1 + matchingCommands.length) % matchingCommands.length);
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          matchingCommands[commandIndex]?.action();
          setSearchOpen(false);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commandIndex, matchingCommands, searchOpen]);

  React.useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchOpen]);

  const openSearch = () => {
    setSearchQuery('');
    setCommandIndex(0);
    setSearchOpen(true);
  };

  const toggleTheme = () => setTheme((currentTheme) => currentTheme === 'light' ? 'dark' : 'light');

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">T</span><span>tradegate</span></div>
        <nav>
          <p className="nav-kicker">WORKSPACE</p>
          {navItems.map(([icon, label, status]) => <button key={label} className={`nav-item ${activeNav === label ? 'active' : ''}`} onClick={() => setActiveNav(label)}><span>{icon}</span>{label}{status && <small className="nav-preview">{status}</small>}</button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="trial-card"><span className="trial-icon">✦</span><strong>Unlock the full view</strong><p>Get powerful research tools, all in one place.</p><button>Explore Pro <span>→</span></button></div>
          <button className="profile"><span className="avatar">AS</span><span className="profile-copy"><strong>Alex Simmons</strong><small>Free plan</small></span><span className="dots">•••</span></button>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div className="crumb"><span>Research</span><b>/</b><strong>{activeNav}</strong></div>
          <div className="top-actions"><DataStatus data={platformData} /><button className="search" onClick={openSearch} aria-label="Search research"><span>⌕</span><span>Search anything</span><kbd>⌘ K</kbd></button><button className="icon-button theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>{theme === 'light' ? '☾' : '☼'}</button><button className="icon-button" aria-label="Help">?</button></div>
        </header>

        <div className="dashboard">
          <WorkspaceErrorBoundary resetKey={activeNav}>
          {activeNav === 'Macro' ? <MacroDashboard data={platformData} /> : activeNav === 'Forex' ? <ForexDashboard data={platformData} /> : activeNav === 'Crypto' ? <CryptoDashboard data={platformData} /> : activeNav === 'Markets' ? <MarketsDashboard data={platformData} /> : activeNav === 'Equities' ? <EquitiesDashboard platformData={platformData} /> : activeNav === 'Metals' ? <MetalsDashboard data={platformData} /> : activeNav === 'Screener' ? <ScreenerDashboard data={platformData} /> : activeNav === 'Watchlists' ? <WatchlistsDashboard data={platformData} /> : <>
          <section className="welcome-row">
            <div><p className="eyebrow">{new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase()}</p><h1>Good morning, Alex.</h1><p className="intro">Here is your market pulse for today.</p></div>
            <div className={`market-status ${platformData.status}`}><span className="live-dot"></span><span>{platformData.status === 'live' ? 'Data feeds connected' : platformData.status === 'partial' ? 'Partial data coverage' : 'Data API unavailable'}</span><strong>{formatTimestamp(platformData.markets?.asOf)}</strong></div>
          </section>

          <DataDisclosure data={platformData} message="Live quotes and historical charts are provider-backed. Research scores and narrative signals remain model previews until their calculation pipelines are connected." />

          <section className="market-strip">
            <div className="market-label"><span className="globe">◉</span><div><b>Live market proxies</b><small>{formatTimestamp(platformData.markets?.asOf)}</small></div></div>
            <MarketCell name="S&P 500 ETF" quote={quotesByKey.SPY} />
            <MarketCell name="Nasdaq 100 ETF" quote={quotesByKey.QQQ} />
            <MarketCell name="Gold ETF" quote={quotesByKey.GLD} />
            <MarketCell name="Bitcoin" quote={quotesByKey.BTC} />
            <button className="strip-more">•••</button>
          </section>

          <section className="focus-header"><div><p className="section-kicker">IN FOCUS</p><h2>{selectedTicker} <span>·</span> {selectedAsset.name}</h2></div><button className="watch-button">☆ Add to watchlist</button></section>

          <section className="focus-grid">
            <article className="chart-card panel">
              <div className="chart-top"><div><p className="quote">{formatUsd(selectedQuote?.price)} <span>USD</span></p><p className={`gain ${selectedQuote?.changePercent < 0 ? 'negative' : ''}`}>{formatPercent(selectedQuote?.changePercent)} <small>{selectedQuote ? `${selectedQuote.source} · ${formatTimestamp(selectedQuote.asOf)}` : 'Configure a market provider'}</small></p></div><div className="range-selector">{['1D', '5D', '1M', '6M', 'YTD', '1Y', 'All'].map(item => <button className={period === item ? 'selected' : ''} key={item} onClick={() => setPeriod(item)}>{item}</button>)}</div></div>
              <div className="chart-area">{chartGeometry ? <><div className="price-line" style={{ top: `${chartGeometry.currentY}px` }}><span>{formatUsd(chartGeometry.latest)}</span><span className="price-tag">{chartGeometry.latest.toFixed(chartGeometry.latest < 100 ? 2 : 0)}</span></div><svg viewBox="0 0 640 220" preserveAspectRatio="none" aria-label={`${selectedTicker} ${period} price history from ${history.data.source}`}><defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#7dff77" stopOpacity=".25"/><stop offset="1" stopColor="#7dff77" stopOpacity="0"/></linearGradient></defs><path d={chartGeometry.area} fill="url(#fill)"/><polyline points={chartGeometry.polyline} fill="none" stroke="#83ec69" strokeWidth="3" vectorEffect="non-scaling-stroke"/></svg><div className="chart-times">{historyLabels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div></> : <div className="chart-unavailable"><span>{history.status === 'loading' ? 'Loading history' : 'Historical feed unavailable'}</span><p>{selectedTicker === 'BTC' ? 'The public crypto provider did not return history.' : 'Add `TWELVE_DATA_API_KEY` on the server to enable this chart.'}</p></div>}</div>
              <div className="chart-footer">{chartGeometry ? <><span>Open <b>{formatUsd(chartGeometry.open)}</b></span><span>High <b>{formatUsd(chartGeometry.high)}</b></span><span>Low <b>{formatUsd(chartGeometry.low)}</b></span><span>Latest <b>{formatUsd(chartGeometry.latest)}</b></span><span>Source <b>{history.data.source}</b></span></> : <span>Historical market statistics will appear when the feed is available.</span>}</div>
            </article>

            <article className="thesis-card panel"><div className="thesis-heading"><div><p className="section-kicker">CALCULATED SIGNAL</p><h3>Technical state</h3></div><span className="data-pill">{technicalModel?.version ?? 'Awaiting data'}</span></div><div className={`signal ${technicalModel?.regime === 'Guarded' ? 'guarded' : technicalModel?.regime === 'Neutral' ? 'neutral-signal' : ''}`}><span className="signal-icon">{technicalModel?.regime === 'Guarded' ? '↘' : '↗'}</span><div><strong>{technicalModel?.regime ?? (technical.status === 'loading' ? 'Calculating' : 'Unavailable')}</strong><p>{technicalModel ? `Score ${technicalModel.score}/100 from ${technicalModel.observations} provider observations. RSI ${technicalModel.indicators.rsi14?.toFixed(1) ?? 'n/a'}.` : selectedTicker === 'BTC' ? 'The public history provider did not return enough observations.' : 'Configure Twelve Data history to calculate this signal.'}</p></div></div><div className="factor"><span>Trend alignment</span><div className="factor-bar"><i style={{ width: `${technicalModel?.components.trend ?? 0}%` }}></i></div><b>{technicalModel?.components.trend ?? '—'}</b></div><div className="factor"><span>Momentum</span><div className="factor-bar neutral"><i style={{ width: `${technicalModel?.components.momentum ?? 0}%` }}></i></div><b>{technicalModel?.components.momentum ?? '—'}</b></div><div className="factor"><span>Volatility quality</span><div className="factor-bar"><i style={{ width: `${technicalModel?.components.volatilityQuality ?? 0}%` }}></i></div><b>{technicalModel?.components.volatilityQuality ?? '—'}</b></div><p className="updated">{technicalModel ? `${technical.data.source}${technical.data.stale ? ' · stale fallback' : ''} · ${formatTimestamp(technicalModel.asOf)}` : 'No model output is being shown as a fallback.'}</p></article>
          </section>

          <section className="lower-grid">
            <article className={`watchlist-card panel ${watchlist.every((item) => (sparkByTicker[item.ticker]?.data?.points?.length ?? 0) > 0) ? '' : 'preview-section'}`}><div className="card-heading"><div><p className="section-kicker">LIVE PRICES · CALCULATED SPARKLINES</p><h3>Watchlist</h3></div><button>View all <span>→</span></button></div><div className="watchlist-table">{hydratedWatchlist.map((item) => <button className={`watch-row ${selectedTicker === item.ticker ? 'watch-selected' : ''}`} onClick={() => setSelectedTicker(item.ticker)} key={item.ticker}><span className="asset-badge" style={{ backgroundColor: item.color }}>{item.ticker.charAt(0)}</span><span className="asset-name"><b>{item.ticker}</b><small>{item.name}</small></span><span className="mini-chart">{(sparkByTicker[item.ticker]?.data?.points?.length ?? 0) > 0 ? <Sparkline color={item.color} values={normalizeSparkline(sparkByTicker[item.ticker].data.points.map((point) => point.value))} /> : <Sparkline color={item.color} values={[0, 0]} />}</span><span className="asset-price"><b>{formatUsd(item.quote?.price)}</b><small className={item.quote?.changePercent < 0 ? 'negative' : ''}>{formatPercent(item.quote?.changePercent)}{item.quote?.stored ? ' · stored' : ''}</small></span></button>)}</div></article>
            {(() => {
              const wireItems = newsWireItems(platformData);
              const news = platformData?.news;
              return <article className={`news-card panel ${wireItems.length ? '' : 'preview-section'}`}><div className="card-heading"><div><p className="section-kicker">MACRO WIRE · CALCULATED</p><h3>Market intelligence</h3></div><span className="data-pill">{news?.toneCounts ? `${news.toneCounts.positive}▲ · ${news.toneCounts.negative}▼ · ${news.toneCounts.neutral}—` : platformData?.news?.sources?.length ? platformData.news.sources.join(' · ') : 'Awaiting feeds'}</span></div><div className="news-list">{wireItems.slice(0, 6).map((item) => <a className="news-item" href={item.link} target="_blank" rel="noreferrer" key={item.title + item.publishedAt}><div><p><span>{item.source}</span> <small>{item.time}</small> {item.tone && item.tone !== 'neutral' ? <i className={`wire-tone wire-${item.tone}`}>{item.tone === 'positive' ? '▲' : '▼'} {item.tone}</i> : null}</p><h4>{item.title}</h4></div><span className="news-arrow">↗</span></a>)}</div>{wireItems.length > 6 && <p className="model-footnote">{wireItems.length} headlines aggregated from Federal Reserve, CNBC, and MarketWatch RSS wires, newest first. Tones come from a transparent keyword lexicon; unmatched headlines stay neutral.</p>}</article>;
            })()}
          </section>
          <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
          </>}
          </WorkspaceErrorBoundary>
        </div>
      </section>
      {searchOpen && <div className="command-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}>
        <section className="command-palette" role="dialog" aria-modal="true" aria-label="Search research">
          <div className="command-input-wrap"><span>⌕</span><input ref={searchInputRef} value={searchQuery} onChange={(event) => { setSearchQuery(event.target.value); setCommandIndex(0); }} placeholder="Search research, markets, or symbols" /><kbd>ESC</kbd></div>
          <div className="command-results"><p>QUICK ACCESS</p>{matchingCommands.length ? matchingCommands.map((command, index) => <button className={commandIndex === index ? 'command-selected' : ''} key={`${command.label}-${command.detail}`} onMouseEnter={() => setCommandIndex(index)} onClick={() => { command.action(); setSearchOpen(false); }}><span className="command-result-icon">{command.label.length <= 4 ? command.label.charAt(0) : '◌'}</span><span><b>{command.label}</b><small>{command.detail}</small></span><i>↵</i></button>) : <div className="command-empty">No matching research found.</div>}</div>
          <footer><span><kbd>↑↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span><kbd>ESC</kbd> Close</span></footer>
        </section>
      </div>}
    </main>
  );
}

function DataStatus({ data }) {
  const labels = { loading: 'Connecting', live: 'Live data', partial: 'Partial data', offline: 'Offline' };
  const providers = Object.values(data.health?.providers ?? {}).length;
  const serving = providers - (data.platform?.degraded?.length ?? 0);
  const blocked = data.platform?.blocked ?? [];
  const title = [
    providers ? `${serving} of ${providers} providers serving` : null,
    data.error,
    blocked.length ? `Blocked upstream: ${blocked.join(', ')}` : null,
  ].filter(Boolean).join('\n');
  return <span className={`data-status ${data.status}`} title={title || labels[data.status]}><i></i>{labels[data.status]}</span>;
}

function DataDisclosure({ data, message }) {
  const title = data.status === 'offline' ? 'Data service offline' : data.status === 'partial' ? 'Provider coverage is partial' : data.status === 'loading' ? 'Connecting to data service' : 'Provider data connected';
  return <section className={`data-disclosure ${data.status}`}><span className="data-disclosure-icon">{data.status === 'live' ? '✓' : 'i'}</span><div><b>{title}</b><p>{message}</p></div></section>;
}

function PreviewBadge({ label = 'Preview' }) {
  return <span className="preview-badge">{label}</span>;
}

function EquityStatus({ status = 'unavailable', label }) {
  const tone = ['ready', 'calculated', 'available', 'live'].includes(status)
    ? 'available'
    : ['partial', 'provisional', 'stale', 'loading'].includes(status) ? 'partial' : 'unavailable';
  return <span className={`equity-status ${tone}`}><i></i>{label ?? status}</span>;
}

function formatResearchDate(value) {
  if (!value) return 'No provider date';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(value));
}

function EquitySignalCard({ kicker, title, model, empty, coverageLabel = 'driver coverage' }) {
  return <article className="equity-signal-card panel">
    <div className="equity-signal-head"><div><p className="section-kicker">{kicker}</p><h3>{model?.risk ?? model?.signal ?? model?.regime ?? title}</h3></div><EquityStatus status={model?.status} /></div>
    <div className="equity-signal-score"><b>{Number.isFinite(model?.score) ? model.score : '—'}</b><span>/100</span><i><b style={{ width: `${model?.score ?? 0}%` }}></b></i></div>
    <p>{model?.status === 'unavailable' || !model ? empty : `${model.version} · ${model.coverage}% ${coverageLabel}`}</p>
    {model?.missing?.length ? <small>Missing: {model.missing.slice(0, 3).join(', ')}{model.missing.length > 3 ? ` +${model.missing.length - 3}` : ''}</small> : null}
  </article>;
}

function RequirementPanel({ title, dataset, requirements }) {
  return <article className="equity-requirement-panel panel"><div className="panel-title"><div><p className="section-kicker">REQUIRED DATASET</p><h3>{title}</h3></div><EquityStatus status={dataset?.status} /></div><p>{dataset?.reason ?? 'This dataset is not connected, so no score or directional claim is published.'}</p><div>{(dataset?.requirements ?? requirements ?? []).map((item) => <span key={item}>{item}</span>)}</div></article>;
}

const SHORT_QUADRANT = { Leading: 'Lead', Improving: 'Improve', Weakening: 'Weaken', Lagging: 'Lag' };

function RotationCell({ rotation }) {
  if (!rotation) return <em className="rotation-cell rotation-flat" title="Needs 20 sessions of history beyond the 60-session window">—</em>;
  const shift = `${rotation.relativeShift > 0 ? '+' : ''}${rotation.relativeShift}%`;
  const label = rotation.moved
    ? `${SHORT_QUADRANT[rotation.previousQuadrant] ?? rotation.previousQuadrant} → ${SHORT_QUADRANT[rotation.quadrant] ?? rotation.quadrant}`
    : rotation.direction;
  // The trail is the arc the sector travelled, oldest first. A single prior
  // reading cannot separate a sector arriving in leadership from one that has
  // been circling its edge for a quarter, so the whole path is in the tooltip.
  const trail = rotation.trail ?? [];
  const path = trail.length > 1
    ? trail.map((point) => SHORT_QUADRANT[point.quadrant] ?? point.quadrant).join(' → ')
    : rotation.path;
  const span = trail.length > 1 ? ` over ${rotation.trailSpansSessions} sessions (${trail.length} points, oldest first)` : ` over ${rotation.lookbackSessions} sessions`;
  return <em
    className={`rotation-cell ${rotation.direction === 'Strengthening' ? 'rotation-up' : rotation.direction === 'Fading' ? 'rotation-down' : 'rotation-flat'}`}
    title={`${path}${span} · 20-session excess return ${shift}${rotation.quadrantsVisited > 1 ? ` · ${rotation.quadrantsVisited} quadrants visited` : ' · held one quadrant throughout'}`}
  >{label}</em>;
}

/**
 * Two independent readings of how much of the tape is one trade: how tightly
 * sectors move together, and how far apart their returns end up. Both are
 * ranked against their own history, so a drifting baseline does not read as a
 * regime change.
 */
function SectorDispersionSection({ dispersion }) {
  const status = dispersion?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <>
    <section className="equity-section-heading"><div><p className="section-kicker">CORRELATION &amp; DISPERSION · {status.toUpperCase()}</p><h2>{published ? dispersion.regime : 'Awaiting fresh sector histories'}</h2></div>{published ? <span className="data-pill">{dispersion.sectors} sectors · {dispersion.observations} shared sessions</span> : null}</section>
    <section className="equity-macro-matrix">
      <article className="equity-rotation-panel panel wide">
        {published ? <>
          <div className="equity-rotation-head styles-head"><span>Reading</span><span>Value</span></div>
          <div className="equity-rotation-row styles-row"><span><strong>Average pairwise correlation</strong><small>{Number.isFinite(dispersion.correlationPercentile) ? `${dispersion.correlationPercentile}th percentile of ${dispersion.rankedAgainst} rolling readings` : `Ranked against fixed levels — only ${dispersion.rankedAgainst} rolling readings available`}</small></span><b>{dispersion.correlation.toFixed(2)}</b></div>
          <div className="equity-rotation-row styles-row"><span><strong>Return dispersion</strong><small>{`Standard deviation of ${dispersion.returnWindow}-session sector returns`}</small></span><b>{Number.isFinite(dispersion.dispersion) ? `${dispersion.dispersion}%` : '—'}</b></div>
          <div className="equity-rotation-row styles-row"><span><strong>Leader minus laggard</strong><small>{dispersion.leader && dispersion.laggard ? `${dispersion.leader.name} vs ${dispersion.laggard.name}` : 'Awaiting sector returns'}</small></span><b>{Number.isFinite(dispersion.spread) ? `${dispersion.spread}%` : '—'}</b></div>
          <div className="equity-rotation-row styles-row"><span><strong>Sectors beating the benchmark</strong><small>{Number.isFinite(dispersion.benchmarkReturn) ? `Benchmark ${dispersion.benchmarkReturn > 0 ? '+' : ''}${dispersion.benchmarkReturn}% over ${dispersion.returnWindow} sessions` : 'Benchmark history required'}</small></span><b>{Number.isFinite(dispersion.leadershipBreadth) ? `${dispersion.sectorsBeatingBenchmark} of ${dispersion.sectors} · ${dispersion.leadershipBreadth}%` : '—'}</b></div>
        </> : <div className="equity-empty">{dispersion?.reason ?? 'Correlation and dispersion publish once several sector histories share enough sessions.'}</div>}
        <p className="equity-source-line">{published ? dispersion.read : ''}</p>
        <p className="equity-source-line">{dispersion?.methodology ?? ''}</p>
      </article>
    </section>
  </>;
}

/** Where the index sits inside its own drawdown history. */
function DrawdownProfilePanel({ drawdown }) {
  const status = drawdown?.status ?? 'unavailable';
  const published = status === 'calculated';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">DRAWDOWN PROFILE · {status.toUpperCase()}</p><h3>{published ? drawdown.state : 'Awaiting a multi-year close history'}</h3></div>{published ? <span className="data-pill">{drawdown.observations} sessions</span> : null}</div>
    {published ? <>
      <div className="detail-score"><span>Below the running peak</span><b>{drawdown.drawdownPercent}%</b><small>{drawdown.inDrawdown ? `${drawdown.sessionsSincePeak} sessions since the ${drawdown.peakDate} peak of ${drawdown.peak}` : `New high — this history spent ${drawdown.underwaterSharePercent}% of its sessions below a prior peak`}</small></div>
      <div className="stat-row"><span><strong>Depth percentile</strong><small>Against every session in this history</small></span><b>{ordinal(drawdown.depthPercentile)}</b></div>
      <div className="stat-row"><span><strong>Completed episodes</strong><small>{Number.isFinite(drawdown.medianCompletedTrough) ? `Median trough ${drawdown.medianCompletedTrough}%` : 'None completed inside this window'}</small></span><b>{drawdown.completedEpisodes}</b></div>
      <div className="stat-row"><span><strong>Worst completed episode</strong><small>{drawdown.deepest ? `From the ${drawdown.deepest.peakDate} peak · ${drawdown.deepest.recoverySessions} sessions to recover` : 'No episode has completed inside this window'}</small></span><b>{drawdown.deepest ? `${drawdown.deepest.trough}%` : '—'}</b></div>
    </> : <div className="equity-empty">{drawdown?.reason ?? 'A multi-year daily close history is required.'}</div>}
    <p className="model-footnote">{published ? `${drawdown.read} Measured on ${drawdown.source ?? 'the available close history'}.` : ''} {drawdown?.methodology ?? ''}</p>
  </article>;
}

/**
 * Realized volatility at three horizons, each against its own past. A short
 * window above a long one is a shock in progress, which is a different tape
 * from a market that has simply been volatile all year.
 */
/** 1st, 2nd, 3rd, 4th — "43th" is the giveaway that a suffix was hardcoded. */
function ordinal(value) {
  if (!Number.isFinite(value)) return '—';
  const lastTwo = Math.abs(value) % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`;
  return `${value}${{ 1: 'st', 2: 'nd', 3: 'rd' }[Math.abs(value) % 10] ?? 'th'}`;
}

function VolatilityTermPanel({ volatility }) {
  const status = volatility?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">VOLATILITY TERM STRUCTURE · {status.toUpperCase()}</p><h3>{published ? volatility.state ?? 'Term structure incomplete' : 'Awaiting a multi-year close history'}</h3></div>{published && Number.isFinite(volatility.ratio) ? <span className="data-pill">{volatility.ratio} short/long</span> : null}</div>
    {published ? (volatility.terms ?? []).map((term) => <div className="stat-row" key={term.window}>
      <span><strong>{`${term.window}-session realized`}</strong><small>{Number.isFinite(term.percentile) ? `${ordinal(term.percentile)} percentile of ${term.rankedAgainst} readings` : `Ranked against only ${term.rankedAgainst} readings`}</small></span>
      <b>{Number.isFinite(term.annualizedPercent) ? `${term.annualizedPercent}%` : '—'}</b>
    </div>) : <div className="equity-empty">{volatility?.reason ?? 'A multi-year daily close history is required.'}</div>}
    <p className="model-footnote">{published ? volatility.read : ''} {volatility?.methodology ?? ''}</p>
  </article>;
}

/**
 * Analyst EPS revisions — the one leg here that can disagree with price for a
 * fundamental reason. Diffusion is how broad the revision is, the aggregate how
 * large; when they part company a few heavily covered names are carrying it.
 */
function RevisionBreadthPanel({ revisions }) {
  const status = revisions?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">EARNINGS REVISION BREADTH · {status.toUpperCase()}</p><h3>{published ? revisions.state : 'Awaiting analyst revision counts'}</h3></div>{published ? <span className="data-pill">{revisions.coverage}% of {revisions.universeRequested ?? revisions.universe} sampled</span> : null}</div>
    {published ? <>
      <div className="detail-score"><span>Aggregate revision balance</span><b>{revisions.aggregate > 0 ? '+' : ''}{revisions.aggregate}%</b><small>{`${revisions.totalUp} raises against ${revisions.totalDown} cuts across ${revisions.covered} names`}</small></div>
      <div className="stat-row"><span><strong>Diffusion</strong><small>{`${revisions.raised} raised · ${revisions.cut} cut · ${revisions.unchangedNames} balanced`}</small></span><b>{revisions.diffusion}%</b></div>
      <div className="stat-row"><span><strong>Most raised</strong><small>{(revisions.mostRaised ?? []).map((row) => `${row.symbol} ${row.net > 0 ? '+' : ''}${row.net}%`).join(' · ') || '—'}</small></span><b>{revisions.mostRaised?.[0]?.symbol ?? '—'}</b></div>
      <div className="stat-row"><span><strong>Most cut</strong><small>{(revisions.mostCut ?? []).map((row) => `${row.symbol} ${row.net > 0 ? '+' : ''}${row.net}%`).join(' · ') || '—'}</small></span><b>{revisions.mostCut?.[0]?.symbol ?? '—'}</b></div>
    </> : <div className="equity-empty">{revisions?.reason ?? 'Analyst revision counts are required.'}</div>}
    <p className="model-footnote">{published ? `${revisions.read} Source: ${revisions.source ?? 'unnamed'}.` : ''} {revisions?.methodology ?? ''}</p>
  </article>;
}

/**
 * Past breadth thrusts and what the benchmark did next. A live boolean says one
 * fired today; the log says whether they have meant anything here.
 */
function ThrustLogPanel({ breadth }) {
  const events = breadth?.thrustEvents ?? null;
  const published = Array.isArray(events);
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">BREADTH THRUST LOG · {published ? 'CALCULATED' : 'UNAVAILABLE'}</p><h3>{!published ? 'Awaiting constituent breadth' : events.length ? `${events.length} thrust${events.length === 1 ? '' : 's'} in the last ${breadth.thrustWindowSessions ?? '250'} sessions` : `No thrust in the last ${breadth.thrustWindowSessions ?? '250'} sessions`}</h3></div>{breadth?.thrustTriggered ? <span className="data-pill">Firing now</span> : null}</div>
    {published && events.length ? <>
      <div className="stat-head"><span>Episode</span><span>Benchmark after</span></div>
      {events.map((event) => <div className="stat-row" key={event.index}>
        <span><strong>{event.date ?? `${event.sessionsAgo} sessions ago`}</strong><small>{`${event.priorRatio}% advancing into it, ${event.triggerRatio}% out of it`}</small></span>
        <b className={Number.isFinite(event.forward60) ? (event.forward60 >= 0 ? 'positive' : 'negative') : ''}>{Number.isFinite(event.forward20) ? `${event.forward20 > 0 ? '+' : ''}${event.forward20}% / ` : 'pending / '}{Number.isFinite(event.forward60) ? `${event.forward60 > 0 ? '+' : ''}${event.forward60}%` : 'pending'}</b>
      </div>)}
    </> : <div className="equity-empty">{published ? 'A thrust needs the ten-session advance ratio to cross from below 40% to at or above 61.5%; that has not happened inside the window.' : 'Constituent breadth is required before past thrusts can be logged.'}</div>}
    <p className="model-footnote">Forward figures are the benchmark's return 20 and 60 sessions after the trigger; an episode too recent for its window to have closed reports pending rather than a truncated number. One sustained advance is logged once — the scan re-arms only after the tape washes out again.</p>
  </article>;
}

/**
 * Whether a sector labelled defensive actually defends. Capture is measured on
 * the days the benchmark rose and fell, and beta is reported with the spread of
 * its own rolling estimates, so a relationship that changed inside the window
 * cannot hide behind one number.
 */
function CaptureProfileSection({ capture }) {
  const status = capture?.status ?? 'unavailable';
  const rows = (capture?.sectors ?? []).filter((row) => row.status !== 'unavailable');
  return <>
    <section className="equity-section-heading"><div><p className="section-kicker">UP / DOWN CAPTURE · {status.toUpperCase()}</p><h2>Which sectors actually defend</h2></div><span className="data-pill">vs {capture?.benchmark ?? 'SPY'}</span></section>
    <section className="equity-macro-matrix">
      <article className="equity-rotation-panel panel wide">
        {rows.length ? <>
          <div className="equity-rotation-head capture-head"><span>Sector</span><span>Up capture</span><span>Down capture</span><span>Spread</span><span>Beta</span><span>Rolling beta</span><span>Behaviour</span></div>
          {rows.map((row) => <div className="equity-rotation-row capture-row" key={row.symbol}>
            <span><strong>{row.name}</strong><small>{`${row.symbol} · ${row.upDays}↑ / ${row.downDays}↓ days`}</small></span>
            <b>{Number.isFinite(row.upCapture) ? `${row.upCapture}%` : '—'}</b>
            <b className={!Number.isFinite(row.downCapture) || row.inverse ? '' : row.downCapture < 85 ? 'positive' : row.downCapture > 110 ? 'negative' : ''}>{Number.isFinite(row.downCapture) ? `${row.downCapture}%` : '—'}</b>
            <span className={Number.isFinite(row.captureSpread) ? (row.captureSpread >= 0 ? 'positive' : 'negative') : 'neutral'}>{Number.isFinite(row.captureSpread) ? `${row.captureSpread > 0 ? '+' : ''}${row.captureSpread}` : '—'}</span>
            <span>{Number.isFinite(row.beta) ? row.beta : '—'}</span>
            <small>{row.betaRange ? `${row.stability} · ${row.betaRange.low}–${row.betaRange.high}` : 'not yet rankable'}</small>
            <i>{row.behaviour ?? 'insufficient days'}</i>
          </div>)}
        </> : <div className="equity-empty">{capture?.sectors?.[0]?.reason ?? 'Fresh sector histories aligned with the benchmark are required before capture can be measured.'}</div>}
        <p className="equity-source-line">{rows[0]?.methodology ?? ''}</p>
      </article>
    </section>
  </>;
}

function EquitiesDashboard({ platformData }) {
  const [selectedSymbol, setSelectedSymbol] = React.useState('SPY');
  const research = useEquityResearch(selectedSymbol);
  const positioning = platformData?.positioning?.model;
  const catalog = research.catalog;
  const dashboard = research.dashboard;
  const sectorData = research.sectors;
  const technical = dashboard?.technical?.model;
  const regime = dashboard?.regime;
  const rotation = sectorData?.rotation;
  const groupedIndices = Object.entries((catalog?.indices ?? []).reduce((groups, index) => {
    groups[index.region] = [...(groups[index.region] ?? []), index];
    return groups;
  }, {}));
  const selectedIndex = dashboard?.index ?? catalog?.indices?.find((index) => index.symbol === selectedSymbol);

  return <div className="equities-dashboard">
    <section className="equities-intro">
      <div><p className="eyebrow">GLOBAL EQUITY RESEARCH</p><h1>Participation before prediction.</h1><p className="intro">Global index proxies, regime-aware signals, breadth readiness, and sector rotation with explicit source coverage.</p></div>
      <div className="equities-pulse"><EquityStatus status={research.status} label={research.status === 'live' ? 'API connected' : research.status} /><div><b>{selectedIndex?.name ?? 'Loading index'}</b><small>{selectedIndex ? `${selectedIndex.symbol} · ${selectedIndex.instrument}` : 'Awaiting catalog'}</small></div></div>
    </section>
    <section className="equity-disclosure"><span>i</span><div><b>Coverage-aware research</b><p>ETF prices are labeled as proxies. Unavailable breadth, positioning, sentiment, flow, and historical-vintage inputs remain blank rather than being replaced with designed values.</p></div></section>

    <section className="equity-index-layout">
      <article className="equity-index-panel panel">
        <div className="panel-title"><div><p className="section-kicker">GLOBAL INDEX COVERAGE</p><h3>Choose a market lens</h3></div><span className="data-pill">{catalog?.indices?.length ?? 0} tracked proxies</span></div>
        <div className="equity-region-list">{groupedIndices.length ? groupedIndices.map(([region, indices]) => <div className="equity-region" key={region}><p>{region}</p>{indices.map((index) => <button className={selectedSymbol === index.symbol ? 'selected' : ''} key={index.id} onClick={() => setSelectedSymbol(index.symbol)}><span><b>{index.name}</b><small>{index.symbol} · {index.instrument}</small></span><EquityStatus status={index.coverage.status} label={index.coverage.observations ? `${index.coverage.observations} obs.` : index.coverage.status} /></button>)}</div>) : <div className="equity-empty">{research.status === 'loading' ? 'Loading coverage catalog…' : 'Coverage catalog unavailable.'}</div>}</div>
      </article>

      <article className="equity-focus-panel panel">
        <div className="panel-title"><div><p className="section-kicker">SELECTED INDEX PROXY</p><h3>{selectedIndex?.name ?? 'Awaiting selection'}</h3></div><EquityStatus status={dashboard?.technical?.stale ? 'stale' : dashboard?.technical?.model ? 'available' : 'unavailable'} /></div>
        <div className="equity-focus-price"><b>{formatUsd(technical?.latest)}</b><span>{selectedIndex?.symbol ?? '—'}</span><small>{selectedIndex?.instrument ?? 'Provider history unavailable'}</small></div>
        <div className="equity-technical-grid"><div><span>Technical score</span><b>{technical?.score ?? '—'}</b></div><div><span>20D momentum</span><b>{formatPercent(technical?.indicators?.momentum20d)}</b></div><div><span>RSI 14</span><b>{technical?.indicators?.rsi14?.toFixed(1) ?? '—'}</b></div><div><span>20D volatility</span><b>{Number.isFinite(technical?.indicators?.annualizedVolatility20d) ? `${technical.indicators.annualizedVolatility20d.toFixed(1)}%` : '—'}</b></div></div>
        <p className="equity-source-line">{dashboard?.technical?.source ?? 'No market history source'} · {formatResearchDate(dashboard?.technical?.asOf)}</p>
      </article>
    </section>

    <section className="equity-section-heading"><div><p className="section-kicker">INDEX SIGNAL STACK</p><h2>What can be calculated now</h2></div><span className="data-pill">No synthetic fallbacks</span></section>
    <section className="equity-signal-grid">
      <EquitySignalCard kicker="DYNAMIC REGIME" title="Regime unavailable" model={regime} empty="Price trend, momentum, and volatility are mandatory before a regime can be classified." />
      <EquitySignalCard kicker="TOP-RISK DETECTION" title="Top risk unavailable" model={dashboard?.topRisk} empty="Top risk requires technical deterioration plus constituent breadth and independent confirmation." />
      <EquitySignalCard kicker="BOTTOM / RALLY DETECTION" title="Bottom signal unavailable" model={dashboard?.bottomSignal} empty="Bottom detection requires a breadth washout/thrust plus technical and macro confirmation." />
      <EquitySignalCard kicker="CONSTITUENT BREADTH" title={dashboard?.breadth?.status === 'calculated' ? 'Calculated breadth' : dashboard?.breadth?.status === 'partial' ? 'Partial breadth' : 'Breadth unavailable'} model={dashboard?.breadth} empty={dashboard?.breadth?.reason ?? 'Constituent histories are not connected.'} coverageLabel="constituent coverage" />
      <DrawdownProfilePanel drawdown={dashboard?.drawdown} />
      <VolatilityTermPanel volatility={dashboard?.volatility} />
      <RevisionBreadthPanel revisions={dashboard?.revisions} />
      <ThrustLogPanel breadth={dashboard?.breadth} />
    </section>

    <section className="equity-regime-layout">
      <article className="equity-driver-panel panel"><div className="panel-title"><div><p className="section-kicker">REGIME INPUTS</p><h3>{regime?.regime ?? 'Waiting for minimum coverage'}</h3></div><EquityStatus status={regime?.status} label={regime ? `${regime.coverage}% coverage` : 'unavailable'} /></div><div className="equity-driver-list">{(regime?.drivers ?? []).map((driver) => <div key={driver.key}><span><b>{driver.name}</b><small>{driver.source ?? 'Source unavailable'}</small></span><i><b style={{ width: `${driver.score ?? 0}%` }}></b></i><strong>{driver.score ?? '—'}</strong></div>)}</div></article>
      <article className="equity-settings-panel panel"><div className="panel-title"><div><p className="section-kicker">DYNAMIC PLAYBOOK</p><h3>Regime-dependent settings</h3></div><span className="data-pill">{regime?.version ?? 'No model'}</span></div>{regime?.settings ? <div className="equity-settings"><div><span>Alert threshold</span><b>{regime.settings.alertThreshold}/100</b></div><div><span>Holding period</span><b>{regime.settings.holdingPeriod}</b></div><div><span>Trend / momentum</span><b>{regime.settings.trend}% / {regime.settings.momentum}%</b></div><div><span>Mean reversion</span><b>{regime.settings.meanReversion}%</b></div><div><span>Defensive / macro</span><b>{regime.settings.defensive}% / {regime.settings.macro}%</b></div></div> : <div className="equity-empty">Settings are not published without a regime.</div>}<p>Weights, thresholds, and expected holding periods change with the classified regime; one static model is not applied across all conditions.</p></article>
    </section>

    <section className="equity-section-heading"><div><p className="section-kicker">SECTOR AND SUBSECTOR ROTATION</p><h2>Relative strength with stored history</h2></div><EquityStatus status={rotation?.status} /></section>
    {(rotation?.enteringLeadership?.length || rotation?.leavingLeadership?.length) ? <p className="watchlist-summary">Over the last {rotation.rotationLookbackSessions} sessions {rotation.enteringLeadership.length ? `${rotation.enteringLeadership.join(', ')} rotated into leadership` : 'no sector rotated into leadership'}{rotation.leavingLeadership.length ? ` · ${rotation.leavingLeadership.join(', ')} rolled out of it` : ' · none rolled out of it'}</p> : null}
    <section className="equity-sector-layout">
      <article className="equity-rotation-panel panel"><div className="equity-rotation-head"><span>Rank</span><span>Sector</span><span>Quadrant</span><span>Rotation 20D</span><span>20D vs SPY</span><span>60D vs SPY</span><span>Score</span></div>{rotation?.sectors?.length ? rotation.sectors.map((sector) => <div className="equity-rotation-row" key={sector.symbol}><b>{sector.rank}</b><span><strong>{sector.name}</strong><small>{sector.symbol} · {sector.sensitivity}</small></span><i className={sector.quadrant ? sector.quadrant.toLowerCase() : 'neutral'}>{sector.quadrant ?? '—'}</i><RotationCell rotation={sector.rotation} /><span className={sector.relative20 >= 0 ? 'positive' : 'negative'}>{formatPercent(sector.relative20)}</span><span className={sector.relative60 >= 0 ? 'positive' : 'negative'}>{formatPercent(sector.relative60)}</span><b>{sector.score}</b></div>) : <div className="equity-empty">{sectorData?.storage?.configured ? 'Run the daily history ingestion to calculate sector rotation.' : 'PostgreSQL history is required for sector rotation.'}</div>}<p className="equity-source-line">{sectorData?.methodology ?? 'Awaiting sector API.'}</p></article>
      <article className="equity-sector-coverage panel"><div className="panel-title"><div><p className="section-kicker">HISTORY READINESS</p><h3>Sectors and subsectors</h3></div><span className="data-pill">Twelve Data</span></div><div className="equity-coverage-list">{(sectorData?.sectors ?? []).map((sector) => <div key={sector.symbol}><span><b>{sector.symbol}</b><small>{sector.name}</small></span><EquityStatus status={sector.coverage.status} label={`${sector.coverage.observations} obs.`} /></div>)}</div><details><summary>Subsector coverage ({sectorData?.subsectors?.length ?? 0})</summary><div className="equity-subsector-list">{(sectorData?.subsectors ?? []).map((sector) => <div key={sector.symbol}><span>{sector.symbol}</span><b>{sector.name}</b><small>{sector.coverage.status}</small></div>)}</div></details></article>
    </section>

    {rotation?.subsectors?.length ? <section className="equity-section-heading"><div><p className="section-kicker">SUBSECTOR ROTATION</p><h2>Granular leadership inside each sector</h2></div><EquityStatus status="calculated" label={`${rotation.subsectors.length} tracked`} /></section> : null}
    {rotation?.subsectors?.length ? <section className="equity-subsector-rotation"><article className="equity-rotation-panel panel wide"><div className="equity-rotation-head subsector-head"><span>Rank</span><span>Subsector</span><span>Group</span><span>Quadrant</span><span>Rotation 20D</span><span>20D vs SPY</span><span>60D vs SPY</span><span>Score</span></div>{rotation.subsectors.map((row) => <div className="equity-rotation-row subsector-row" key={row.symbol}><b>{row.rank}</b><span><strong>{row.name}</strong><small>{row.symbol}</small></span><small>{row.group}</small><i className={row.quadrant ? row.quadrant.toLowerCase() : 'neutral'}>{row.quadrant ?? '—'}</i><RotationCell rotation={row.rotation} /><span className={row.relative20 >= 0 ? 'positive' : 'negative'}>{formatPercent(row.relative20)}</span><span className={row.relative60 >= 0 ? 'positive' : 'negative'}>{formatPercent(row.relative60)}</span><b>{row.score}</b></div>)}<p className="equity-source-line">Ranks are global across all {rotation.sectors.length + rotation.subsectors.length} tracked ETF proxies. Quadrants use 20- and 60-session relative performance versus SPY.</p></article></section> : null}

    <SectorDispersionSection dispersion={sectorData?.dispersion} />
    <CaptureProfileSection capture={sectorData?.capture} />

    <section className="equity-section-heading"><div><p className="section-kicker">MACRO SENSITIVITY MATRIX · CALCULATED</p><h2>How each ETF trades against macro drivers</h2></div><span className="data-pill">{sectorData?.macroSensitivity?.window ?? '60 aligned changes'}</span></section>
    <section className="equity-macro-matrix">
      <article className="equity-rotation-panel panel wide">
        <div className="equity-rotation-head macro-head"><span>ETF</span><span>Broad dollar</span><span>10Y real yield</span><span>VIX</span><span>HY spread</span><span>Catalog sensitivity</span></div>
        {[...(rotation?.sectors ?? []), ...(rotation?.subsectors ?? [])].map((row) => {
          const ms = row.macroSensitivity ?? {};
          const cell = (value, key) => {
            const detail = ms.detail?.[key];
            const slow = detail?.status === 'calculated' && detail.daily === false;
            return <span
              className={!Number.isFinite(value) ? 'neutral' : value >= 0.25 ? 'positive' : value <= -0.25 ? 'negative' : 'neutral'}
              title={detail ? detail.status === 'calculated' ? `${detail.windowLabel} · ${detail.observations} aligned changes${detail.asOf ? ` to ${detail.asOf}` : ''}` : detail.reason : 'No sensitivity published'}
            >{Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)}` : '—'}{slow ? <i className="slow-cadence" aria-label="weekly driver">·w</i> : null}</span>;
          };
          return <div className="equity-rotation-row macro-row" key={`ms-${row.symbol}`}><span><strong>{row.name}</strong><small>{row.symbol}</small></span>{cell(ms.dollar, 'dollar')}{cell(ms.realYield, 'realYield')}{cell(ms.vix, 'vix')}{cell(ms.credit, 'credit')}<small>{row.sensitivity ?? '—'}</small></div>;
        })}
        <p className="equity-source-line">Pearson correlations over 60 aligned changes against fresh stored FRED histories; each cell names its own window on hover, and a weekly driver is marked ·w because 60 of its observations span more than a year ({Object.entries(sectorData?.macroSensitivity?.sources ?? {}).filter(([, source]) => source).map(([key]) => key).join(', ') || 'FRED sources pending'}). Subsectors without catalog sensitivity show a dash.</p>
      </article>
    </section>

    <section className="equity-section-heading"><div><p className="section-kicker">STYLE AND REGION ROTATION · CALCULATED</p><h2>Basket spreads across the cycle</h2></div><EquityStatus status={sectorData?.styles?.status} /></section>
    <section className="equity-macro-matrix">
      <article className="equity-rotation-panel panel wide">
        <div className="equity-rotation-head styles-head"><span>Rotation pair</span><span>20D spread</span><span>60D spread</span><span>Leader</span><span>Regime</span></div>
        {(sectorData?.styles?.pairs ?? []).map((pair) => pair.status === 'calculated' ? <div className="equity-rotation-row styles-row" key={pair.key}><span><strong>{pair.left}</strong><small>vs {pair.right}</small></span><span className={pair.spread20 >= 0 ? 'positive' : 'negative'}>{formatPercent(pair.spread20)}</span><span className={pair.spread60 >= 0 ? 'positive' : 'negative'}>{formatPercent(pair.spread60)}</span><b>{pair.leader ?? '—'}</b><i className={pair.regime === 'Balanced' ? 'neutral' : pair.rotating ? 'caution' : 'leading'} title={pair.read ?? undefined}>{pair.regime}</i></div> : <div className="equity-rotation-row styles-row" key={pair.key}><span><strong>{pair.left}</strong><small>vs {pair.right}</small></span><span className="neutral">—</span><span className="neutral">—</span><b>Unavailable</b><small>{pair.missing?.join(', ') || 'History pending'}</small></div>)}
        {!(sectorData?.styles?.pairs ?? []).length && <div className="equity-empty">Stored basket histories are required before style rotation can publish.</div>}
        <p className="equity-source-line">{sectorData?.styles?.methodology ?? 'Awaiting sector API.'}</p>
      </article>
    </section>

    <section className="equity-section-heading"><div><p className="section-kicker">POSITIONING · CALCULATED</p><h2>Leveraged-fund exposure from CFTC commitments</h2></div><EquityStatus status={positioning?.status} label="CFTC pending" /></section>
    <section className="equity-macro-matrix">
      <article className="equity-rotation-panel panel wide">
        <div className="equity-rotation-head cot-head"><span>Contract</span><span>Net spec</span><span>WoW change</span><span>3Y percentile</span><span>Stance</span></div>
        {(positioning?.contracts ?? []).filter((contract) => contract.key !== 'usdIndex').map((contract) => <div className="equity-rotation-row cot-row" key={contract.key}><span><strong>{contract.name}</strong><small>{contract.asOf}{Number.isFinite(contract.openInterest) ? ` · OI ${contract.openInterest.toLocaleString()}` : ''}</small></span><b>{Number.isFinite(contract.netNoncomm) ? contract.netNoncomm.toLocaleString() : '—'}</b><b className={(contract.weeklyChange ?? 0) >= 0 ? 'positive' : 'negative'}>{Number.isFinite(contract.weeklyChange) ? `${contract.weeklyChange >= 0 ? '+' : ''}${contract.weeklyChange.toLocaleString()}` : '—'}</b><span className={contract.percentile >= 90 || contract.percentile <= 10 ? 'extreme' : ''}>{Number.isFinite(contract.percentile) ? `${contract.percentile}%` : '—'}{contract.crowd && contract.crowd !== 'Unextended' ? <small> · {contract.crowd}</small> : null}</span><i>{contract.stance ?? '—'}</i></div>)}
        {!(positioning?.contracts ?? []).length && <div className="equity-empty">CFTC commitment histories are required before positioning can publish.</div>}
        <p className="equity-source-line">{positioning?.methodology ?? 'Awaiting CFTC feed.'}{platformData?.positioning?.staleContracts?.length ? ` Stale: ${platformData.positioning.staleContracts.join(', ')}.` : ''}</p>
      </article>
      {(() => {
        const fearGreed = platformData?.sentiment?.fearGreed;
        const hasSentiment = Boolean(fearGreed && Number.isFinite(fearGreed.score));
        return <article className={`equity-rotation-panel panel wide ${hasSentiment ? '' : 'preview-section'}`}>
          <div className="panel-title"><div><p className="section-kicker">MARKET SENTIMENT · CALCULATED</p><h3>CNN Fear &amp; Greed composite</h3></div><span className="data-pill">{hasSentiment ? fearGreed.rating : 'Unconfigured'}</span></div>
          {hasSentiment ? <>
            <div className="sentiment-hero"><strong>{fearGreed.score}</strong><div><b>{fearGreed.rating}</b><small>{Number.isFinite(fearGreed.percentile1y) ? `${fearGreed.percentile1y}th percentile of trailing-year readings · ${fearGreed.observations} observations` : 'Trailing-year history unavailable'}</small></div></div>
            <div className="equity-rotation-head sentiment-head"><span>Reference points</span><span>Score</span></div>
            <div className="equity-rotation-row sentiment-row"><span><strong>Previous close</strong><small>Last published session</small></span><b>{Number.isFinite(fearGreed.previousClose) ? Math.round(fearGreed.previousClose * 10) / 10 : '—'}</b></div>
            <div className="equity-rotation-row sentiment-row"><span><strong>One week ago</strong><small>Weekly comparison</small></span><b>{Number.isFinite(fearGreed.oneWeekAgo) ? Math.round(fearGreed.oneWeekAgo * 10) / 10 : '—'}</b></div>
            <div className="equity-rotation-row sentiment-row"><span><strong>One month ago</strong><small>Monthly comparison</small></span><b>{Number.isFinite(fearGreed.oneMonthAgo) ? Math.round(fearGreed.oneMonthAgo * 10) / 10 : '—'}</b></div>
            <div className="equity-rotation-row sentiment-row"><span><strong>One year ago</strong><small>Yearly comparison</small></span><b>{Number.isFinite(fearGreed.oneYearAgo) ? Math.round(fearGreed.oneYearAgo * 10) / 10 : '—'}</b></div>
          </> : <div className="equity-empty">The CNN Fear &amp; Greed endpoint is required before sentiment can publish.</div>}
          <p className="equity-source-line">{platformData?.sentiment?.methodology ?? 'Awaiting sentiment feed.'}</p>
        </article>;
      })()}
    </section>

    <section className="equity-section-heading"><div><p className="section-kicker">RISK APPETITE · CALCULATED</p><h2>Breadth, credit, and the equity premium</h2></div><EquityStatus status={platformData?.equityRisk?.status} label="Inputs pending" /></section>
    <section className="equity-macro-matrix">
      {(() => {
        const risk = platformData?.equityRisk;
        const hasRisk = Boolean(risk?.calculatedCount);
        return <article className={`equity-rotation-panel panel wide ${hasRisk ? '' : 'preview-section'}`}>
          <div className="panel-title"><div><p className="section-kicker">EQUITY RISK DASHBOARD · {risk?.version ? risk.version.toUpperCase() : 'UNAVAILABLE'}</p><h3>{risk?.spxBreadth?.divergence?.divergent ? `${risk.spxBreadth.divergence.state}: ${risk.spxBreadth.pctAbove200}% of S&P 500 above 200-day` : risk?.spxBreadth?.status === 'calculated' ? `${risk.spxBreadth.pctAbove200}% of S&P 500 above 200-day — ${risk.spxBreadth.read}` : 'Breadth and risk appetite'}</h3></div><span className="data-pill">{risk ? `${risk.calculatedCount}/${risk.totalLegs} legs` : 'Unavailable'}</span></div>
          {hasRisk ? <>
            <div className="btc-cycle-grid">
              <div className="btc-cycle-cell"><small>Above 200DMA</small><b>{risk.spxBreadth?.status === 'calculated' ? `${risk.spxBreadth.pctAbove200}%` : '—'}</b><span>{risk.spxBreadth?.status === 'calculated' ? `${risk.spxBreadth.counted}/${risk.spxBreadth.universeSize} constituents` : risk.spxBreadth?.reason}</span></div>
              <div className="btc-cycle-cell"><small>Above 50DMA</small><b>{risk.spxBreadth?.status === 'calculated' ? `${risk.spxBreadth.pctAbove50}%` : '—'}</b><span>Short-term participation</span></div>
              <div className={`btc-cycle-cell ${risk.spxBreadth?.divergence?.divergent ? 'cell-warning' : ''}`}><small>Breadth vs index</small><b>{risk.spxBreadth?.divergence?.status === 'calculated' ? risk.spxBreadth.divergence.state : '—'}</b><span>{risk.spxBreadth?.divergence?.read ?? risk.spxBreadth?.divergence?.reason ?? 'Advance/decline history pending'}</span></div>
              <div className="btc-cycle-cell"><small>RSP/SPY 50d slope</small><b>{risk.equalWeight?.status === 'calculated' ? `${risk.equalWeight.slope50 > 0 ? '+' : ''}${risk.equalWeight.slope50}%` : '—'}</b><span>{risk.equalWeight?.read ?? risk.equalWeight?.reason}</span></div>
              <div className="btc-cycle-cell"><small>HY OAS</small><b>{risk.creditStress?.status === 'calculated' ? `${risk.creditStress.level}%` : '—'}</b><span>{risk.creditStress?.status === 'calculated' ? `${risk.creditStress.change20d >= 0 ? '+' : ''}${risk.creditStress.change20d} 20d · ${risk.creditStress.read}` : risk.creditStress?.reason}</span></div>
              <div className="btc-cycle-cell"><small>ERP proxy</small><b>{risk.riskPremium?.status === 'calculated' ? `${risk.riskPremium.spread > 0 ? '+' : ''}${risk.riskPremium.spread}%` : '—'}</b><span>{risk.riskPremium?.status === 'calculated' ? `EY ${risk.riskPremium.earningsYield}% − real ${risk.riskPremium.realYield10y}% · ${risk.riskPremium.read}` : risk.riskPremium?.reason}</span></div>
              <div className="btc-cycle-cell"><small>VIX term structure</small><b>{risk.vixTermStructure?.status === 'calculated' ? risk.vixTermStructure.vixVix3m : '—'}</b><span>{risk.vixTermStructure?.status === 'calculated' ? `VIX ${risk.vixTermStructure.vix} / 3M ${risk.vixTermStructure.vix3m} · ${risk.vixTermStructure.percentile}th pct · ${risk.vixTermStructure.state}` : risk.vixTermStructure?.reason}</span></div>
              <div className="btc-cycle-cell"><small>10Y-2Y curve</small><b>{risk.yieldCurve?.status === 'calculated' ? `${risk.yieldCurve.spread > 0 ? '+' : ''}${risk.yieldCurve.spread}%` : '—'}</b><span>{risk.yieldCurve?.status === 'calculated' ? `${risk.yieldCurve.change20d >= 0 ? '+' : ''}${risk.yieldCurve.change20d} 20d · ${risk.yieldCurve.state}` : risk.yieldCurve?.reason}</span></div>
            </div>
            {risk.sectorRotation?.status === 'calculated' && <>
              <div className="equity-rotation-head sentiment-head" style={{ marginTop: 14 }}><span>Sector SPDR relative strength vs SPY</span><span>3M RS</span></div>
              {risk.sectorRotation.rows.map((row) => <div className="equity-rotation-row sentiment-row" key={row.symbol}><span><strong>{row.name}</strong><small>{row.symbol} · 20-session RS {row.momentum20d > 0 ? '+' : ''}{row.momentum20d}%</small></span><b className={row.momentum3m >= 0 ? 'positive' : 'negative'}>{row.momentum3m > 0 ? '+' : ''}{row.momentum3m}%</b></div>)}
            </>}
            <p className="equity-source-line">{risk.methodology}</p>
          </> : <div className="equity-empty">The risk dashboard publishes as constituent histories, FRED spreads, and earnings-yield inputs respond.</div>}
        </article>;
      })()}
    </section>

    <section className="equity-section-heading"><div><p className="section-kicker">MARKET INTERNALS · {(sectorData?.sectorBreadth?.status ?? 'unavailable').toUpperCase()} PROXY</p><h2>Participation across the ETF universe</h2></div><EquityStatus status={sectorData?.sectorBreadth?.status} label={sectorData?.sectorBreadth?.status === 'unavailable' || !sectorData?.sectorBreadth ? 'Histories pending' : sectorData.sectorBreadth.missing?.length ? `${sectorData.sectorBreadth.universeSize} ETFs · narrowed base` : `${sectorData.sectorBreadth.universeSize} ETFs`} /></section>
    <section className="equity-macro-matrix">
      <article className="equity-rotation-panel panel wide">
        {sectorData?.sectorBreadth?.status && sectorData.sectorBreadth.status !== 'unavailable' ? <>
          <div className="equity-rotation-head styles-head"><span>Universe of {sectorData.sectorBreadth.universeSize} ETFs</span><span>Reading</span></div>
          <div className="equity-rotation-row styles-row"><span><strong>Above 50-day average</strong><small>{`Trend participation · ${sectorData.sectorBreadth.eligible?.above50 ?? 0} of ${sectorData.sectorBreadth.universeSize} carry 50 sessions`}</small></span><b>{Number.isFinite(sectorData.sectorBreadth.pctAbove50) ? `${sectorData.sectorBreadth.pctAbove50}%` : '—'}</b></div>
          <div className="equity-rotation-row styles-row"><span><strong>Above 200-day average</strong><small>{Number.isFinite(sectorData.sectorBreadth.pctAbove200) ? `Long-cycle participation · ${sectorData.sectorBreadth.eligible?.above200} of ${sectorData.sectorBreadth.universeSize} carry 200 sessions` : 'No ETF carries 200 sessions yet — never computed from a shorter window'}</small></span><b>{Number.isFinite(sectorData.sectorBreadth.pctAbove200) ? `${sectorData.sectorBreadth.pctAbove200}%` : '—'}</b></div>
          <div className="equity-rotation-row styles-row"><span><strong>20-session advancers</strong><small>Short-term breadth</small></span><b>{Number.isFinite(sectorData.sectorBreadth.advancersPct) ? `${sectorData.sectorBreadth.advancersPct}%` : '—'}</b></div>
          <div className="equity-rotation-row styles-row"><span><strong>New 60-session highs / lows</strong><small>Within 2% of extreme</small></span><b>{sectorData.sectorBreadth.newHighs} / {sectorData.sectorBreadth.newLows}</b></div>
          <div className="equity-rotation-row styles-row"><span><strong>50-day trend thrust</strong><small>Universe-average 20-session slope</small></span><b className={(sectorData.sectorBreadth.thrust20 ?? 0) >= 0 ? 'positive' : 'negative'}>{Number.isFinite(sectorData.sectorBreadth.thrust20) ? `${sectorData.sectorBreadth.thrust20 > 0 ? '+' : ''}${sectorData.sectorBreadth.thrust20}%` : '—'}</b></div>
        </> : <div className="equity-empty">{sectorData?.sectorBreadth?.reason ?? 'Fresh ETF histories are required before the participation proxy can publish.'}</div>}
        <p className="equity-source-line">{sectorData?.sectorBreadth?.methodology ?? 'Awaiting sector API.'}</p>
      </article>
      <article className="panel">
        <div className="panel-title"><div><p className="section-kicker">TOP RISK · PROXY BREADTH</p><h3>{sectorData?.topRisk?.risk ?? 'Unavailable'}</h3></div><span className="data-pill">{sectorData?.topRisk?.coverage ?? 0}% coverage</span></div>
        <div className="detail-score"><span>Breadth-deterioration composite</span><b>{sectorData?.topRisk?.score ?? '—'}</b><small>{sectorData?.topRisk?.missing?.length ? `Missing: ${sectorData.topRisk.missing.join(', ')}` : 'All available drivers contributing'}</small></div>
        <p className="model-footnote"><code>{sectorData?.topRisk?.version ?? 'equity-top-risk-v1'}</code> publishes provisionally when constituent breadth is replaced by the ETF participation proxy.</p>
      </article>
      <article className="panel">
        <div className="panel-title"><div><p className="section-kicker">BOTTOM SIGNAL · PROXY BREADTH</p><h3>{sectorData?.bottomSignal?.signal ?? 'Unavailable'}</h3></div><span className="data-pill">{sectorData?.bottomSignal?.bearMarketRallyRisk ?? '—'} rally risk</span></div>
        <div className="detail-score"><span>Washout-and-turn composite</span><b>{sectorData?.bottomSignal?.score ?? '—'}</b><small>{sectorData?.bottomSignal?.missing?.length ? `Missing: ${sectorData.bottomSignal.missing.join(', ')}` : 'All available drivers contributing'}</small></div>
        <p className="model-footnote"><code>{sectorData?.bottomSignal?.version ?? 'equity-bottom-signal-v1'}</code> confirms only with full constituent breadth; proxy readings stay provisional.</p>
      </article>
    </section>

    <section className="equity-section-heading"><div><p className="section-kicker">PARTICIPATION AND POSITIONING</p><h2>Inputs still required for reliable extremes</h2></div><EquityStatus status="unavailable" label="Feeds pending" /></section>
    <section className="equity-requirement-grid">
      <RequirementPanel title="Market breadth" dataset={dashboard?.breadth} requirements={catalog?.requiredFeeds?.breadth} />
      <RequirementPanel title="Sentiment" dataset={dashboard?.sentiment} requirements={catalog?.requiredFeeds?.sentiment} />
      <RequirementPanel title="Positioning" dataset={dashboard?.positioning} requirements={catalog?.requiredFeeds?.positioning} />
    </section>

    <section className="equity-bottom-layout">
      <article className="equity-history-panel panel"><div className="panel-title"><div><p className="section-kicker">HISTORICAL TOP STUDY</p><h3>Point-in-time warning review</h3></div><EquityStatus status={dashboard?.historicalTopStudy?.status} /></div><p>{dashboard?.historicalTopStudy?.reason ?? 'Historical study status is unavailable.'}</p><div><span>Price-only backtest</span><b>Rejected</b></div><div><span>Point-in-time vintages</span><b>Required</b></div><div><span>Constituent breadth history</span><b>Required</b></div></article>
      <article className="equity-source-panel panel"><div className="panel-title"><div><p className="section-kicker">SOURCE LEDGER</p><h3>What supports this view</h3></div><span className="data-pill">{dashboard?.version ?? 'Awaiting API'}</span></div>{(dashboard?.sources ?? []).map((source) => <div className="equity-source-row" key={source.name}><span><b>{source.name}</b><small>{source.source ?? source.disclosure ?? 'No connected source'}</small></span><EquityStatus status={source.status} /></div>)}</article>
    </section>
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
  </div>;
}

function MarketCell({ name, quote }) {
  const tone = !quote ? 'unavailable' : quote.changePercent < 0 ? 'negative' : 'positive';
  return <div className="market-cell"><p>{name}</p><strong>{formatUsd(quote?.price)}</strong><small className={tone}>{formatPercent(quote?.changePercent)}</small></div>;
}

function formatMacroValue(series) {
  if (!Number.isFinite(series.value)) return 'Unavailable';
  if (series.unit === 'USD millions') return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(series.value * 1_000_000);
  if (series.unit === 'USD billions') return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(series.value * 1_000_000_000);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(series.value);
}

function MarketsDashboard({ data }) {
  const [group, setGroup] = React.useState('All');
  const [activeMetric, setActiveMetric] = React.useState('score');
  const [selectedSymbol, setSelectedSymbol] = React.useState('SPY');
  const heatmap = data.heatmap;
  const assets = (heatmap?.assets ?? []).filter((asset) => asset.status === 'calculated');
  const groups = ['All', ...[...new Set(assets.map((asset) => asset.group))]];
  const visibleAssets = group === 'All' ? assets : assets.filter((asset) => asset.group === group);
  const selectedAsset = assets.find((asset) => asset.symbol === selectedSymbol) ?? visibleAssets[0] ?? assets[0];
  const cellValue = (asset, key) => key === 'momentum' ? (Number.isFinite(asset.momentum20d) ? `${asset.momentum20d > 0 ? '+' : ''}${asset.momentum20d}%` : '—') : asset[key];
  const cellTone = (asset, key) => {
    const value = asset[key];
    if (value === 'Unavailable' || value === null || value === undefined) return 'neutral';
    if (key === 'score' || key === 'regime') return asset.score >= 55 ? 'positive' : asset.score <= 35 ? 'negative' : 'neutral';
    if (key === 'trend') return ['Uptrend', 'Recovering'].includes(value) ? 'positive' : value === 'Downtrend' ? 'negative' : 'neutral';
    if (key === 'momentum') return asset.momentum20d > 0 ? 'positive' : asset.momentum20d < 0 ? 'negative' : 'neutral';
    if (key === 'volatility') return value === 'Low' ? 'positive' : value === 'High' ? 'caution' : 'neutral';
    if (key === 'crowding') return ['Crowded', 'Elevated'].includes(value) ? 'caution' : value === 'Light' ? 'positive' : 'neutral';
    if (key === 'alignment') return value === 'High' ? 'positive' : value === 'Low' ? 'negative' : 'neutral';
    return 'neutral';
  };
  const avgScore = assets.length ? Math.round(assets.reduce((total, asset) => total + asset.score, 0) / assets.length) : null;
  const riskOnCount = assets.filter((asset) => asset.score >= 55).length;
  const neutralCount = assets.filter((asset) => asset.score > 35 && asset.score < 55).length;
  const stressCount = assets.filter((asset) => asset.score <= 35).length;
  const alignedAssets = assets.filter((asset) => Number.isFinite(asset.alignmentValue));
  const avgAlignment = alignedAssets.length ? Math.round((alignedAssets.reduce((total, asset) => total + Math.abs(asset.alignmentValue), 0) / alignedAssets.length) * 100) : null;
  const crowdedAssets = assets.filter((asset) => Number.isFinite(asset.crowdingPercentile));
  const peakCrowding = crowdedAssets.length ? Math.max(...crowdedAssets.map((asset) => asset.crowdingPercentile)) : null;
  const backdrop = heatmap?.liquidityBackdrop;
  const heatmapRisk = heatmap?.risk;

  return <div className="markets-dashboard">
    <section className="markets-intro">
      <div><p className="eyebrow">MULTI-ASSET INTELLIGENCE</p><h1>See the market before it moves.</h1><p className="intro">A single scorecard for regime, participation, positioning, and market quality.</p></div>
      <div className="markets-status">{heatmap?.status !== 'calculated' && <PreviewBadge />}<div><b>{heatmap?.calculatedCount ? `${heatmap.calculatedCount} of ${heatmap.universeSize} markets calculated` : 'Awaiting stored histories'}</b><small>technical-v1 · COT crowding · 60D alignment</small></div></div>
    </section>
    <DataDisclosure data={data} message={heatmap?.status === 'calculated' ? 'Heatmap scores are calculated by technical-v1 on stored close histories; alignment correlates 60-day changes versus SPY and crowding uses CFTC COT percentiles where a matching contract exists.' : 'The heatmap publishes once stored market histories are available for the tracked universe.'} />

    <section className="heatmap-summary-grid">
      <article className={`heatmap-hero panel ${heatmap?.status === 'calculated' ? '' : 'preview-section'}`}><div><p className="section-kicker">CROSS-ASSET REGIME</p><h2>{avgScore === null ? 'Awaiting inputs' : avgScore >= 55 ? 'Broadly constructive' : avgScore <= 35 ? 'Broadly guarded' : 'Mixed tape'} <span className="status-dot"></span></h2><p>Universe-average technical score of {avgScore ?? '—'}/100 across {assets.length} calculated markets.</p></div><div className="regime-distribution"><span className="positive">{riskOnCount}</span><span className="neutral">{neutralCount}</span><span className="negative">{stressCount}</span><small>Risk-on</small><small>Neutral</small><small>Stress</small></div></article>
      <article className={`heatmap-stat panel ${avgAlignment === null ? 'preview-section' : ''}`}><p className="section-kicker">ALIGNMENT</p><b>{avgAlignment ?? '—'}<span>/100</span></b><p>Average absolute 60-day correlation versus SPY</p><i><span style={{ width: `${avgAlignment ?? 0}%` }}></span></i></article>
      <article className={`heatmap-stat panel ${peakCrowding === null ? 'preview-section' : ''}`}><p className="section-kicker">PEAK CROWDING</p><b>{peakCrowding ?? '—'}<span>th pct</span></b><p>Highest CFTC positioning percentile in the universe</p><i className="amber"><span style={{ width: `${peakCrowding ?? 0}%` }}></span></i></article>
      <article className={`heatmap-stat panel ${backdrop ? '' : 'preview-section'}`}><p className="section-kicker">LIQUIDITY BACKDROP</p><b>{backdrop?.score ?? '—'}<span>/100</span></b><p>Global liquidity regime: {backdrop?.regime ?? 'unavailable'}</p><i><span style={{ width: `${backdrop?.score ?? 0}%` }}></span></i></article>
    </section>

    <section className="heatmap-heading"><div><p className="section-kicker">MARKET MATRIX · CALCULATED</p><h2>Multi-asset heatmap {heatmap?.status !== 'calculated' && <PreviewBadge />}</h2></div><div className="heatmap-controls"><div className="group-filter">{groups.map((item) => <button className={group === item ? 'active' : ''} key={item} onClick={() => setGroup(item)}>{item}</button>)}</div></div></section>

    <section className="heatmap-workspace">
      <article className={`heatmap-panel panel ${heatmap?.status === 'calculated' ? '' : 'preview-section'}`}><div className="heatmap-legend"><span><i className="positive"></i>Supportive</span><span><i className="neutral"></i>Mixed</span><span><i className="negative"></i>Guarded</span><small>60D alignment window</small></div><div className="heatmap-scroll"><div className="heatmap-table"><div className="heatmap-table-head"><span>Market</span>{heatmapColumns.map(([key, label]) => <button className={activeMetric === key ? 'metric-active' : ''} key={key} onClick={() => setActiveMetric(key)}>{label}</button>)}</div>{visibleAssets.map((asset) => <button className={`heatmap-row ${selectedAsset?.symbol === asset.symbol ? 'asset-selected' : ''}`} onClick={() => setSelectedSymbol(asset.symbol)} key={asset.symbol}><span className="heatmap-asset"><b>{asset.symbol}</b><small>{asset.name}</small></span>{heatmapColumns.map(([key]) => <span className={`heatmap-cell ${cellTone(asset, key)} ${activeMetric === key ? 'metric-active' : ''}`} key={key}>{cellValue(asset, key)}</span>)}</button>)}{!visibleAssets.length && <div className="equity-empty">No calculated markets yet — stored close histories are required.</div>}</div></div></article>
      {selectedAsset && <article className="heatmap-detail panel"><div className="panel-title"><div><p className="section-kicker">SELECTED MARKET</p><h3>{selectedAsset.name}</h3></div><span className="market-symbol us-indices">{selectedAsset.symbol}</span></div><div className="detail-score"><span>Technical score</span><b className={cellTone(selectedAsset, 'score')}>{selectedAsset.score}</b><small>{selectedAsset.regime} regime · as of {String(selectedAsset.asOf ?? '').slice(0, 10)}</small></div><div className="detail-metrics">{[['trend', 'Trend'], ['momentum', 'Momentum'], ['volatility', 'Volatility'], ['crowding', 'Crowding'], ['alignment', 'Alignment']].map(([key, label]) => <div key={key}><span>{label}</span><b className={cellTone(selectedAsset, key)}>{cellValue(selectedAsset, key)}</b></div>)}</div><div className="heatmap-callout"><span>Model read</span><p>{selectedAsset.trend} against a {selectedAsset.volatility.toLowerCase()} volatility profile; equity-market alignment is {String(selectedAsset.alignmentValue ?? '—')}{Number.isFinite(selectedAsset.crowdingPercentile) ? ` with leveraged-fund positioning at the ${selectedAsset.crowdingPercentile}th percentile` : ''}.</p></div><button className="source-link">Open {selectedAsset.symbol} research →</button></article>}
    </section>

    <section className="heatmap-bottom-grid">
      <article className={`heatmap-method panel ${heatmap?.status === 'calculated' ? '' : 'preview-section'}`}><p className="section-kicker">MODEL DISCIPLINES</p><h3>One screen, seven lenses.</h3><p>Scores combine trend, cross-market alignment, positioning, volatility, and liquidity rather than relying on price direction alone.</p><div><span>Score</span><span>Regime</span><span>Alignment</span><span>Trend</span><span>Crowding</span><span>Volatility</span><span>Liquidity</span></div></article>
      <article className={`heatmap-alert panel ${heatmapRisk?.status === 'calculated' ? '' : 'preview-section'}`}><p className="section-kicker">WEAKEST LINK · {heatmapRisk?.status?.toUpperCase() ?? 'UNAVAILABLE'}</p><h3>{heatmapRisk?.headline ? `${heatmapRisk.headline.type}${heatmapRisk.headline.symbol ? `: ${heatmapRisk.headline.symbol}` : ''}` : heatmapRisk?.status === 'calculated' ? 'No single weak link stands out.' : 'Awaiting calculated markets.'}</h3><p>{heatmapRisk?.read ?? 'The heatmap must publish calculated scores before its weakest link can be identified.'}</p>{(heatmapRisk?.concerns ?? []).slice(1, 4).map((concern) => <div className="risk-concern" key={concern.key}><b>{concern.type}{concern.symbol ? ` · ${concern.symbol}` : ''}</b><small>{concern.read}</small></div>)}{heatmapRisk?.headline?.symbol ? <button onClick={() => { setSelectedSymbol(heatmapRisk.headline.symbol); setGroup('All'); }}>Show {heatmapRisk.headline.symbol} in the matrix →</button> : null}</article>
    </section>
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
  </div>;
}

function MetalsDashboard({ data }) {
  const [selectedSymbol, setSelectedSymbol] = React.useState('XAU');
  const workspace = data.metals;
  const costStructure = workspace?.costStructure;
  const metalColors = { XAU: '#d2a644', XAG: '#b6c5d2', XPT: '#a8aeba', XPD: '#879291' };
  const assets = workspace?.assets ?? [];
  const selectedMetal = assets.find((asset) => asset.symbol === selectedSymbol) ?? assets[0];
  const cot = workspace?.cot;
  const macro = workspace?.macro;
  const formatPrice = (value) => Number.isFinite(value) ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
  const technicalRows = selectedMetal ? [
    ['Technical score', String(selectedMetal.score), selectedMetal.regime, selectedMetal.score >= 55 ? 'positive' : selectedMetal.score <= 35 ? 'negative' : 'neutral'],
    ['RSI (14)', Number.isFinite(selectedMetal.rsi14) ? String(Math.round(selectedMetal.rsi14)) : '—', selectedMetal.rsi14 >= 70 ? 'Overbought' : selectedMetal.rsi14 <= 30 ? 'Oversold' : 'Constructive', selectedMetal.rsi14 >= 70 || selectedMetal.rsi14 <= 30 ? 'caution' : 'positive'],
    ['Momentum (20s)', Number.isFinite(selectedMetal.momentum20d) ? `${selectedMetal.momentum20d > 0 ? '+' : ''}${selectedMetal.momentum20d}%` : '—', '20-session change', selectedMetal.momentum20d > 0 ? 'positive' : selectedMetal.momentum20d < 0 ? 'negative' : 'neutral'],
    ['Moving averages', Number.isFinite(selectedMetal.sma50) && Number.isFinite(selectedMetal.sma200) ? (selectedMetal.sma50 > selectedMetal.sma200 ? 'Golden' : 'Death') : '—', 'SMA50 vs SMA200', selectedMetal.sma50 > selectedMetal.sma200 ? 'positive' : 'negative'],
    ['Volatility (ann.)', Number.isFinite(selectedMetal.annualizedVolatility) ? `${selectedMetal.annualizedVolatility}%` : '—', '20-day realized', selectedMetal.annualizedVolatility > 35 ? 'caution' : 'neutral'],
    ['Observations', String(selectedMetal.observations ?? '—'), `as of ${String(selectedMetal.asOf ?? '').slice(0, 10)}`, 'neutral'],
  ] : [];
  const macroRows = macro ? [
    ['U.S. dollar', `${macro.dollar.score}/100`, macro.dollar.regime, macro.dollar.score >= 55 ? 'negative' : 'positive'],
    ['Global liquidity', `${macro.globalLiquidity.score}/100`, macro.globalLiquidity.regime, macro.globalLiquidity.score >= 50 ? 'positive' : 'negative'],
    ['Gold COT percentile', cot && Number.isFinite(cot.percentile) ? `${cot.percentile}th` : '—', cot?.crowd ?? 'unavailable', cot && cot.percentile >= 90 ? 'caution' : 'neutral'],
  ] : [];

  return <div className="metals-dashboard">
    <section className="metals-intro">
      <div><p className="eyebrow">PRECIOUS METALS RESEARCH</p><h1>Where monetary metal meets market structure.</h1><p className="intro">Technical, macro, physical, and positioning signals for metals and their equity proxies.</p></div>
      <div className="metals-pulse">{workspace?.status !== 'calculated' && <PreviewBadge />}<div><b>{workspace?.calculatedCount ? `${workspace.calculatedCount} of ${workspace.universeSize} series calculated` : 'Awaiting provider histories'}</b><small>technical-v1 · COMEX futures · COT</small></div></div>
    </section>
    <DataDisclosure data={data} message={workspace?.status === 'calculated' ? 'Spot metals prices come from front COMEX/CME futures via Yahoo Finance; scores, momentum, volatility, and RSI are technical-v1 calculations. ETF flows, physical-market indicators, and producer costs remain previews until dedicated feeds are connected.' : 'The metals workspace publishes once futures and miner histories are available.'} />

    <section className={`metal-asset-strip ${assets.length ? '' : 'preview-section'}`}>{assets.map((asset) => <button className={`metal-asset ${selectedMetal?.symbol === asset.symbol ? 'selected' : ''}`} onClick={() => setSelectedSymbol(asset.symbol)} key={asset.symbol}><span className="metal-symbol" style={{ '--metal-color': metalColors[asset.symbol] }}>{asset.symbol}</span><span><b>{asset.name}</b><small>{asset.regime}</small></span><span className="metal-price"><b>{formatPrice(asset.price)}</b><small className={(asset.change20d ?? 0) >= 0 ? 'positive' : 'negative'}>{Number.isFinite(asset.change20d) ? `${asset.change20d > 0 ? '+' : ''}${asset.change20d}%` : '—'} 20s</small></span><span className="metal-spark"><Sparkline color={metalColors[asset.symbol]} values={asset.sparkline ?? []} /></span></button>)}{!assets.length && <div className="equity-empty">Futures histories are required before metals can publish.</div>}</section>

    {selectedMetal && <>
    <section className="metals-focus-heading"><div><p className="section-kicker">{selectedMetal.symbol} RESEARCH MAP · CALCULATED</p><h2>{selectedMetal.name} <span>·</span> {selectedMetal.regime}</h2></div><span className="data-pill">technical-v1</span></section>

    <section className="metals-primary-grid">
      <article className="metal-price-panel panel"><div className="panel-title"><div><p className="section-kicker">PRICE AND TECHNICALS</p><h3>{selectedMetal.trend ?? selectedMetal.regime}</h3></div><span className="data-pill">front future</span></div><div className="metal-quote"><b>{formatPrice(selectedMetal.price)}</b><span className={(selectedMetal.change20d ?? 0) >= 0 ? 'positive' : 'negative'}>{Number.isFinite(selectedMetal.change20d) ? `${selectedMetal.change20d > 0 ? '+' : ''}${selectedMetal.change20d}%` : '—'} (20 sessions)</span><small>USD, continuous front contract</small></div><div className="metal-chart"><Sparkline color={metalColors[selectedMetal.symbol]} values={selectedMetal.sparkline ?? []} /></div><div className="technical-grid">{technicalRows.map(([name, value, detail, tone]) => <div className="technical-item" key={name}><span>{name}</span><b className={tone}>{value}</b><small>{detail}</small></div>)}</div></article>
      <article className={`metal-macro-panel panel ${macroRows.length ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">MACRO READINGS · CALCULATED</p><h3>Dollar and liquidity backdrop</h3></div>{macroRows.length ? null : <PreviewBadge />}</div><div className="metal-macro-list">{macroRows.map(([name, state, detail, tone]) => <div className="metal-macro-row" key={name}><div><b>{name}</b><small>{detail}</small></div><span className={tone}>{state}</span></div>)}{!macroRows.length && <div className="equity-empty">Macro readings require the liquidity snapshot.</div>}</div><div className="macro-conclusion"><span>Model read</span><p>{macro ? `A ${macro.dollar.score >= 55 ? 'firm' : 'soft'} dollar (${macro.dollar.score}/100) with ${macro.globalLiquidity.regime.toLowerCase()} global liquidity (${macro.globalLiquidity.score}/100) frames the monetary backdrop for ${selectedMetal.name.toLowerCase()}.` : 'Waiting on stored FRED histories to frame the monetary backdrop.'}</p></div></article>
    </section>
    </> }

    <section className="metals-section-heading"><div><p className="section-kicker">POSITIONING AND FLOWS</p><h2>Who owns the trade, and where is demand coming from?</h2></div><span className="data-pill">{cot ? 'COT calculated' : 'Flows preview'}</span></section>
    <section className="metals-flow-grid">
      <article className={`positioning-panel panel ${cot ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">CFTC COT · GOLD · CALCULATED</p><h3>Leveraged-fund exposure</h3></div><span className="positioning-percentile">{cot && Number.isFinite(cot.percentile) ? cot.percentile : '—'}<span>th pct.</span></span></div><div className="positioning-rows"><div><span>Managed Money</span><i><b className="managed" style={{ width: `${Math.min(workspace?.cotDetail?.managedMoney?.percentile ?? 0, 100)}%` }}></b></i><small>{Number.isFinite(workspace?.cotDetail?.managedMoney?.net) ? `${workspace.cotDetail.managedMoney.net.toLocaleString()} (${workspace.cotDetail.managedMoney.percentile}th)` : '—'}</small></div><div><span>Producers / Merchants</span><i><b className="producer" style={{ width: `${Math.min(Math.abs(workspace?.cotDetail?.producers?.percentile ?? 0), 100)}%` }}></b></i><small>{Number.isFinite(workspace?.cotDetail?.producers?.net) ? `${workspace.cotDetail.producers.net.toLocaleString()} (${workspace.cotDetail.producers.percentile}th)` : '—'}</small></div><div><span>Swap Dealers</span><i><b className="swap" style={{ width: `${Math.min(Math.abs(workspace?.cotDetail?.swapDealers?.percentile ?? 0), 100)}%` }}></b></i><small>{Number.isFinite(workspace?.cotDetail?.swapDealers?.net) ? `${workspace.cotDetail.swapDealers.net.toLocaleString()} (${workspace.cotDetail.swapDealers.percentile}th)` : '—'}</small></div><div><span>Net non-commercial</span><i><b className="commercial" style={{ width: `${Math.min(((cot?.percentile ?? 0)), 100)}%` }}></b></i><small>{Number.isFinite(cot?.netNoncomm) ? `${cot.netNoncomm.toLocaleString()} · ${cot.crowd}` : '—'}</small></div><div><span>Weekly change (MM)</span><i><b className="speculator" style={{ width: `${Math.min(Math.abs(workspace?.cotDetail?.managedMoney?.weeklyChange ?? 0) / 200, 100)}%` }}></b></i><small>{Number.isFinite(workspace?.cotDetail?.managedMoney?.weeklyChange) ? `${workspace.cotDetail.managedMoney.weeklyChange >= 0 ? '+' : ''}${workspace.cotDetail.managedMoney.weeklyChange.toLocaleString()}` : '—'}</small></div></div><div className="positioning-note"><b>Positioning percentile</b><span>{cot ? `Three-year ranks of net disaggregated and legacy speculative positions as of ${workspace?.cotDetail?.asOf ?? cot.asOf}.` : 'CFTC commitment histories are required before positioning can publish.'}</span></div></article>
      <article className={`metal-flows-panel panel ${workspace?.ratios?.goldSilver?.status === 'calculated' || workspace?.ratios?.goldCopper?.status === 'calculated' ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">CROSS RATIOS · CALCULATED</p><h3>Relative monetary vs industrial demand</h3></div><span className="data-pill">1Y percentile</span></div><div className="metal-flow-row" key="gs"><div><b>Gold / Silver</b><small>{workspace?.ratios?.goldSilver?.status === 'calculated' ? `${workspace.ratios.goldSilver.change20d >= 0 ? '+' : ''}${workspace.ratios.goldSilver.change20d}% 20d · ${workspace.ratios.goldSilver.observations} obs` : workspace?.ratios?.goldSilver?.reason}</small></div><span className="neutral">{workspace?.ratios?.goldSilver?.status === 'calculated' ? `${workspace.ratios.goldSilver.ratio} · ${workspace.ratios.goldSilver.percentile}th` : '—'}</span></div><div className="metal-flow-row" key="gc"><div><b>Gold / Copper</b><small>{workspace?.ratios?.goldCopper?.status === 'calculated' ? `${workspace.ratios.goldCopper.change20d >= 0 ? '+' : ''}${workspace.ratios.goldCopper.change20d}% 20d · ${workspace.ratios.goldCopper.read}` : workspace?.ratios?.goldCopper?.reason}</small></div><span className="neutral">{workspace?.ratios?.goldCopper?.status === 'calculated' ? `${workspace.ratios.goldCopper.ratio} · ${workspace.ratios.goldCopper.percentile}th` : '—'}</span></div><div className="cost-callout"><span>What matters next</span><p>A rising gold/silver ratio signals a monetary bid dominating industrial demand; the gold/copper ratio is a compact risk-appetite gauge for the metals complex.</p></div></article>
      <article className="physical-market-panel panel preview-section"><div className="panel-title"><div><p className="section-kicker">PHYSICAL VS PAPER</p><h3>Market plumbing has no keyless source.</h3></div><PreviewBadge label="Inputs required" /></div>{physicalMarket.map(([name, requirement]) => <div className="physical-row" key={name}><div><b>{name}</b><small>{requirement}</small></div><span className="neutral">Unavailable</span></div>)}<p className="model-footnote">Spot-versus-paper dislocation is only meaningful when measured. Each row names the feed it needs; none is published on a keyless public endpoint, so none is estimated here.</p></article>
    </section>

    <section className="metals-bottom-grid">
      <article className={`miners-panel panel ${(workspace?.miners ?? []).length ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">MINER EQUITY EXPRESSION · CALCULATED</p><h3>Miner ETF momentum</h3></div><span className="data-pill">20-session</span></div><div className="miner-list">{(workspace?.miners ?? []).map((miner) => <button key={miner.symbol}><span>{miner.symbol}</span><b>{miner.name}</b><small className={(miner.change20d ?? 0) >= 0 ? 'positive' : 'negative'}>{Number.isFinite(miner.change20d) ? `${miner.change20d > 0 ? '+' : ''}${miner.change20d}%` : '—'}</small><i>↗</i></button>)}{!(workspace?.miners ?? []).length && <div className="equity-empty">Miner histories are required before momentum can publish.</div>}</div><p>Miners add operating leverage to metal prices, but input costs and equity-beta remain separate risks.</p></article>
      <article className={`metal-costs-panel panel ${costStructure?.status === 'unavailable' ? 'preview-section' : ''}`}><div className="panel-title"><div><p className="section-kicker">METALS COST STRUCTURE · {costStructure?.status?.toUpperCase() ?? 'UNAVAILABLE'}</p><h3>{costStructure?.headline ?? 'Awaiting energy and miner histories'}</h3></div>{costStructure?.status === 'unavailable' ? <PreviewBadge label="Inputs required" /> : <span className="data-pill">{Number.isFinite(costStructure?.energyPressure) ? `Energy ${costStructure.energyPressure}th pct` : 'Energy pending'}</span>}</div>{(costStructure?.legs ?? []).map((leg) => <div className="metal-cost-row" key={leg.key}><div><b>{leg.name}</b><small>{leg.status === 'calculated' ? `${leg.source} · ${Number.isFinite(leg.percentile) ? `${leg.percentile}th pct of 1Y` : 'percentile pending'}` : leg.reason}</small></div><span className={leg.status !== 'calculated' ? 'neutral' : leg.change20d > 0 ? 'positive' : leg.change20d < 0 ? 'negative' : 'neutral'}>{leg.status === 'calculated' ? `${leg.unit === 'ratio' ? leg.value : `$${leg.value}`}${Number.isFinite(leg.change20d) ? ` · ${leg.change20d > 0 ? '+' : ''}${leg.change20d}%` : ''}` : 'Unavailable'}</span></div>)}<div className="cost-callout"><span>What matters next</span><p>{costStructure?.read ?? 'Energy histories and a miner-to-metal ratio are required before producer economics can be read.'} {costStructure?.methodology}</p></div></article>
    </section>
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
  </div>;
}

function SignalCell({ label, value }) {
  const missing = value === null || value === undefined || value === '';
  return <span>{label} <b title={missing ? 'Unavailable' : undefined}>{missing ? '—' : value}</b></span>;
}

/** A model that could not publish still arrives as an object carrying its reason. */
function published(model) {
  return Boolean(model) && model.status !== 'unavailable';
}

/**
 * The curve, and specifically what it is doing rather than only where it is —
 * the steepening out of an inversion has historically been the nearer signal.
 */
function YieldCurvePanel({ curve }) {
  const status = curve?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">YIELD CURVE · {status.toUpperCase()}</p><h3>{published ? curve.state : 'Awaiting Treasury yields'}</h3></div>{published ? <span className={`data-pill ${curve.inverted ? 'pill-warning' : ''}`}>{curve.inverted ? 'Inverted' : 'Not inverted'}</span> : null}</div>
    {published ? (curve.spreads ?? []).map((spread) => <div className="stat-row" key={spread.key}>
      <span><strong>{spread.name}</strong><small>{spread.status === 'unavailable' ? spread.reason : `${ordinal(spread.percentile)} percentile of ${spread.rankedAgainst} sessions${spread.inverted ? ` · inverted ${spread.sessionsInverted} sessions` : spread.unInverted ? ` · un-inverted ${spread.sessionsSinceUnInversion} sessions ago` : ''}${Number.isFinite(spread.change60d) ? ` · ${spread.change60d > 0 ? '+' : ''}${spread.change60d} over 60` : ''}`}</small></span>
      <b className={spread.status === 'unavailable' ? '' : spread.inverted ? 'negative' : 'positive'}>{Number.isFinite(spread.spread) ? `${spread.spread}%` : '—'}</b>
    </div>) : <div className="equity-empty">{curve?.reason ?? 'The 10-year yield plus a 2-year or 3-month leg is required.'}</div>}
    <p className="model-footnote">{published ? curve.read : ''} {curve?.methodology ?? ''}</p>
  </article>;
}

/** Market-priced inflation against what the index is actually printing. */
function InflationPanel({ inflation }) {
  const status = inflation?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">INFLATION NOWCAST · {status.toUpperCase()}</p><h3>{published ? inflation.state ?? 'Market pricing published' : 'Awaiting breakeven series'}</h3></div>{published && Number.isFinite(inflation.gapVsRealized) ? <span className="data-pill">{inflation.gapVsRealized > 0 ? '+' : ''}{inflation.gapVsRealized} vs realized</span> : null}</div>
    {published ? <>
      {(inflation.market ?? []).map((leg) => <div className="stat-row" key={leg.key}>
        <span><strong>{leg.name}</strong><small>{leg.status === 'unavailable' ? leg.reason : `${ordinal(leg.percentile)} percentile of ${leg.rankedAgainst} observations${Number.isFinite(leg.change60d) ? ` · ${leg.change60d > 0 ? '+' : ''}${leg.change60d} over 60` : ''}`}</small></span>
        <b>{Number.isFinite(leg.percent) ? `${leg.percent}%` : '—'}</b>
      </div>)}
      <div className="stat-row"><span><strong>Realized CPI, year over year</strong><small>{inflation.realized?.status === 'calculated' ? `${inflation.realized.asOf}${inflation.realized.futureDated ? ' · dated ahead of today, which the feed should not return' : ` · ${inflation.realized.lagDays} days old, the statistic's own release lag`}${Number.isFinite(inflation.realized.threeMonthAnnualizedPercent) ? ` · ${inflation.realized.threeMonthAnnualizedPercent}% three-month annualized` : ''}` : inflation.realized?.reason}</small></span><b>{Number.isFinite(inflation.realized?.yearOverYearPercent) ? `${inflation.realized.yearOverYearPercent}%` : '—'}</b></div>
    </> : <div className="equity-empty">{inflation?.reason ?? 'Breakeven or forward-inflation series are required.'}</div>}
    <p className="model-footnote">{published ? inflation.read : ''} {inflation?.methodology ?? ''}</p>
  </article>;
}

/** How many moves the Treasury curve is pricing — inferred, never a forecast. */
function RatePathPanel({ ratePath }) {
  const status = ratePath?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">RATE PATH · {status.toUpperCase()}</p><h3>{published ? `${Math.abs(ratePath.impliedMovesRounded) || 'No'} ${ratePath.direction === 'no material change' ? 'material change priced' : `${ratePath.direction} priced`}` : 'Awaiting the front of the curve'}</h3></div>{published ? <span className="data-pill">{ratePath.gapBasisPoints}bp 2Y vs 3M</span> : null}</div>
    {published ? <>
      {(ratePath.legs ?? []).map((leg) => <div className="stat-row" key={leg.key}><span><strong>{leg.name}</strong><small>{leg.asOf}</small></span><b>{Number.isFinite(leg.percent) ? `${leg.percent}%` : '—'}</b></div>)}
      {Number.isFinite(ratePath.shift60d) ? <div className="stat-row"><span><strong>Pricing shift, 60 sessions</strong><small>Change in the implied count of moves</small></span><b className={ratePath.shift60d >= 0 ? 'positive' : 'negative'}>{ratePath.shift60d > 0 ? '+' : ''}{ratePath.shift60d}</b></div> : null}
    </> : <div className="equity-empty">{ratePath?.reason ?? 'Both the 2-year and 3-month yields are required.'}</div>}
    <p className="model-footnote">{published ? ratePath.read : ''} {ratePath?.methodology ?? ''}</p>
  </article>;
}

/** The two most predictable liquidity shocks, placed forward in time. */
function LiquidityCalendarPanel({ calendar }) {
  const status = calendar?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">LIQUIDITY CALENDAR · {status.toUpperCase()}</p><h3>{published ? `Next ${calendar.horizonDays} days` : 'Awaiting TGA history'}</h3></div>{published ? <span className="data-pill">{calendar.quarterEnd.daysAway}d to quarter-end</span> : null}</div>
    {published ? (calendar.events ?? []).map((event) => <div className="stat-row" key={event.key}>
      <span><strong>{event.name}</strong><small>{event.note}</small></span>
      <b>{event.date ? `${event.daysAway}d` : Number.isFinite(event.liquidityEffectUsdMillions) ? `${event.liquidityEffectUsdMillions >= 0 ? '+' : ''}${Math.round(event.liquidityEffectUsdMillions / 1000)}bn` : `${event.daysAway}d`}</b>
    </div>) : <div className="equity-empty">{calendar?.reason ?? 'A year of Treasury general account history is required.'}</div>}
    <p className="model-footnote">{published ? calendar.read : ''} {calendar?.methodology ?? ''}</p>
  </article>;
}

/** What the regime engine's own labels have been worth in this history. */
function RegimeHistoryPanel({ history }) {
  const status = history?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  const recent = (history?.transitions ?? []).slice(-5).reverse();
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">REGIME HISTORY · {status.toUpperCase()}</p><h3>{published ? `${history.transitions.length} transitions since ${history.coveredFrom}` : 'Awaiting overlapping macro history'}</h3></div>{published ? <span className={`data-pill ${history.vintage === 'point-in-time' ? '' : 'pill-warning'}`}>{history.vintage === 'point-in-time' ? 'Point-in-time' : 'Hindsight'}</span> : null}</div>{published ? <p className="regime-proximity">{history.vintage === 'point-in-time' ? `${history.current.runDays} days in ${history.current.regime}. Scored on point-in-time observations for ${history.pointInTimeKeys.join(', ')}, so no revision that postdates a scoring date is used.` : `${history.current.runDays} days in ${history.current.regime}. Scored on the current vintage of every input, so revisions that did not exist at the time are in use — a hindsight study, not a backtest.${history.vintageReason ? ` ${history.vintageReason}` : ''}`}</p> : null}
    {published ? <>
      {recent.length ? <div className="stat-head"><span>Transition</span><span>Benchmark after</span></div> : null}
      {recent.map((entry) => <div className="stat-row" key={entry.date}>
        <span><strong>{`${entry.from} → ${entry.to}`}</strong><small>{`${entry.date} · score ${entry.score}`}</small></span>
        <b className={Number.isFinite(entry.forward63) ? (entry.forward63 >= 0 ? 'positive' : 'negative') : ''}>{Number.isFinite(entry.forward21) ? `${entry.forward21 > 0 ? '+' : ''}${entry.forward21}% / ` : 'pending / '}{Number.isFinite(entry.forward63) ? `${entry.forward63 > 0 ? '+' : ''}${entry.forward63}%` : 'pending'}</b>
      </div>)}
      {recent.length ? null : <div className="equity-empty">No regime change inside the recomputed window.</div>}
    </> : <div className="equity-empty">{history?.reason ?? 'At least two overlapping macro histories are required.'}</div>}
    <p className="model-footnote">{published ? `${history.read} ${history.reason ?? ''}` : ''} {history?.methodology ?? ''}</p>
  </article>;
}

/** Market proxies standing in for activity data, which they lead but do not measure. */
function GrowthNowcastPanel({ nowcast }) {
  const status = nowcast?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">GROWTH NOWCAST · {status.toUpperCase()}</p><h3>{published ? nowcast.state : 'Awaiting growth proxies'}</h3></div>{published ? <span className="data-pill">{nowcast.score}/100 · {nowcast.coverage}% coverage</span> : null}</div>
    {(nowcast?.legs ?? []).map((leg) => <div className="stat-row" key={leg.key}>
      <span><strong>{leg.name}</strong><small>{leg.score === null ? 'Unavailable' : leg.note}</small></span>
      <b>{leg.score === null ? '—' : `${leg.score}${Number.isFinite(leg.value) ? ` · ${leg.value > 0 ? '+' : ''}${leg.value}` : ''}`}</b>
    </div>)}
    {published ? null : <div className="equity-empty">{nowcast?.reason ?? 'At least three growth proxies are required.'}</div>}
    <p className="model-footnote">{published ? nowcast.read : ''} {nowcast?.methodology ?? ''}</p>
  </article>;
}

/** What is inside a nominal yield move: real yields or inflation compensation. */
function NominalDecompositionPanel({ decomposition }) {
  const status = decomposition?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">WHAT MOVED THE 10-YEAR · {status.toUpperCase()}</p><h3>{published ? `${(decomposition.driver ?? 'Both legs').replace(/^./, (letter) => letter.toUpperCase())} drove it` : 'Awaiting the three yield legs'}</h3></div>{published ? <span className="data-pill">{decomposition.nominalPercent}% nominal</span> : null}</div>
    {published ? <>
      <div className="stat-row"><span><strong>Composition today</strong><small>{`Real ${decomposition.realPercent}% plus breakeven ${decomposition.breakevenPercent}%`}</small></span><b>{decomposition.nominalPercent}%</b></div>
      {(decomposition.windows ?? []).map((entry) => <div className="stat-row" key={entry.days}>
        <span><strong>{`Over ${entry.spanDays ?? entry.days} days`}</strong><small>{entry.status === 'calculated' ? `real ${entry.realBasisPoints > 0 ? '+' : ''}${entry.realBasisPoints}bp · breakeven ${entry.breakevenBasisPoints > 0 ? '+' : ''}${entry.breakevenBasisPoints}bp${Math.abs(entry.residualBasisPoints) >= 3 ? ` · ${entry.residualBasisPoints}bp residual` : ''}` : entry.reason}</small></span>
        <b className={Number.isFinite(entry.nominalBasisPoints) ? (entry.nominalBasisPoints >= 0 ? 'negative' : 'positive') : ''}>{Number.isFinite(entry.nominalBasisPoints) ? `${entry.nominalBasisPoints > 0 ? '+' : ''}${entry.nominalBasisPoints}bp` : '—'}</b>
      </div>)}
    </> : <div className="equity-empty">{decomposition?.reason ?? 'The nominal, real and breakeven 10-year series are all required.'}</div>}
    <p className="model-footnote">{published ? decomposition.read : ''} {decomposition?.methodology ?? ''}</p>
  </article>;
}

/** Expected short rates against the compensation demanded for holding duration. */
function TermPremiumPanel({ premium }) {
  const status = premium?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">TERM PREMIUM · {status.toUpperCase()}</p><h3>{published ? `${premium.premiumPercent}%${premium.negative ? ', still negative' : ''}` : 'Awaiting the term-premium series'}</h3></div>{published ? <span className="data-pill">{ordinal(premium.percentile)} percentile</span> : null}</div>
    {published ? <>
      {Number.isFinite(premium.expectationsPercent) ? <div className="stat-row"><span><strong>Expected short rates</strong><small>The nominal 10-year less the premium</small></span><b>{premium.expectationsPercent}%</b></div> : null}
      {(premium.windows ?? []).map((entry) => <div className="stat-row" key={entry.days}>
        <span><strong>{`Over ${entry.spanDays ?? entry.days} days`}</strong><small>{entry.status === 'calculated' ? `${entry.driver.replace(/^./, (letter) => letter.toUpperCase())} drove it · expectations ${entry.expectationsBasisPoints > 0 ? '+' : ''}${entry.expectationsBasisPoints}bp` : entry.reason}</small></span>
        <b>{Number.isFinite(entry.premiumBasisPoints) ? `${entry.premiumBasisPoints > 0 ? '+' : ''}${entry.premiumBasisPoints}bp` : '—'}</b>
      </div>)}
    </> : <div className="equity-empty">{premium?.reason ?? 'FRED THREEFYTP10 is required.'}</div>}
    <p className="model-footnote">{published ? premium.read : ''} {premium?.methodology ?? ''}</p>
  </article>;
}

/** The US yield advantage over developed peers — the main FX driver. */
function RateDivergencePanel({ divergence }) {
  const status = divergence?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">RATE DIVERGENCE · {status.toUpperCase()}</p><h3>{published ? divergence.state : 'Awaiting foreign long rates'}</h3></div>{published ? <span className="data-pill">US {divergence.usPercent}%</span> : null}</div>
    {published ? (divergence.markets ?? []).map((market) => <div className="stat-row" key={market.key}>
      <span><strong>{market.name}</strong><small>{market.status === 'unavailable' ? market.reason : `${market.foreignPercent}% · ${ordinal(market.percentile)} percentile of ${market.rankedAgainst} readings${Number.isFinite(market.changeBasisPoints) ? ` · ${market.changeBasisPoints > 0 ? '+' : ''}${market.changeBasisPoints}bp over ${market.spanDays}d` : ''} · ${market.cadenceDays}d bars`}</small></span>
      <b className={Number.isFinite(market.spreadPercent) ? (market.spreadPercent >= 0 ? 'positive' : 'negative') : ''}>{Number.isFinite(market.spreadPercent) ? `${market.spreadPercent > 0 ? '+' : ''}${market.spreadPercent}` : '—'}</b>
    </div>) : <div className="equity-empty">{divergence?.reason ?? 'Foreign long-rate series are required.'}</div>}
    <p className="model-footnote">{published ? divergence.read : ''} {divergence?.methodology ?? ''}</p>
  </article>;
}

/** Whether official data has been running above or below its own trend. */
function DataSurprisePanel({ surprise }) {
  const status = surprise?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">DATA SURPRISE · {status.toUpperCase()}</p><h3>{published ? surprise.state : 'Awaiting activity series'}</h3></div>{published ? <span className="data-pill">{surprise.score}/100 · {surprise.coverage}% coverage</span> : null}</div>
    {(surprise?.indicators ?? []).map((indicator) => <div className="stat-row" key={indicator.key}>
      <span><strong>{indicator.name}{indicator.inverse ? ' (inverted)' : ''}</strong><small>{indicator.status === 'calculated' ? `${indicator.asOf} · ${Number.isFinite(indicator.percentile) ? `${ordinal(indicator.percentile)} percentile of ${indicator.observations} scored releases` : `${indicator.observations} scored releases, too uniform to rank`} · six-release average ${indicator.averageRecent > 0 ? '+' : ''}${indicator.averageRecent}σ` : indicator.reason}</small></span>
      <b className={Number.isFinite(indicator.zScore) ? (indicator.zScore >= 0 ? 'positive' : 'negative') : ''}>{Number.isFinite(indicator.zScore) ? `${indicator.zScore > 0 ? '+' : ''}${indicator.zScore}σ` : '—'}</b>
    </div>)}
    {published ? null : <div className="equity-empty">{surprise?.reason ?? 'At least two activity series are required.'}</div>}
    <p className="model-footnote">{published ? surprise.read : ''} {surprise?.methodology ?? ''}</p>
  </article>;
}

/** What the liquidity impulse has been worth, bucketed by tercile. */
function LiquidityPayoffPanel({ payoff }) {
  const status = payoff?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">LIQUIDITY PAYOFF · {status.toUpperCase()}</p><h3>{published ? `${payoff.edgePercent > 0 ? '+' : ''}${payoff.edgePercent}-point spread` : 'Awaiting liquidity and asset histories'}</h3></div>{published ? <span className="data-pill">{payoff.samples} overlapping samples</span> : null}</div>
    {published ? <>
      <div className="stat-head"><span>{`${payoff.changeDays}-day impulse`}</span><span>{`Next ${payoff.forwardDays} days`}</span></div>
      {(payoff.buckets ?? []).map((bucket) => <div className="stat-row" key={bucket.key}>
        <span><strong>{bucket.name}</strong><small>{`${bucket.impulseFrom}% to ${bucket.impulseTo}% · ${bucket.observations} observations · ${bucket.positiveSharePercent}% positive`}</small></span>
        <b className={bucket.averageForwardPercent >= 0 ? 'positive' : 'negative'}>{bucket.averageForwardPercent > 0 ? '+' : ''}{bucket.averageForwardPercent}%</b>
      </div>)}
    </> : <div className="equity-empty">{payoff?.reason ?? 'A liquidity history and a long asset history are both required.'}</div>}
    <p className="model-footnote">{published ? payoff.read : ''} {payoff?.methodology ?? ''}</p>
  </article>;
}

/** The market's own read on when reserves stop being abundant. */
function ReserveScarcityPanel({ scarcity }) {
  const status = scarcity?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  return <article className={`panel ${published ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">RESERVE SCARCITY · {status.toUpperCase()}</p><h3>{published ? scarcity.state : 'Awaiting SOFR and IORB'}</h3></div>{published ? <span className={`data-pill ${scarcity.spreadBasisPoints >= scarcity.thresholdBasisPoints ? 'pill-warning' : ''}`}>{scarcity.spreadBasisPoints > 0 ? '+' : ''}{scarcity.spreadBasisPoints}bp</span> : null}</div>
    {published ? <>
      <div className="stat-row"><span><strong>SOFR over the reserve rate</strong><small>{`${ordinal(scarcity.percentile)} percentile of ${scarcity.rankedAgainst} sessions`}</small></span><b className={scarcity.spreadBasisPoints >= scarcity.thresholdBasisPoints ? 'negative' : 'positive'}>{scarcity.spreadBasisPoints > 0 ? '+' : ''}{scarcity.spreadBasisPoints}bp</b></div>
      <div className="stat-row"><span><strong>{`Sessions at or above ${scarcity.thresholdBasisPoints}bp`}</strong><small>Out of the last 21</small></span><b>{scarcity.daysAboveThreshold}</b></div>
      {Number.isFinite(scarcity.changeBasisPoints) ? <div className="stat-row"><span><strong>Change over a quarter</strong><small>Direction of the funding pressure</small></span><b className={scarcity.changeBasisPoints >= 0 ? 'negative' : 'positive'}>{scarcity.changeBasisPoints > 0 ? '+' : ''}{scarcity.changeBasisPoints}bp</b></div> : null}
    </> : <div className="equity-empty">{scarcity?.reason ?? 'Both SOFR and IORB are required.'}</div>}
    <p className="model-footnote">{published ? scarcity.read : ''} {scarcity?.methodology ?? ''}</p>
  </article>;
}

/** What the macro models say when read against each other. */
function ConsensusPanel({ consensus }) {
  const status = consensus?.status ?? 'unavailable';
  const publishedNow = status !== 'unavailable';
  return <article className={`panel ${publishedNow ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">MODEL CONSENSUS · {status.toUpperCase()}</p><h3>{publishedNow ? consensus.state : 'Awaiting three published models'}</h3></div>{publishedNow ? <span className={`data-pill ${consensus.spread >= 60 ? 'pill-warning' : ''}`}>{consensus.averageScore}/100 · {consensus.spread}-point spread</span> : null}</div>{consensus?.vintage?.laggingCount ? <p className="regime-proximity">{`${consensus.vintage.laggingCount} ${consensus.vintage.laggingCount === 1 ? 'signal describes' : 'signals describe'} a moment more than three weeks old — the oldest is ${consensus.vintage.oldest.name} at ${consensus.vintage.oldest.ageDays} days, ${consensus.vintage.spreadDays} behind ${consensus.vintage.freshest.name}. Several of these series are monthly by nature, so this is which moment each reading describes rather than a judgement about the feed.`}</p> : null}
    {publishedNow ? <>
      {(consensus.signals ?? []).filter((signal) => signal.available).map((signal) => <div className="stat-row" key={signal.key}>
        <span><strong>{signal.name}{signal.lagging ? <i className="slow-cadence" aria-label="describes an older moment"> ·{signal.ageDays}d</i> : null}</strong><small>{`${signal.detail ?? signal.family}${signal.asOf ? ` · as of ${signal.asOf}` : ' · no date published'}`}</small></span>
        <b className={signal.score >= 60 ? 'positive' : signal.score <= 40 ? 'negative' : ''}>{signal.score}</b>
      </div>)}
      {(consensus.cautions ?? []).filter((signal) => signal.available).map((signal) => <div className="stat-row" key={signal.key}>
        <span><strong>{signal.name}<i className="slow-cadence" aria-label="caution, not a direction"> ·c</i></strong><small>{signal.note}</small></span>
        <b>{signal.score}</b>
      </div>)}
    </> : <div className="equity-empty">{consensus?.reason ?? 'At least three macro models must publish before they can be compared.'}</div>}
    <p className="model-footnote">{publishedNow ? consensus.read : ''} {consensus?.methodology ?? ''}</p>
  </article>;
}

/** The pairs that genuinely disagree, which an average would have hidden. */
function ContradictionPanel({ consensus }) {
  const contradictions = consensus?.contradictions ?? [];
  const outliers = consensus?.outliers ?? [];
  const publishedNow = consensus?.status && consensus.status !== 'unavailable';
  return <article className={`panel ${publishedNow ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">CONTRADICTIONS · {publishedNow ? 'CALCULATED' : 'UNAVAILABLE'}</p><h3>{!publishedNow ? 'Awaiting the consensus layer' : outliers.length ? `${outliers.map((entry) => entry.name).join(' and ')} stand${outliers.length === 1 ? 's' : ''} apart` : contradictions.length ? `${contradictions.length} disagreeing ${contradictions.length === 1 ? 'pair' : 'pairs'}` : 'No pair disagrees materially'}</h3></div>{publishedNow && consensus.sameFamilyContradictions ? <span className="data-pill pill-warning">{consensus.sameFamilyContradictions} inside one family</span> : null}</div>
    {outliers.length ? <>
      <div className="stat-head"><span>Standing apart</span><span>vs median</span></div>
      {outliers.map((entry) => <div className="stat-row" key={`outlier-${entry.key}`}>
        <span><strong>{entry.name}</strong><small>{entry.read}</small></span>
        <b className={entry.distance < 0 ? 'negative' : 'positive'}>{entry.distance > 0 ? '+' : ''}{entry.distance}</b>
      </div>)}
    </> : null}
    {contradictions.length ? <>
      <div className="stat-head"><span>Widest pairs</span><span>Apart</span></div>
      {contradictions.slice(0, 4).map((entry) => <div className="stat-row" key={entry.key}>
        <span><strong>{`${entry.higher.name} vs ${entry.lower.name}`}</strong><small>{entry.read}</small></span>
        <b className={entry.sameFamily ? 'negative' : ''}>{entry.distance}</b>
      </div>)}
    </> : <div className="equity-empty">{publishedNow ? `Every published model sits within ${consensus.spread} points of the others, so nothing here is pulling against anything else.` : 'The consensus layer must publish first.'}</div>}
    <p className="model-footnote">Two readings from the same family disagreeing is a data problem worth seeing; two from different families disagreeing is the ordinary tension between, say, liquidity and growth. Both are surfaced and labelled apart.</p>
  </article>;
}

/** Which models actually move together, from their stored output history. */
function ModelCorrelationPanel({ matrix }) {
  const status = matrix?.status ?? 'unavailable';
  const publishedNow = status !== 'unavailable';
  const pairs = (matrix?.pairs ?? []).filter((pair) => pair.status === 'calculated').sort((left, right) => Math.abs(right.correlation) - Math.abs(left.correlation));
  return <article className={`panel ${publishedNow ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">MODEL OVERLAP · {status.toUpperCase()}</p><h3>{publishedNow ? `${pairs.length} correlated pairs` : 'Awaiting stored model history'}</h3></div>{publishedNow && matrix.redundantPairs?.length ? <span className="data-pill pill-warning">{matrix.redundantPairs.length} near-duplicate</span> : null}</div>
    {pairs.length ? pairs.slice(0, 8).map((pair) => <div className="stat-row" key={pair.key}>
      <span><strong>{`${pair.left} vs ${pair.right}`}</strong><small>{`${pair.observations} shared vintages${Math.abs(pair.correlation) >= 0.9 ? ' · near-duplication rather than confirmation' : ''}`}</small></span>
      <b className={Math.abs(pair.correlation) >= 0.9 ? 'negative' : ''}>{pair.correlation > 0 ? '+' : ''}{pair.correlation}</b>
    </div>) : <div className="equity-empty">{matrix?.reason ?? 'Model outputs accumulate only once PostgreSQL is configured and ingestion has run.'}</div>}
    <p className="model-footnote">{publishedNow ? matrix.read : ''} {matrix?.methodology ?? ''}</p>
  </article>;
}

/** The time-sensitive readings, raised. */
// "rrp-exhaustion" reads as "Rrp exhaustion" under a plain capitalisation.
const ALERT_TITLES = {
  'curve-uninverted': 'Curve un-inverted',
  'curve-inverted': 'Curve inverted',
  'reserves-tightening': 'Reserves tightening',
  'rrp-exhaustion': 'RRP exhaustion',
  'quarter-end': 'Quarter-end approaching',
  'regime-borderline': 'Regime borderline',
  'regime-overdue': 'Regime overdue',
  'term-premium-repricing': 'Term-premium repricing',
  'models-divided': 'Models divided',
};

function alertTitle(key) {
  return ALERT_TITLES[key] ?? key.replace(/-/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function MacroAlertsPanel({ alerts }) {
  const entries = alerts?.entries ?? [];
  const skipped = alerts?.skipped ?? [];
  return <article className={`panel ${entries.length ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">MACRO ALERTS · {(alerts?.status ?? 'unavailable').toUpperCase()}</p><h3>{entries.length ? `${entries.length} live${(alerts.raised ?? []).length ? `, ${alerts.raised.length} new` : ''}` : (alerts?.resolved ?? []).length ? `${alerts.resolved.length} cleared` : 'Nothing live'}</h3></div>{alerts?.counts?.high ? <span className="data-pill pill-warning">{alerts.counts.high} high</span> : null}</div>
    {entries.length ? entries.map((entry) => <div className="stat-row" key={entry.key}>
      <span><strong>{alertTitle(entry.key)}{entry.isNew ? <i className="slow-cadence" aria-label="new since the last evaluation"> ·new</i> : null}</strong><small>{`${entry.text}${entry.isNew ? '' : ' Still live — raised at an earlier evaluation.'}${entry.unknownBefore ? ' Its model could not be evaluated last time, so whether it was already live is unknown.' : ''}`}</small></span>
      <b className={entry.severity === 'high' ? 'negative' : entry.severity === 'low' ? '' : 'positive'}>{entry.severity}</b>
    </div>) : <div className="equity-empty">{alerts?.read ?? 'Alert rules publish once their models do.'}</div>}
    {(alerts?.resolved ?? []).length ? <>
      <div className="stat-head"><span>Cleared since the last evaluation</span><span></span></div>
      {alerts.resolved.map((entry) => <div className="stat-row" key={`resolved-${entry.key}`}><span><strong>{alertTitle(entry.key)}</strong><small>{entry.text}</small></span><b>cleared</b></div>)}
    </> : null}
    {skipped.length ? <p className="model-footnote">{`${skipped.length} of the rules could not be evaluated because their model did not publish: ${skipped.map((entry) => entry.key).join(', ')}. "We cannot tell" and "it is not happening" are different answers.`}</p> : null}
    <p className="model-footnote">{alerts?.methodology ?? ''}</p>
  </article>;
}

/** Which drivers inside the regime composite are counted twice. */
function WeightOverlapPanel({ overlap }) {
  const status = overlap?.status ?? 'unavailable';
  const publishedNow = status !== 'unavailable';
  const pairs = overlap?.pairs ?? [];
  return <article className={`panel ${publishedNow ? '' : 'preview-section'}`}>
    <div className="panel-title"><div><p className="section-kicker">DRIVER OVERLAP · {status.toUpperCase()}</p><h3>{!publishedNow ? 'Awaiting measured correlations' : pairs.length ? `${pairs.length} driver ${pairs.length === 1 ? 'pair' : 'pairs'} counted twice` : 'No driver counted twice'}</h3></div>{publishedNow && Number.isFinite(overlap.difference) && overlap.difference !== 0 ? <span className="data-pill pill-warning">{overlap.adjustedScore} adjusted vs {overlap.headlineScore}</span> : null}</div>
    {pairs.length ? pairs.map((pair) => <div className="stat-row" key={pair.key}>
      <span><strong>{pair.drivers.join(' and ')}</strong><small>{`Move together at ${pair.correlation} across their stored vintages · ${pair.combinedWeight} of the composite's weight between them`}</small></span>
      <b className="negative">+{pair.correlation}</b>
    </div>) : <div className="equity-empty">{publishedNow ? overlap.read : overlap?.reason ?? 'Measured model correlations are required before overlap can be distinguished from agreement.'}</div>}
    {(overlap?.offsetting ?? []).length ? <>
      <div className="stat-head"><span>Offsetting, not duplicating</span><span>r</span></div>
      {overlap.offsetting.map((pair) => <div className="stat-row" key={pair.key}>
        <span><strong>{pair.drivers.join(' and ')}</strong><small>{pair.read}</small></span>
        <b>{pair.correlation}</b>
      </div>)}
    </> : null}
    <p className="model-footnote">{publishedNow && pairs.length ? overlap.read : ''} {overlap?.methodology ?? ''}</p>
  </article>;
}

function MacroDashboard({ data }) {
  const [activeModel, setActiveModel] = React.useState('Overview');
  const [correlationWindow, setCorrelationWindow] = React.useState('60D');
  const [liquidityChartOpen, setLiquidityChartOpen] = React.useState(false);
  const [globalChartOpen, setGlobalChartOpen] = React.useState(false);
  const liquidityRaw = data.liquidity?.model;
  const liquidityModel = published(liquidityRaw) ? liquidityRaw : null;
  const liquidityRunway = data.liquidity?.liquidityRunway;
  const globalLiquidityRaw = data.liquidity?.globalLiquidity;
  const globalLiquidity = published(globalLiquidityRaw) ? globalLiquidityRaw : null;
  const usdStrengthRaw = data.liquidity?.usdStrength;
  const usdStrength = published(usdStrengthRaw) ? usdStrengthRaw : null;
  const macroRegime = data.liquidity?.macroRegime;
  const dollarScenarios = data.liquidity?.dollarScenarios;
  const usdDrivers = Object.fromEntries((usdStrength?.drivers ?? []).map((driver) => [driver.key, driver]));
  const liquidityHistory = normalizeSparkline(liquidityModel?.history?.map((point) => point.value) ?? []);
  const globalLiquidityHistory = normalizeSparkline(globalLiquidity?.history?.map((point) => point.value) ?? []);
  const regimeCorrelations = data.regimeCorrelations;
  const rcPairs = regimeCorrelations?.pairs ?? [];
  const rcValue = (pair) => pair?.correlations?.[correlationWindow];
  const calculatedPairs = rcPairs.filter((pair) => pair.status === 'calculated' && Number.isFinite(rcValue(pair)));
  const strongestPair = calculatedPairs.length ? calculatedPairs.reduce((best, pair) => Math.abs(rcValue(pair)) > Math.abs(rcValue(best)) ? pair : best) : null;
  const weakestPair = calculatedPairs.length ? calculatedPairs.reduce((worst, pair) => Math.abs(rcValue(pair)) < Math.abs(rcValue(worst)) ? pair : worst) : null;
  const rcByKey = Object.fromEntries(rcPairs.map((pair) => [pair.key, pair]));
  const leadSignals = regimeCorrelations?.leadSignals ?? [];
  const leadSignal = leadSignals[0] ?? null;
  const narrative = data.liquidity?.narrative;
  const sensitivityTone = (value) => !Number.isFinite(value) ? 'Unavailable' : Math.abs(value) >= 0.5 ? 'High' : Math.abs(value) >= 0.25 ? 'Medium' : 'Low';
  const sensitivityRows = [
    { asset: 'BTC', driver: 'Broad dollar', pairKey: 'dollarBitcoin' },
    { asset: 'Gold', driver: 'Real yields', pairKey: 'realYieldsGold' },
    { asset: 'Equities', driver: 'Credit spreads', pairKey: 'creditEquities' },
  ].map(({ asset, driver, pairKey }) => {
    const value = rcValue(rcByKey[pairKey]);
    return { asset, driver, value, strength: sensitivityTone(value) };
  });

  return <div className="macro-dashboard">
    <section className="macro-intro">
      <div><p className="eyebrow">MACRO RESEARCH SYSTEM</p><h1>Liquidity leads. Risk confirms.</h1><p className="intro">A cross-asset view of the forces shaping capital availability and market regime.</p></div>
      <div className="model-tabs"><button className={activeModel === 'Overview' ? 'active' : ''} onClick={() => setActiveModel('Overview')}>Overview</button><button className={activeModel === 'Liquidity' ? 'active' : ''} onClick={() => setActiveModel('Liquidity')}>US liquidity</button><button className={activeModel === 'Global' ? 'active' : ''} onClick={() => setActiveModel('Global')}>Global liquidity</button><button className={activeModel === 'Risk' ? 'active' : ''} onClick={() => setActiveModel('Risk')}>Macro regime</button><button className={activeModel === 'Correlations' ? 'active' : ''} onClick={() => setActiveModel('Correlations')}>Correlations {regimeCorrelations?.status !== 'calculated' && <small className="tab-preview">Preview</small>}</button><button className={activeModel === 'Rates' ? 'active' : ''} onClick={() => setActiveModel('Rates')}>Rates &amp; growth</button><button className={activeModel === 'Consensus' ? 'active' : ''} onClick={() => setActiveModel('Consensus')}>Cross-model</button><button className={activeModel === 'FX' ? 'active' : ''} onClick={() => setActiveModel('FX')}>USD &amp; FX</button></div>
    </section>
    <DataDisclosure data={data} message="Every model here is a versioned calculation from keyless public sources; only panels whose sources are confirmed blocked remain preview-labeled." />
    {data.liquidity?.series?.length ? <section className="official-data-strip panel"><div><p className="section-kicker">OFFICIAL FRED OBSERVATIONS</p><b>Latest released data</b></div>{data.liquidity.series.slice(0, 5).map((series) => <div key={series.id}><span>{series.name}</span><strong>{formatMacroValue(series)}</strong><small className={series.freshness?.state === 'overdue' ? 'freshness-overdue' : undefined} title={series.freshness?.read ?? undefined}>{series.date}{series.stale ? ' · stale' : series.freshness?.state === 'overdue' ? ' · print overdue' : series.stored ? ' · stored' : ' · live'}</small></div>)}</section> : <section className="provider-setup-note"><b>Live macro feed unavailable</b><span>The server could not reach FRED (API or public CSV endpoint) and no stored observations exist yet.</span></section>}

    <section className="model-overview-grid">
      <article className={`macro-model panel ${activeModel === 'Liquidity' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">US LIQUIDITY MODEL</p><h2>{liquidityModel?.regime ?? 'Awaiting FRED'} <span className="status-dot"></span></h2><p>{liquidityModel ? 'Fed net liquidity, M2, and dollar transmission' : liquidityRaw?.reason ?? 'Waiting on live macro histories'}</p></div><div className="score-orbit"><b>{liquidityModel?.score ?? '—'}</b><small>/100</small></div></div>
        <div className="liquidity-chart"><div className="chart-caption"><span>Calculated net liquidity</span><div><strong>{liquidityModel ? formatLiquidityValue(liquidityModel.netLiquidity) : 'Unavailable'}</strong><button className="chart-expand-button" onClick={() => setLiquidityChartOpen(true)} disabled={!liquidityModel?.history?.length} aria-label="Enlarge liquidity history chart">↗</button></div></div>{liquidityHistory.length ? <Sparkline color="#75c966" values={liquidityHistory} /> : <div className="model-chart-empty">No calculated history</div>}<div className="liquidity-axis"><span>Oldest</span><span>Midpoint</span><span>Recent</span><span>Latest</span></div></div>
        <div className="signal-summary"><SignalCell label="Momentum" value={liquidityModel?.momentum} /><SignalCell label="Breadth" value={liquidityModel ? `${liquidityModel.breadth.positive}/${liquidityModel.breadth.total} up` : null} /><SignalCell label="Confidence" value={liquidityModel?.confidence} /></div>
        <div className="model-action"><span>{liquidityModel?.version ?? 'No model output'}</span><button onClick={() => setActiveModel('Liquidity')}>Open model →</button></div>
      </article>

      <article className={`macro-model panel global-model ${activeModel === 'Global' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">GLOBAL LIQUIDITY MODEL</p><h2>{globalLiquidity?.regime ?? 'Awaiting FRED'} <span className="status-dot violet"></span></h2><p>{globalLiquidity ? 'Fed, ECB, and BoJ balance sheets in USD' : globalLiquidityRaw?.reason ?? 'Waiting on live macro histories'}</p></div><div className="score-orbit violet-orbit"><b>{globalLiquidity?.score ?? '—'}</b><small>/100</small></div></div>
        <div className="liquidity-chart"><div className="chart-caption"><span>Central-bank liquidity, USD</span><div><strong>{globalLiquidity ? formatLiquidityValue(globalLiquidity.globalLiquidityUsdMillions) : 'Unavailable'}</strong><button className="chart-expand-button" onClick={() => setGlobalChartOpen(true)} disabled={!globalLiquidity?.history?.length} aria-label="Enlarge global liquidity history chart">↗</button></div></div>{globalLiquidityHistory.length ? <Sparkline color="#b08ad6" values={globalLiquidityHistory} /> : <div className="model-chart-empty">No calculated history</div>}<div className="liquidity-axis"><span>Oldest</span><span>Midpoint</span><span>Recent</span><span>Latest</span></div></div>
        <div className="signal-summary"><SignalCell label="Momentum" value={globalLiquidity?.momentum} /><SignalCell label="YoY growth" value={Number.isFinite(globalLiquidity?.cycle?.growthPercent) ? `${globalLiquidity.cycle.growthPercent > 0 ? '+' : ''}${globalLiquidity.cycle.growthPercent}% · ${Number.isFinite(globalLiquidity.cycle.growthPercentile) ? ordinal(globalLiquidity.cycle.growthPercentile) : '—'}` : null} /><SignalCell label="Confidence" value={globalLiquidity?.confidence} /></div>
        <div className="model-action"><span>{globalLiquidity?.version ?? 'No model output'}</span><button onClick={() => setActiveModel('Global')}>Open model →</button></div>
      </article>

      <article className={`macro-model panel risk-model ${activeModel === 'Risk' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">MACRO REGIME · {macroRegime?.status?.toUpperCase() ?? 'UNAVAILABLE'}</p><h2>{macroRegime?.regime ?? 'Awaiting inputs'} <span className="status-dot blue"></span></h2><p>{macroRegime ? `${macroRegime.coverage}% independent-driver coverage${macroRegime.proximity?.nearest ? ` · ${macroRegime.proximity.nearest.distance} from ${macroRegime.proximity.nearest.regime}` : macroRegime.panicConfirmed ? ' · panic override active' : ''}` : 'Connect at least two independent FRED sleeves'}</p></div><div className="score-orbit blue-orbit"><b>{macroRegime?.score ?? '—'}</b><small>/100</small></div></div>
        <div className="risk-lanes">{(macroRegime?.drivers ?? []).slice(0, 3).map((driver) => <div key={driver.key}><span>{driver.name}</span><i><b style={{ width: `${driver.score ?? 0}%` }}></b></i><strong>{driver.score ?? '—'}</strong></div>)}</div>
        <div className="signal-summary"><SignalCell label="Risk budget" value={macroRegime?.settings?.riskBudget} /><SignalCell label="Confidence" value={macroRegime?.confidence} /><SignalCell label="Panic" value={macroRegime?.panicConfirmed === true ? 'Confirmed' : macroRegime?.panicConfirmed === false ? 'Not confirmed' : null} /></div>
        <div className="model-action"><span>{macroRegime?.version ?? 'No model output'}</span><button onClick={() => setActiveModel('Risk')}>Open model →</button></div>
      </article>
      <article className={`macro-model panel correlation-model ${regimeCorrelations?.status === 'calculated' ? '' : 'preview-section'} ${activeModel === 'Correlations' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">REGIME CORRELATIONS · {regimeCorrelations?.status === 'calculated' ? 'CALCULATED' : 'PREVIEW'}</p><h2>{calculatedPairs.length ? `${calculatedPairs.length} calculated links` : 'Awaiting histories'} <span className="status-dot violet"></span></h2><p>{calculatedPairs.length ? 'Daily-change correlations across stored macro and market series' : 'Awaiting synchronized stored histories'}</p></div><div className="correlation-glyph"><span></span><i></i><b></b><em></em></div></div>
        <div className="correlation-preview"><span>Strongest</span><b>{strongestPair ? <>{strongestPair.left} <i>↔</i> {strongestPair.right}</> : '—'}</b><strong>{strongestPair ? rcValue(strongestPair).toFixed(2) : '—'}</strong><span>Moves first</span><b>{leadSignal ? <>{leadSignal.leader} <i>→</i> {leadSignal.follower}</> : 'No lead detected'}</b><strong>{leadSignal ? `${leadSignal.leadDays}d` : '—'}</strong></div>
        <div className="model-action"><span>{regimeCorrelations?.version ?? 'Rolling correlations'}</span><button onClick={() => setActiveModel('Correlations')}>Open map →</button></div>
      </article>
      <article className={`macro-model panel fx-model ${activeModel === 'FX' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">USD STRENGTH · {usdStrength?.status?.toUpperCase() ?? 'UNAVAILABLE'}</p><h2>{usdStrength?.regime ?? 'Awaiting FRED'} <span className="status-dot amber"></span></h2><p>Broad-dollar and connected U.S. macro drivers</p></div><div className="fx-pair-tile"><b>Broad USD</b><strong>{usdStrength?.score ?? '—'}</strong><small>{usdStrength ? `${usdStrength.coverage}% coverage` : 'No model'}</small></div></div>
        <div className="fx-preview"><span>20D momentum</span><b>{formatPercent(usdStrength?.indicators?.momentum20d)}</b><span>Real-yield impulse</span><b className={scoreTone(usdDrivers.realYield?.score)}>{usdDrivers.realYield?.score ?? '—'}</b><span>Dollar smile</span><b>{usdStrength?.dollarSmile ?? 'Unavailable'}</b></div>
        <div className="model-action"><span>{usdStrength?.version ?? 'No model output'}</span><button onClick={() => setActiveModel('FX')}>Open model →</button></div>
      </article>
    </section>

    <section className="workspace-pulse panel">
      <div className="panel-title"><div><p className="section-kicker">WORKSPACE PULSE · CALCULATED</p><h3>Headlines from every calculated workspace</h3></div><span className="data-pill">Live</span></div>
      <div className="btc-cycle-grid">
        <div className="btc-cycle-cell"><small>Screener momentum</small><b>{(() => { const leader = screenerLeader(data.screener?.rows); return leader ? `${leader.symbol} ${leader.mom20 > 0 ? '+' : ''}${leader.mom20}%` : '—'; })()}</b><span>{data.screener?.status === 'calculated' ? (() => { const leader = screenerLeader(data.screener?.rows); return `Top of ${data.screener.calculatedCount} names${leader?.sector ? ` · ${leader.sector}` : ''} by 20D momentum`; })() : 'Screener histories pending'}</span></div>
        <div className="btc-cycle-cell"><small>Crypto aggregate</small><b>{Number.isFinite(data.bitcoin?.cryptoGlobal?.mcapChange24hPct) ? `${data.bitcoin.cryptoGlobal.mcapChange24hPct > 0 ? '+' : ''}${data.bitcoin.cryptoGlobal.mcapChange24hPct.toFixed(2)}%` : '—'}</b><span>Total crypto market cap, 24 hours</span></div>
        <div className="btc-cycle-cell"><small>Fear &amp; Greed</small><b>{Number.isFinite(data.sentiment?.fearGreed?.score) ? data.sentiment.fearGreed.score : '—'}</b><span>{data.sentiment?.fearGreed?.rating ?? 'Sentiment feed pending'}</span></div>
        <div className={`btc-cycle-cell ${data.equityRisk?.spxBreadth?.divergence?.divergent ? 'cell-warning' : ''}`}><small>Equity breadth</small><b>{Number.isFinite(data.equityRisk?.spxBreadth?.pctAbove200) ? `${data.equityRisk.spxBreadth.pctAbove200}%` : '—'}</b><span>{data.equityRisk?.spxBreadth?.status === 'calculated' ? `${data.equityRisk.spxBreadth.read}${data.equityRisk.spxBreadth.divergence?.status === 'calculated' ? ` · ${data.equityRisk.spxBreadth.divergence.state}` : ''}` : 'Breadth histories pending'}</span></div>
        {(data.alerts?.alerts ?? []).length ? <div className="btc-cycle-cell"><small>Model alerts</small><b>{data.alerts.alerts.length} recent</b><span>{data.alerts.alerts[0]?.text ?? ''}</span></div> : null}
      </div>
    </section>

    <section className="macro-section-heading"><div><p className="section-kicker">{activeModel === 'Overview' ? 'MACRO OVERVIEW' : activeModel === 'Liquidity' ? 'NET US LIQUIDITY' : activeModel === 'Global' ? 'GLOBAL CENTRAL-BANK LIQUIDITY' : activeModel === 'Risk' ? 'CROSS-ASSET CONFIRMATION' : activeModel === 'Correlations' ? 'RELATIONSHIP INTELLIGENCE' : activeModel === 'Rates' ? 'RATES, INFLATION & GROWTH' : activeModel === 'Consensus' ? 'CROSS-MODEL READ' : 'USD MACRO ENGINE'}</p><h2>{activeModel === 'Overview' ? 'What every model says, and what is live right now' : activeModel === 'Liquidity' ? 'The calculated drivers behind the impulse' : activeModel === 'Global' ? 'World central-bank liquidity in dollars' : activeModel === 'Risk' ? 'What markets are pricing now' : activeModel === 'Correlations' ? 'Correlations through the current regime' : activeModel === 'Rates' ? 'What the curve is pricing, and what growth proxies say' : activeModel === 'Consensus' ? 'Where the models agree, where they do not, and what is live' : 'Where macro points for the dollar'} {activeModel === 'Correlations' && regimeCorrelations?.status !== 'calculated' && <PreviewBadge label="Contains previews" />}</h2></div>{activeModel === 'Liquidity' && <span className="data-pill">13W calculated window</span>}{activeModel === 'Global' && <span className="data-pill">13W calculated window</span>}{activeModel === 'Correlations' && <div className="window-buttons">{[['20D', '20 obs'], ['60D', '60 obs'], ['1Y', '252 obs']].map(([item, label]) => <button className={correlationWindow === item ? 'selected' : ''} key={item} onClick={() => setCorrelationWindow(item)}>{label}</button>)}</div>}{activeModel === 'FX' && <span className="data-pill">FRED driver stack</span>}</section>

    {activeModel === 'Overview' ? <section className="risk-detail-grid">
      <ConsensusPanel consensus={data.liquidity?.consensus} />
      <MacroAlertsPanel alerts={data.liquidity?.macroAlerts} />
      <ContradictionPanel consensus={data.liquidity?.consensus} />
    </section> : activeModel === 'Liquidity' ? <section className="liquidity-detail-grid">
      <article className="driver-panel panel"><div className="driver-panel-head"><span>Indicator</span><span>Impulse</span><span>13W change</span></div>{liquidityModel?.drivers?.length ? liquidityModel.drivers.map((driver) => { const tone = driver.impulse > 0.05 ? 'positive' : driver.impulse < -0.05 ? 'negative' : 'neutral'; return <div className="driver-row" key={driver.key}><span>{driver.name}</span><b className={tone}>{driver.impulse > 0.05 ? 'Supportive' : driver.impulse < -0.05 ? 'Restrictive' : 'Neutral'}</b><strong>{driver.changePercent >= 0 ? '+' : ''}{driver.changePercent.toFixed(2)}%</strong></div>; }) : <div className="calculation-empty">No calculated FRED drivers are available.</div>}<p className="model-footnote"><code>us-liquidity-v1</code> uses 55% Fed net liquidity, 25% US M2 growth, and 20% inverse dollar transmission. Inputs retain provider dates and units.</p></article>
      <article className={`driver-panel panel ${liquidityModel?.decomposition?.length ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">NET-LIQUIDITY DECOMPOSITION · CALCULATED</p><h3>Which leg moved the pool</h3></div><span className="data-pill">{liquidityModel?.decomposition?.length ? 'Δ = Fed − TGA − RRP' : 'Unavailable'}</span></div>{liquidityModel?.decomposition?.length ? <>{liquidityModel.decomposition.map((window) => <div key={window.windowDays}><div className="driver-panel-head"><span>{`${window.windowDays === 28 ? '4' : '13'}-week window`}</span><span>Contribution</span><span>{`${window.netChange >= 0 ? '+' : ''}$${(window.netChange / 1000).toFixed(1)}B net`}</span></div>{window.legs.map((leg) => <div className="driver-row" key={`${window.windowDays}-${leg.key}`}><span>{leg.name}{window.dominantLeg === leg.key ? ' · dominant' : ''}</span><b className={leg.contribution >= 0 ? 'positive' : 'negative'}>{leg.contribution >= 0 ? 'Adding' : 'Draining'}</b><strong>{`${leg.contribution >= 0 ? '+' : ''}$${(leg.contribution / 1000).toFixed(1)}B`}</strong></div>)}</div>)}</> : <div className="calculation-empty">Fed balance sheet, TGA, and reverse-repo histories are all required to decompose net liquidity.</div>}<p className="model-footnote">Net liquidity is the Fed balance sheet minus the Treasury General Account minus overnight reverse repos; each leg is differenced over the same window so the contributions sum to the net change. RRP drawdowns and TGA spend-downs release liquidity even while the balance sheet shrinks.</p></article>
      <article className={`regional-panel panel ${liquidityRunway?.status === 'calculated' ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">TIGHTENING RUNWAY · {liquidityRunway?.status?.toUpperCase() ?? 'UNAVAILABLE'}</p><h3>{liquidityRunway?.state ?? 'Awaiting Fed and reverse-repo histories'}</h3></div><span className={`data-pill ${Number.isFinite(liquidityRunway?.runwayMonths) && liquidityRunway.runwayMonths <= 6 ? 'pill-warning' : ''}`}>{Number.isFinite(liquidityRunway?.runwayMonths) ? `${liquidityRunway.runwayMonths} months left` : 'No drawdown'}</span></div><p className="regime-proximity">{liquidityRunway?.read ?? liquidityRunway?.reason}</p>{liquidityRunway?.status === 'calculated' ? <div className="signal-summary"><SignalCell label="Reverse repo" value={formatLiquidityValue(liquidityRunway.reverseRepoLevel)} /><SignalCell label="Drain / month" value={liquidityRunway.drainPerMonth > 0 ? formatLiquidityValue(liquidityRunway.drainPerMonth) : null} /><SignalCell label="Offset ratio" value={Number.isFinite(liquidityRunway.offsetRatio) ? `${liquidityRunway.offsetRatio}×` : null} /></div> : null}<p className="model-footnote">{liquidityRunway?.status === 'calculated' ? `${liquidityRunway.methodology} The Treasury general account is ${liquidityRunway.treasuryDirection ?? 'unavailable'} over the same window.` : liquidityRunway?.methodology ?? 'The runway publishes once the Fed balance sheet and reverse-repo histories both respond.'}</p></article>

      <LiquidityCalendarPanel calendar={data.liquidity?.liquidityCalendar} />
      <ReserveScarcityPanel scarcity={data.liquidity?.reserveScarcity} />
      <LiquidityPayoffPanel payoff={data.liquidity?.liquidityPayoff} />

      <article className="regional-panel panel"><div className="panel-title"><div><p className="section-kicker">GLOBAL EXTENSION</p><h3>World model calculated</h3></div><span className="data-pill">{globalLiquidity ? `${globalLiquidity.version}` : 'Not calculated'}</span></div>{globalLiquidity ? <div className="calculation-empty regional-empty">The Fed, ECB, BoJ, and PBoC legs are aggregated in USD. PBoC assets arrive via BIS with a publication lag; the Bank of England remains excluded because its series ended in 2014.</div> : <div className="calculation-empty regional-empty">ECB and BoJ histories must be ingested and normalized before a global score can be published.</div>}<button className="source-link" onClick={() => setActiveModel('Global')}>Open global model →</button></article>
    </section> : activeModel === 'Global' ? <section className="liquidity-detail-grid">
      <article className="driver-panel panel"><div className="panel-title"><div><p className="section-kicker">GLOBAL LIQUIDITY DRIVERS</p><h3>{globalLiquidity?.regime ?? 'Regime unavailable'} · {globalLiquidity ? formatLiquidityValue(globalLiquidity.globalLiquidityUsdMillions) : 'Unavailable'}</h3></div><span className="data-pill">{globalLiquidity ? `${globalLiquidity.confidence} confidence` : 'Unavailable'}</span></div><div className="driver-panel-head"><span>Indicator</span><span>Impulse</span><span>13W change</span></div>{globalLiquidity?.drivers?.length ? globalLiquidity.drivers.map((driver) => { const tone = driver.impulse > 0.05 ? 'positive' : driver.impulse < -0.05 ? 'negative' : 'neutral'; return <div className="driver-row" key={driver.key}><span>{driver.name}</span><b className={tone}>{driver.impulse > 0.05 ? 'Supportive' : driver.impulse < -0.05 ? 'Restrictive' : 'Neutral'}</b><strong>{Number.isFinite(driver.changePercent) ? `${driver.changePercent >= 0 ? '+' : ''}${driver.changePercent.toFixed(2)}%` : '—'}</strong></div>; }) : <div className="calculation-empty">Fed, ECB, and BoJ balance sheets plus both FX conversion rates are required.</div>}{data.liquidity?.stablecoins?.status === 'calculated' && <div className="driver-row"><span>Stablecoin supply · {data.liquidity.stablecoins.state}</span><b className={data.liquidity.stablecoins.change30dPct >= 0.5 ? 'positive' : data.liquidity.stablecoins.change30dPct <= -0.5 ? 'negative' : 'neutral'}>{data.liquidity.stablecoins.change30dPct >= 0 ? 'Supportive' : 'Restrictive'}</b><strong>{`${data.liquidity.stablecoins.change30dPct >= 0 ? '+' : ''}${data.liquidity.stablecoins.change30dPct.toFixed(2)}% 30D`}</strong></div>}<p className="model-footnote"><code>global-liquidity-v1</code> aggregates Fed, ECB, BoJ, and PBoC balance sheets converted to USD at matching-date rates, weighted 30% global impulse, 20% US M2 growth, 15% ECB+BoJ impulse, 15% PBoC impulse, 20% inverse broad dollar.</p></article>
      <article className="regional-panel panel"><div className="panel-title"><div><p className="section-kicker">CENTRAL-BANK BREAKDOWN</p><h3>Balance-sheet contributions</h3></div><span className="data-pill">{globalLiquidity ? `as of ${globalLiquidity.asOf}` : 'Unavailable'}</span></div>{globalLiquidity?.centralBanks?.length ? globalLiquidity.centralBanks.map((leg) => <div className="driver-row" key={leg.key}><span>{leg.name}<small>{leg.asOf}{leg.source ? ` · ${leg.source}` : ''}{Number.isFinite(leg.sharePercent) ? ` · ${leg.sharePercent}% of pool` : ''}</small></span><b className={(leg.change91d ?? 0) >= 0 ? 'positive' : 'negative'}>{formatLiquidityValue(leg.valueUsdMillions)}</b><strong>{Number.isFinite(leg.change365d) ? `${leg.change365d >= 0 ? '+' : ''}${leg.change365d.toFixed(2)}% YoY` : '—'}</strong></div>) : <div className="calculation-empty">No central-bank legs are available.</div>}<p className="model-footnote">{globalLiquidity?.cycle?.read ?? 'The cycle position publishes once the pooled history can rank its own growth rate.'} PBoC assets arrive via BIS WS_CBTA with a structural publication lag; BoE balance-sheet data ended in 2014 and broad-money feeds on FRED are frozen, so both remain documented exclusions.</p></article>
    </section> : activeModel === 'Risk' ? <section className="risk-detail-grid">
      <article className="risk-inputs panel"><div className="panel-title"><div><p className="section-kicker">CALCULATED COMPONENTS</p><h3>Independent macro sleeves</h3></div><span className="data-pill">{macroRegime ? `${macroRegime.coverage}% coverage` : 'Unavailable'}</span></div><div className="risk-input-grid">{(macroRegime?.drivers ?? []).map((driver) => <div className="risk-input" key={driver.key}><span className={scoreTone(driver.score)}></span><b>{driver.name}</b><strong>{driver.score ?? '—'}</strong><small>{driver.score === null ? 'Missing' : driver.score > 60 ? 'Supportive' : driver.score < 40 ? 'Restrictive' : 'Balanced'}</small></div>)}</div>{!macroRegime && <div className="calculation-empty">At least two independent macro histories are required.</div>}<p className="model-footnote"><code>macro-regime-v1</code> uses US liquidity, global liquidity, financial conditions, credit, volatility, and inverse dollar pressure. Missing: {macroRegime?.missing?.join(', ') || 'none'}.</p></article>
      <article className="regime-panel panel"><div className="panel-title"><div><p className="section-kicker">DYNAMIC REGIME SETTINGS</p><h3>{macroRegime?.regime ?? 'Regime unavailable'}</h3></div><span className={`data-pill ${macroRegime?.proximity?.borderline ? 'pill-warning' : ''}`}>{macroRegime?.proximity?.borderline ? 'Borderline' : macroRegime?.status ?? 'unavailable'}</span></div>{macroRegime?.vintage?.oldestInput ? <p className="regime-proximity">{`As of ${macroRegime.asOf} — the date of the oldest input still binding on the score (${macroRegime.vintage.oldestInput.name})${macroRegime.vintage.spreadDays ? `, ${macroRegime.vintage.spreadDays} days behind the freshest (${macroRegime.vintage.freshestInput.name})` : ''}.${macroRegime.partialDrivers?.length ? ` ${macroRegime.partialDrivers.join(' and ')} ${macroRegime.partialDrivers.length === 1 ? 'is scoring' : 'are scoring'} on level alone — the 91-day change is unavailable.` : ''}`}</p> : null}{macroRegime?.proximity ? <p className="regime-proximity">{macroRegime.score}/100 · {macroRegime.proximity.higher ? `${macroRegime.proximity.higher.distance} up to ${macroRegime.proximity.higher.regime}` : 'top of the scale'} · {macroRegime.proximity.lower ? `${macroRegime.proximity.lower.distance} down to ${macroRegime.proximity.lower.regime}` : 'bottom of the scale'}.{macroRegime.proximity.borderline ? ' The call is one step from flipping.' : ''}</p> : macroRegime?.panicConfirmed ? <p className="regime-proximity">Panic confirmation overrides the score bands, so distance to a neighbouring regime is not published while it holds.</p> : null}{macroRegime?.settings ? <div className="regime-settings"><div><span>Risk budget</span><b>{macroRegime.settings.riskBudget}</b></div><div><span>Alert threshold</span><b>{macroRegime.settings.alertThreshold}/100</b></div><div><span>Holding period</span><b>{macroRegime.settings.holdingPeriod}</b></div><div><span>Factor emphasis</span><b>{macroRegime.settings.emphasis}</b></div></div> : <div className="calculation-empty">No dynamic settings are published without a regime.</div>}<p className="model-footnote">Stress requires simultaneous VIX, high-yield spread, and financial-condition confirmation. No panic probability is fabricated.</p></article>
      <RegimeHistoryPanel history={data.liquidity?.regimeHistory} />
    </section> : activeModel === 'Rates' ? <section className="risk-detail-grid">
      <YieldCurvePanel curve={data.liquidity?.yieldCurve} />
      <RatePathPanel ratePath={data.liquidity?.ratePath} />
      <NominalDecompositionPanel decomposition={data.liquidity?.nominalDecomposition} />
      <TermPremiumPanel premium={data.liquidity?.termPremium} />
      <InflationPanel inflation={data.liquidity?.inflation} />
      <RateDivergencePanel divergence={data.liquidity?.rateDivergence} />
      <GrowthNowcastPanel nowcast={data.liquidity?.growthNowcast} />
      <DataSurprisePanel surprise={data.liquidity?.dataSurprise} />
    </section> : activeModel === 'Consensus' ? <section className="risk-detail-grid">
      <ConsensusPanel consensus={data.liquidity?.consensus} />
      <ContradictionPanel consensus={data.liquidity?.consensus} />
      <MacroAlertsPanel alerts={data.liquidity?.macroAlerts} />
      <ModelCorrelationPanel matrix={data.liquidity?.modelCorrelation} />
      <WeightOverlapPanel overlap={data.liquidity?.weightOverlap} />
    </section> : activeModel === 'Correlations' ? <section className="correlation-detail-grid">
      <article className={`correlation-map-panel panel ${regimeCorrelations?.status === 'calculated' ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">ROLLING CORRELATION · {correlationWindow === '1Y' ? '252' : correlationWindow.replace('D', '')} OBSERVATIONS</p><h3>Cross-market relationship map</h3></div><span className="data-pill">{regimeCorrelations?.status === 'calculated' ? `${regimeCorrelations.calculatedCount} of ${rcPairs.length} calculated` : 'Awaiting inputs'}</span></div><div className="correlation-legend"><span><i className="correlation-negative"></i>Inverse</span><span><i className="correlation-neutral"></i>Mixed</span><span><i className="correlation-positive"></i>Positive</span><small>{`r = Pearson correlation of changes between the dates each pair shares`}</small></div><div className="correlation-rows">{rcPairs.map((pair) => { const value = rcValue(pair); const tone = pair.status !== 'calculated' || !Number.isFinite(value) ? 'correlation-neutral' : correlationTone(value); return <div className="correlation-row" key={pair.key}><b>{pair.left}</b><div className="correlation-link"><i className={tone}></i><span></span><i className={tone}></i></div><b>{pair.right}</b><strong className={tone}>{Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)}` : '—'}</strong><small title={pair.windowLabels?.[correlationWindow] ?? undefined}>{pair.status === 'calculated' ? `${pair.observations} obs${pair.daily === false ? ` · ${pair.cadenceDays}d bars` : ''}` : 'Unavailable'}</small><em className={pair.leadLag?.leader ? 'lead-flag' : 'lead-flag lead-flat'} title={pair.leadLag ? `Peak correlation ${pair.leadLag.corrAtBest.toFixed(2)} at a lag of ${pair.leadLag.bestLagBars} observations versus ${Number.isFinite(pair.leadLag.synchronousCorr) ? pair.leadLag.synchronousCorr.toFixed(2) : '—'} synchronous` : 'Lead-lag needs at least 40 aligned observations'}>{pair.leadLag ? pair.leadLag.leader ? `${pair.leadLag.leader} leads ${pair.leadLag.leadDays}d` : 'Moves together' : 'Lead pending'}</em></div>; })}</div><p className="model-footnote"><code>regime-correlation-v1</code> aligns stored FRED and market histories on the dates each pair shares and correlates the changes between them over windows of 20, 60 and 252 observations. Those are sessions only where both legs publish daily: against a weekly series such as NFCI the same count of observations spans seven times as many days, so each row carries its own bar size and every window names its true span on hover. Pairs without both inputs stay explicitly unavailable. {regimeCorrelations?.leadLagMethodology}</p></article>
      <article className={`correlation-insight-panel panel ${regimeCorrelations?.status === 'calculated' ? '' : 'preview-section'}`}>{regimeCorrelations?.status === 'calculated' && strongestPair ? <>
        <p className="section-kicker">REGIME READ · CALCULATED</p>
        <h3>Strongest link: {strongestPair.left} ↔ {strongestPair.right} ({rcValue(strongestPair) > 0 ? '+' : ''}{rcValue(strongestPair).toFixed(2)}).</h3>
        <p>Weakest calculated link is {weakestPair.left} ↔ {weakestPair.right} at {rcValue(weakestPair) > 0 ? '+' : ''}{rcValue(weakestPair).toFixed(2)}. Correlations are recomputed from stored histories on every refresh; no relationship is assumed.</p>
        <div className="stability-score"><span>Calculated coverage</span><div><i><b style={{ width: `${regimeCorrelations.coverage}%` }}></b></i><strong>{regimeCorrelations.coverage}%</strong></div></div>
        <div className="correlation-watch"><b>Watch for a break</b><span>{Number.isFinite(rcValue(rcByKey.creditEquities)) ? `Credit/equity at ${rcValue(rcByKey.creditEquities).toFixed(2)} over ${correlationWindow}; stress builds as it moves toward zero or turns positive.` : 'Credit/equity link requires spread history.'}</span></div>
        <div className="correlation-watch"><b>What moves first</b><span>{leadSignals.length ? `${leadSignal.read} (r ${leadSignal.corrAtBest > 0 ? '+' : ''}${leadSignal.corrAtBest.toFixed(2)} at that lag versus ${Number.isFinite(leadSignal.synchronousCorr) ? `${leadSignal.synchronousCorr > 0 ? '+' : ''}${leadSignal.synchronousCorr.toFixed(2)}` : '—'} synchronous). ${leadSignals.length > 1 ? `${leadSignals.length - 1} other pair${leadSignals.length === 2 ? ' also shows' : 's also show'} a decisive lead.` : 'Every other calculated pair moves together.'}` : 'No pair clears the lead threshold right now: each calculated relationship peaks at zero lag, so none of them front-runs the others.'}</span></div>
      </> : <>
        <p className="section-kicker">REGIME READ</p>
        <h3>Awaiting synchronized histories.</h3>
        <p>The relationship map publishes only when both legs of each pair have stored, fresh history. Missing: {regimeCorrelations?.missingInputs?.join(', ') || 'all pairs pending input configuration'}.</p>
      </>}</article>
      <article className={`correlation-notes panel ${regimeCorrelations?.status === 'calculated' ? '' : 'preview-section'}`}><p className="section-kicker">HOW TO READ THIS</p><div>{rcPairs.slice(0, 3).map((pair) => <p key={pair.key}><b>{pair.left} / {pair.right}</b><span>{pair.note}</span></p>)}</div><button onClick={() => setActiveModel('Liquidity')}>Open liquidity drivers →</button></article>
      <article className={`correlation-map-panel panel ${(regimeCorrelations?.liquidityTransmission ?? []).some((row) => row.status === 'calculated') ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">LIQUIDITY TRANSMISSION · CALCULATED</p><h3>Does net liquidity lead risk assets?</h3></div><span className="data-pill">4-week changes · ±8-week lags</span></div><div className="correlation-rows">{(regimeCorrelations?.liquidityTransmission ?? []).map((row) => <div className="correlation-row" key={row.asset}><b>Net liquidity</b><div className="correlation-link"><i className={row.status !== 'calculated' ? 'correlation-neutral' : correlationTone(row.corrAtBest)}></i><span></span><i className={row.status !== 'calculated' ? 'correlation-neutral' : correlationTone(row.corrAtBest)}></i></div><b>{row.asset}</b><strong className={row.status !== 'calculated' ? 'correlation-neutral' : correlationTone(row.corrAtBest)}>{row.status === 'calculated' ? `${row.corrAtBest > 0 ? '+' : ''}${row.corrAtBest.toFixed(2)}` : '—'}</strong><small>{row.status === 'calculated' ? `${row.observations} obs` : 'Unavailable'}</small><em className="lead-flag">{row.status === 'calculated' ? `${row.read}` : 'Awaiting histories'}</em></div>)}{!(regimeCorrelations?.liquidityTransmission ?? []).length && <div className="calculation-empty">Net-liquidity history and asset closes are required before transmission can publish.</div>}</div><p className="model-footnote">{regimeCorrelations?.liquidityTransmissionMethodology ?? 'Four-week net-liquidity changes are cross-correlated against asset changes at weekly lags once stored histories align.'}</p></article>
    </section> : <section className="fx-detail-grid">
      <article className="fx-predictor-panel panel"><div className="panel-title"><div><p className="section-kicker">USD STRENGTH ENGINE · {usdStrength?.status?.toUpperCase() ?? 'UNAVAILABLE'}</p><h3>Connected FRED driver stack</h3></div><span className="data-pill">{usdStrength ? `${usdStrength.score}/100` : 'Unavailable'}</span></div>{(usdStrength?.drivers ?? []).map((driver) => <div className="fx-predictor-row" key={driver.key}><div><b>{driver.name}</b><small>{driver.source}{Number.isFinite(driver.change) ? ` · change ${driver.change >= 0 ? '+' : ''}${driver.change.toFixed(2)}` : ''}</small></div><span className={scoreTone(driver.score)}>{driver.score ?? '—'}</span></div>)}{!usdStrength && <div className="calculation-empty">Broad-dollar history is required before this model can publish.</div>}<div className="dollar-smile"><b>Dollar Smile <span>{usdStrength?.dollarSmile ?? 'Unavailable'}</span></b><p>{usdStrength?.proxy ?? 'FRED broad-dollar and macro inputs are not available.'}</p><div><span>Global stress</span><i></i><span>Real-yield support</span></div></div></article>
      <article className={`fx-scenarios-panel panel ${dollarScenarios?.status === 'unavailable' ? 'preview-section' : ''}`}><p className="section-kicker">USD SCENARIO MAP · {dollarScenarios?.status?.toUpperCase() ?? 'UNAVAILABLE'}</p><h3>{dollarScenarios?.leading ? `${dollarScenarios.leading.name} leads the dollar` : dollarScenarios?.status === 'unavailable' ? 'Three paths, awaiting inputs.' : 'No path dominates right now.'}</h3>{(dollarScenarios?.scenarios ?? [{ key: 'globalStress', name: 'Global stress', outcome: 'USD, CHF, JPY bid' }, { key: 'usOutperformance', name: 'Strong U.S. growth', outcome: 'USD carry strengthens' }, { key: 'weakGlobalGrowth', name: 'Weak global growth', outcome: 'USD defensive premium' }]).map((scenario) => <div className={`scenario-row ${dollarScenarios?.leading?.key === scenario.key ? 'scenario-leading' : ''}`} key={scenario.key} title={scenario.legs ? scenario.legs.map((leg) => `${leg.name}: ${leg.score ?? 'unavailable'}`).join('\n') : undefined}><span>{scenario.name}<small>{scenario.outcome}</small></span><i><b style={{ width: `${scenario.score ?? 0}%` }}></b></i><strong>{Number.isFinite(scenario.score) ? scenario.score : '—'}</strong></div>)}<p>{dollarScenarios?.read ? `${dollarScenarios.read}. ${dollarScenarios.methodology}` : dollarScenarios?.reason ?? 'Each path scores its own evidence once FRED volatility, credit, conditions, and yield histories are available.'}</p></article>
    </section>}

    <section className="macro-bottom-grid">
      {data.alerts?.status === 'calculated' && data.alerts.alerts?.length ? <article className="change-panel panel"><p className="section-kicker">MODEL ALERTS · PERSISTED</p><h3>Detected vitals shifts across ingestion runs</h3><div className="narrative-list">{data.alerts.alerts.slice(0, 8).map((alert) => <p key={`${alert.modelId}-${alert.key}-${alert.detectedAt}`} className="change-copy">{alert.text}<span className="alert-meta">{MODEL_LABELS[alert.modelId] ?? alert.modelId} · {alertAge(alert.detectedAt)}</span></p>)}</div><div className="change-tags"><span>{data.alerts.alerts.length} stored</span><span>Ingestion-time detection</span></div></article> : null}
      <article className={`change-panel panel ${narrative?.status === 'updated' || narrative?.status === 'stable' ? '' : 'preview-section'}`}><p className="section-kicker">NARRATIVE · {narrative?.status === 'updated' ? 'MODEL CHANGES DETECTED' : narrative?.status === 'stable' ? 'MODEL CHANGES' : 'MODEL PREVIEW'}</p>{narrative?.entries?.length ? <div className="narrative-list">{narrative.entries.map((entry) => <p key={entry.key} className="change-copy">{entry.text}</p>)}</div> : <><h3>Automated change detection pending.</h3><p className="change-copy">{narrative?.status === 'insufficient-history' ? 'At least two persisted ingestion runs are required before model changes can be narrated.' : 'This panel is generated from persisted model changes once ingestion history exists.'}</p></>}<div className="change-tags"><span>Versioned changes</span><span>Source lineage</span><span>Release-aware</span></div></article>
      <article className={`sensitivity-panel panel ${regimeCorrelations?.status === 'calculated' ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">ASSET SENSITIVITY · CALCULATED</p><h3>Current macro exposures</h3></div><button onClick={() => setActiveModel('Correlations')}>Details →</button></div><div className="sensitivity-list">{sensitivityRows.map((row) => <div key={row.asset}><b>{row.asset}</b><span>{row.driver} <i>{row.strength}</i></span><small>{Number.isFinite(row.value) ? `${row.value > 0 ? '+' : ''}${row.value.toFixed(2)}` : '—'}</small></div>)}</div><p className="model-footnote">Sensitivities are the {correlationWindow} correlations from <code>regime-correlation-v1</code>; strength labels derive from |r| thresholds of 0.25 and 0.50.</p></article>
      <article className="sources-panel panel"><p className="section-kicker">DATA PROVENANCE</p><h3>Connected and target sources.</h3><p>FRED is connected, including ECB and BoJ balance sheets with H.10 FX conversion, and PBoC total assets arrive via BIS WS_CBTA on DBnomics. BoE, IMF broad money, and institutional market feeds remain planned inputs.</p><button>Explore sources and lags →</button></article>
    </section>
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
    {liquidityChartOpen && <LiquidityChartDialog history={liquidityModel?.history ?? []} title="Calculated net US liquidity" description="Move across the chart to inspect a date. Click or tap to pin the observation for comparison." onClose={() => setLiquidityChartOpen(false)} />}
    {globalChartOpen && <LiquidityChartDialog history={globalLiquidity?.history ?? []} title="Calculated global central-bank liquidity" description="US net liquidity plus ECB and BoJ balance sheets in USD. Move across the chart to inspect a date; click to pin." label="global central-bank liquidity" onClose={() => setGlobalChartOpen(false)} />}
  </div>;
}

const MODEL_LABELS = {
  'market-heatmap': 'Heatmap',
  'metals-workspace': 'Metals',
  'fx-workspace': 'FX',
  'sentiment-snapshot': 'Sentiment',
  'bitcoin-cycle': 'Bitcoin cycle',
  'equity-risk': 'Equity risk',
  'liquidity-states': 'Liquidity states',
  'dollar-transmission': 'Dollar transmission',
  'screener-v1': 'Screener',
};

function alertAge(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const SCREENER_PRESETS = {
  'momentum-leaders': { label: 'Momentum leaders', filter: () => true, sort: (a, b) => (b.mom20 ?? -999) - (a.mom20 ?? -999) },
  'market-beating': { label: 'Market-beating', filter: (row) => Number.isFinite(row.vsIndexMom20) && row.vsIndexMom20 > 0, sort: (a, b) => (b.vsIndexMom20 ?? -999) - (a.vsIndexMom20 ?? -999) },
  'uptrend-pullbacks': { label: 'Uptrend pullbacks', filter: (row) => row.vsSma200 > 0 && row.mom20 < 0, sort: (a, b) => (b.vsSma200 ?? -999) - (a.vsSma200 ?? -999) },
  'low-vol-uptrend': { label: 'Low-vol uptrends', filter: (row) => row.vsSma200 > 0 && row.above50 === true, sort: (a, b) => (b.score ?? -1) - (a.score ?? -1) },
  breakouts: { label: '200D breakouts', filter: (row) => row.breakout === true, sort: (a, b) => (b.mom20 ?? -999) - (a.mom20 ?? -999) },
  oversold: { label: 'Oversold', filter: (row) => row.mom20 <= -8, sort: (a, b) => (a.mom20 ?? 999) - (b.mom20 ?? 999) },
  'near-highs': { label: 'Near 52W highs', filter: (row) => Number.isFinite(row.pctFrom52wHigh) && row.pctFrom52wHigh >= -5, sort: (a, b) => (b.pctFrom52wHigh ?? -999) - (a.pctFrom52wHigh ?? -999) },
  'quality-trends': { label: 'Quality trends', filter: (row) => Number.isFinite(row.trendQuality) && row.trendQuality > 0 && row.trendR2 >= 0.5, sort: (a, b) => (b.trendQuality ?? -9999) - (a.trendQuality ?? -9999) },
  'broken-trends': { label: 'Broken trends', filter: (row) => Number.isFinite(row.trendQuality) && row.trendQuality < 0 && row.trendR2 >= 0.5, sort: (a, b) => (a.trendQuality ?? 9999) - (b.trendQuality ?? 9999) },
};

function ScreenerDashboard({ data }) {
  const [preset, setPreset] = React.useState('momentum-leaders');
  const [search, setSearch] = React.useState('');
  const [sectorFilter, setSectorFilter] = React.useState('All');
  const [sort, setSort] = React.useState(null);
  const screener = data.screener;
  const rows = screener?.rows ?? [];
  const definition = SCREENER_PRESETS[preset];
  const sectors = ['All', ...(screener?.sectorLeadership ?? []).map((item) => item.sector)];
  const matched = sortRows(rows
    .filter(definition.filter)
    .filter((row) => sectorFilter === 'All' || row.sector === sectorFilter)
    .filter((row) => !search || row.symbol.toLowerCase().includes(search.trim().toLowerCase())), sort, definition.sort);
  const filtered = matched.slice(0, 40);
  const selectPreset = (key) => {
    setPreset(key);
    setSort(null);
  };

  const exportCsv = () => {
    const header = 'Symbol,Sector,SectorRank,SectorSize,Last,Mom20,Mom60,VsIdx20,VsIdx60,VsSma200,Rsi14,Vol20,PctFrom52wHigh,TrendSlopePct,TrendR2,TrendQuality,QualityRank,Score';
    const lines = matched.map((row) => [row.symbol, row.sector ?? '', row.sectorRank ?? '', row.sectorCount ?? '', row.last ?? '', row.mom20 ?? '', row.mom60 ?? '', row.vsIndexMom20 ?? '', row.vsIndexMom60 ?? '', row.vsSma200 ?? '', Number.isFinite(row.rsi14) ? row.rsi14.toFixed(1) : '', row.vol20 ?? '', row.pctFrom52wHigh ?? '', row.trendSlopePct ?? '', row.trendR2 ?? '', row.trendQuality ?? '', row.qualityRank ?? '', row.score ?? ''].join(','));
    const blob = new Blob([[header].concat(lines).join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `tradegate-screener-${preset}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return <div className="screener-dashboard">
    <section className="macro-intro">
      <div><p className="eyebrow">EQUITY SCREENING SYSTEM</p><h1>Rank the whole index, not a watchlist.</h1><p className="intro">Cross-sectional momentum, trend quality, volatility, and RSI for every S&P 500 constituent, calculated from provider closes.</p></div>
      <div className="model-tabs"><button className="active">Calculated universe</button></div>
    </section>
    <DataDisclosure data={data} message={`Every metric is calculated from Yahoo batch spark one-year daily closes over the Wikipedia S&P 500 list. ${screener?.calculatedCount ?? 0} of ${screener?.universeSize ?? 0} constituents returned usable history.`} />
    {screener?.breadth && Number.isFinite(screener.breadth.above50Pct) ? <p className="watchlist-summary">{screener.breadth.near52wHighCount} of {screener.breadth.calculated} names within 5% of their 52-week high ({screener.breadth.near52wHighPct}%) · {screener.breadth.above50Pct}% above their 50-day average{Number.isFinite(screener.breadth.persistentTrendPct) ? ` · ${screener.breadth.persistentTrendCount} of ${screener.breadth.qualityCovered} riding a persistent 90-session uptrend (${screener.breadth.persistentTrendPct}%)` : ''} · momentum expressed net of SPY over the same windows</p> : null}
    <section className="macro-section-heading"><div><p className="section-kicker">SCREENS · CALCULATED</p><h2>{definition.label}</h2></div><span className="data-pill">{filtered.length ? `Top ${filtered.length} of ${rows.length}${sort ? ` · by ${SCREENER_COLUMNS.find((column) => column.key === sort.key)?.label ?? sort.key}` : ''}` : 'No matches'}</span></section>
    <section className="screener-controls-row">
      <div className="window-buttons">{sectors.map((sector) => <button className={sectorFilter === sector ? 'selected' : ''} key={sector} onClick={() => setSectorFilter(sector)}>{sector === 'All' ? 'All sectors' : sector}</button>)}</div>
    </section>
    <section className="screener-controls-row">
      <div className="window-buttons">{Object.entries(SCREENER_PRESETS).map(([key, item]) => <button className={preset === key ? 'selected' : ''} key={key} onClick={() => selectPreset(key)}>{item.label}</button>)}</div>
      <input className="screener-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter by symbol…" aria-label="Filter by symbol" />
      {matched.length ? <button className="watch-button" onClick={exportCsv}>Export CSV ({matched.length})</button> : null}
    </section>
    <section className={`screener-panel panel ${screener?.status === 'calculated' ? '' : 'preview-section'}`}>
      {screener?.status === 'calculated' ? <div className="screener-wrap">
        <div className="screener-head" role="row">{SCREENER_COLUMNS.map((column) => <button className={`screener-sort ${sort?.key === column.key ? 'sorted' : ''}`} role="columnheader" aria-sort={ariaSortFor(sort, column.key)} key={column.key} onClick={() => setSort((current) => nextSortState(current, column.key))} title={`Sort by ${column.label}`}>{column.label}<i>{sort?.key === column.key ? sort.direction === 'asc' ? '↑' : '↓' : ''}</i></button>)}</div>
        {filtered.map((row) => <div className="screener-row" key={row.symbol}>
          <b>{row.symbol}</b>
          <span>{formatUsd(row.last)}</span>
          <span className={row.mom20 >= 0 ? 'positive' : 'negative'}>{Number.isFinite(row.mom20) ? formatPercent(row.mom20) : '—'}</span>
          <span className={row.mom60 >= 0 ? 'positive' : 'negative'}>{Number.isFinite(row.mom60) ? formatPercent(row.mom60) : '—'}</span>
          <span className={row.vsSma200 >= 0 ? 'positive' : 'negative'}>{Number.isFinite(row.vsSma200) ? `${row.vsSma200 > 0 ? '+' : ''}${row.vsSma200}%` : '—'}</span>
          <span>{Number.isFinite(row.rsi14) ? row.rsi14.toFixed(0) : '—'}</span>
          <span>{Number.isFinite(row.vol20) ? `${row.vol20}%` : '—'}</span>
          <span className={Number.isFinite(row.trendQuality) ? (row.trendQuality >= 0 ? 'positive' : 'negative') : ''} title={Number.isFinite(row.trendQuality) ? `90-session log-price fit: ${row.trendSlopePct > 0 ? '+' : ''}${row.trendSlopePct}% annualized slope × R² ${row.trendR2}` : 'Needs 90 sessions of closes'}>{Number.isFinite(row.trendQuality) ? `${row.trendQuality > 0 ? '+' : ''}${row.trendQuality}%` : '—'}</span>
          <b>{row.score ?? '—'}</b>
        </div>)}
        {!filtered.length && <div className="calculation-empty">No constituents match this screen right now.</div>}
        <p className="model-footnote">{screener.methodology}</p>
      </div> : <div className="calculation-empty">{screener?.reason ?? 'Constituent histories are required before the screener can publish.'}</div>}
    </section>
    {screener?.status === 'calculated' && screener.sectorLeadership?.length ? <>
      <section className="macro-section-heading"><div><p className="section-kicker">SECTOR LEADERSHIP · CALCULATED</p><h2>Where the momentum concentrates</h2></div><span className="data-pill">{screener.sectorLeadership.length} GICS sectors</span></section>
      <section className="screener-panel panel">
        <div className="sector-leadership-head"><span>Sector</span><span>Names</span><span>20D advancers</span><span>Avg momentum</span><span>Leader</span></div>
        {screener.sectorLeadership.map((sector) => <div className="sector-leadership-row" key={sector.sector}>
          <b>{sector.sector}</b>
          <span>{sector.constituents}</span>
          <span className={(sector.advancersPct ?? 0) >= 50 ? 'positive' : 'negative'}>{Number.isFinite(sector.advancersPct) ? `${sector.advancersPct}%` : '—'}</span>
          <strong className={(sector.avgMomentum20d ?? 0) >= 0 ? 'positive' : 'negative'}>{Number.isFinite(sector.avgMomentum20d) ? `${sector.avgMomentum20d > 0 ? '+' : ''}${sector.avgMomentum20d}%` : '—'}</strong>
          <span>{sector.leader ? `${sector.leader.symbol} ${sector.leader.mom20 > 0 ? '+' : ''}${sector.leader.mom20}%` : '—'}</span>
        </div>)}
      </section>
    </> : null}
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
  </div>;
}

function WatchlistRow({ symbol, onRemove, onSnapshot }) {
  const history = useMarketHistory(symbol, '3M');
  const technical = useTechnicalAnalytics(symbol);
  const points = history.data?.points ?? [];
  const values = normalizeSparkline(points.map((point) => point.value));
  const first = points[0]?.value;
  const last = points.at(-1)?.value;
  const changePct = Number.isFinite(first) && Number.isFinite(last) && first > 0 ? ((last / first) - 1) * 100 : null;
  const model = technical.data?.model;
  const fromHigh = model?.indicators?.pctFrom52wHigh;
  const snapshotValue = model ? { score: model.score, regime: model.regime, last: Number.isFinite(last) ? last : null, changePct, pctFrom52wHigh: Number.isFinite(fromHigh) ? fromHigh : null } : null;

  React.useEffect(() => {
    onSnapshot(symbol, snapshotValue);
    return () => onSnapshot(symbol, null);
  }, [symbol, snapshotValue?.score, snapshotValue?.regime, snapshotValue?.last, snapshotValue?.changePct, snapshotValue?.pctFrom52wHigh]);

  return <div className="watchlist-row">
    <b>{symbol}</b>
    {values.length > 1 ? <Sparkline color={changePct >= 0 ? '#75c966' : '#d98a72'} values={values} /> : <div className="model-chart-empty">No history</div>}
    <span>{formatUsd(last)}</span>
    <span className={changePct >= 0 ? 'positive' : 'negative'}>{Number.isFinite(changePct) ? formatPercent(changePct) : '—'}</span>
    <small>{model ? `Score ${model.score} · ${model.regime}${Number.isFinite(fromHigh) ? ` · ${fromHigh > 0 ? '+' : ''}${fromHigh}% vs 52W high` : ''}` : history.status === 'loading' ? 'Calculating…' : 'Score unavailable'}</small>
    <button onClick={() => onRemove(symbol)} aria-label={`Remove ${symbol}`}>×</button>
  </div>;
}

const DEFAULT_WATCHLISTS = { Core: ['NVDA', 'AAPL', 'GLD', 'BTC'] };

function IntradayRotationPanel({ fallback }) {
  const [range, setRange] = React.useState('5d');
  const [payload, setPayload] = React.useState(fallback ?? null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/analytics/intraday?range=${range}`).then((response) => response.json()).then((next) => { if (active) setPayload(next); }).catch(() => {}).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [range]);

  const calculated = payload?.status === 'calculated';
  const pairs = payload?.pairs ?? [];
  return <article className={`crypto-tailwind-panel panel ${calculated ? '' : 'preview-section'}`}>
    <div className="panel-title">
      <div>
        <p className="section-kicker">INTRADAY ROTATION TIMING · CALCULATED</p>
        <h3>{loading && !calculated ? 'Aligning histories…' : calculated ? `${payload.bars} aligned ${payload.intervalMinutes}m bars · ${payload.windowDays}d window` : 'Awaiting intraday histories'}</h3>
      </div>
      <div className="panel-title-side"><span className="data-pill">{payload?.version ?? 'Unavailable'}</span><div className="window-buttons">{['5d', '1d'].map((option) => <button key={option} className={range === option ? 'selected' : ''} onClick={() => setRange(option)}>{option.toUpperCase()}</button>)}</div></div>
    </div>
    <div className="btc-cycle-grid">
      {pairs.map((pair) => <div className="btc-cycle-cell" key={`${payload?.range}-${pair.pair}`}><small>{pair.pair}</small><b>{pair.read}</b><span>{`ρ ${pair.corrAtBest.toFixed(2)}${pair.synchronousCorr !== null && pair.bestLagBars !== 0 ? ` (sync ${pair.synchronousCorr.toFixed(2)})` : ''} · ${pair.observations} bars`}</span></div>)}
      {!pairs.length && <div className="btc-cycle-cell"><small>Lead/lag</small><b>—</b><span>Thirty-minute closes for BTC, ETH, and SOL are required.</span></div>}
    </div>
    <p className="model-footnote">{payload?.methodology ?? 'Lead/lag publishes once 30-minute spark histories align across the three assets.'}</p>
  </article>;
}

function WatchlistsDashboard({ data }) {
  const [lists, setLists] = React.useState(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem('tradegate-watchlists'));
      return stored && typeof stored === 'object' && Object.keys(stored).length ? stored : DEFAULT_WATCHLISTS;
    } catch {
      return DEFAULT_WATCHLISTS;
    }
  });
  const [activeList, setActiveList] = React.useState(() => Object.keys(DEFAULT_WATCHLISTS)[0]);
  const [draftSymbol, setDraftSymbol] = React.useState('');
  const [addError, setAddError] = React.useState(null);
  const [syncState, setSyncState] = React.useState('idle');
  const serverSyncedRef = React.useRef(false);
  const syncTimerRef = React.useRef(null);

  React.useEffect(() => {
    window.localStorage.setItem('tradegate-watchlists', JSON.stringify(lists));
    if (!serverSyncedRef.current) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      setSyncState('syncing');
      fetch('/api/watchlists', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(normalizeWatchlists(lists)) })
        .then((response) => response.json())
        .then((payload) => setSyncState(payload?.saved ? 'synced' : 'local'))
        .catch(() => setSyncState('failed'));
    }, 1500);
    return () => clearTimeout(syncTimerRef.current);
  }, [lists]);

  React.useEffect(() => {
    let active = true;
    fetch('/api/watchlists').then((response) => response.json()).then((payload) => {
      if (!active || payload?.status !== 'calculated') { if (active) setSyncState('local'); return; }
      const hasLocal = Boolean(window.localStorage.getItem('tradegate-watchlists'));
      if (!hasLocal && Array.isArray(payload.lists) && payload.lists.length) {
        const adopted = {};
        for (const list of payload.lists) if (list?.name && Array.isArray(list.symbols)) adopted[list.name] = list.symbols;
        if (Object.keys(adopted).length) {
          setLists(adopted);
          setActiveList(Object.keys(adopted)[0]);
        }
      }
      serverSyncedRef.current = true;
      setSyncState('synced');
    }).catch(() => { if (active) setSyncState('local'); });
    return () => { active = false; };
  }, []);

  const symbols = lists[activeList] ?? [];
  const [snapshots, setSnapshots] = React.useState({});
  const updateSnapshot = React.useCallback((symbol, value) => {
    setSnapshots((current) => {
      if (current[symbol] === value || (value && current[symbol] && current[symbol].score === value.score && current[symbol].regime === value.regime)) return current;
      const next = { ...current };
      if (value === null) delete next[symbol]; else next[symbol] = value;
      return next;
    });
  }, []);

  const addSymbol = () => {
    const result = addSymbolToList(lists, activeList, draftSymbol);
    if (!result.ok) {
      setAddError(result.reason);
      return;
    }
    setAddError(null);
    setLists(result.lists);
    setDraftSymbol('');
  };
  const removeSymbol = (symbol) => {
    setLists((current) => ({ ...current, [activeList]: (current[activeList] ?? []).filter((item) => item !== symbol) }));
    updateSnapshot(symbol, null);
  };
  const exportListCsv = () => {
    const header = 'Symbol,Last,Change3mPct,Score,Regime,PctFrom52wHigh';
    const lines = symbols.map((symbol) => {
      const snapshot = snapshots[symbol];
      return [symbol, snapshot?.last ?? '', Number.isFinite(snapshot?.changePct) ? snapshot.changePct.toFixed(2) : '', snapshot?.score ?? '', snapshot?.regime ?? '', Number.isFinite(snapshot?.pctFrom52wHigh) ? snapshot.pctFrom52wHigh : ''].join(',');
    });
    const blob = new Blob([[header].concat(lines).join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `tradegate-watchlist-${activeList.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const createList = () => {
    const name = `List ${Object.keys(lists).length + 1}`;
    setLists((current) => ({ ...current, [name]: [] }));
    setActiveList(name);
  };
  const deleteList = () => {
    if (Object.keys(lists).length <= 1) return;
    setLists((current) => {
      const next = { ...current };
      delete next[activeList];
      return next;
    });
    setActiveList((current) => Object.keys(lists).find((name) => name !== current) ?? 'Core');
  };

  return <div className="watchlists-dashboard">
    <section className="macro-intro">
      <div><p className="eyebrow">WATCHLIST WORKSPACE</p><h1>Your names, calculated.</h1><p className="intro">Live provider histories, technical scores, and regimes for the symbols you track. Lists persist in this browser{syncState === 'synced' ? ' and mirror to the server database.' : '.'}</p></div>
      <div className="model-tabs">{syncState !== 'idle' && syncState !== 'local' && <span className="watch-sync-pill" data-state={syncState}>{syncState === 'syncing' ? 'SYNCING…' : syncState === 'failed' ? 'LOCAL ONLY · SYNC FAILED' : 'SERVER SYNCED'}</span>}<button className="active">Local lists</button></div>
    </section>
    <DataDisclosure data={data} message="Each row pulls live market history and the technical-v1 snapshot from the server. Nothing is fabricated; unavailable providers show blanks." />
    <section className="screener-controls-row">
      <div className="window-buttons">{Object.keys(lists).map((name) => <button className={activeList === name ? 'selected' : ''} key={name} onClick={() => setActiveList(name)}>{name}</button>)}</div>
      <div className="watchlist-actions">
        <input className="screener-search" value={draftSymbol} onChange={(event) => { setDraftSymbol(event.target.value); setAddError(null); }} onKeyDown={(event) => event.key === 'Enter' && addSymbol()} placeholder="Add symbol…" aria-label="Add symbol" />{addError ? <small className="watchlist-add-error" role="status">{addError}</small> : null}
        <button className="watch-button" onClick={addSymbol}>+ Add</button>
        {symbols.length ? <button className="watch-button" onClick={exportListCsv}>Export CSV</button> : null}
        <button className="watch-button" onClick={createList}>New list</button>
        {Object.keys(lists).length > 1 && <button className="watch-button" onClick={deleteList}>Delete list</button>}
      </div>
    </section>
    <section className="screener-panel panel">
      {(() => {
        const computed = symbols.map((symbol) => snapshots[symbol]).filter(Boolean);
        if (!symbols.length || !computed.length) return null;
        const avgScore = Math.round(computed.reduce((total, snapshot) => total + snapshot.score, 0) / computed.length);
        const riskOn = computed.filter((snapshot) => snapshot.regime === 'Risk-on' || snapshot.regime === 'Constructive').length;
        const stress = computed.filter((snapshot) => snapshot.regime === 'Stress').length;
        return <p className="watchlist-summary">{symbols.length} tracked · {computed.length} calculated · avg score {avgScore} · {riskOn} risk-on · {stress} stress</p>;
      })()}
      <div className="watchlist-head"><span>Symbol</span><span>3M trend</span><span>Latest</span><span>3M change</span><span>Technical state</span><span></span></div>
      {symbols.map((symbol) => <WatchlistRow key={`${activeList}-${symbol}`} symbol={symbol} onRemove={removeSymbol} onSnapshot={updateSnapshot} />)}
      {!symbols.length && <div className="calculation-empty">This list is empty — add a ticker above to start tracking calculated signals.</div>}
    </section>
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
  </div>;
}

function screenerLeader(rows) {
  let best = null;
  for (const row of rows ?? []) if (Number.isFinite(row.mom20) && (!best || row.mom20 > best.mom20)) best = row;
  return best;
}

function ForexDashboard({ data }) {
  const fxWorkspace = data.fx;
  const fredCurrencyRows = [
    { key: 'eurUsd', currency: 'EUR', name: 'Euro', driver: 'FRED H.10 DEXUSEU' },
    { key: 'yenPerUsd', currency: 'JPY', name: 'Yen', driver: 'FRED H.10 DEXJPUS' },
    { key: 'yuanPerUsd', currency: 'CNH', name: 'Yuan', driver: 'PBoC liquidity and fixings' },
  ].map(({ key, currency, name, driver }) => {
    const values = (data.liquidity?.series?.find((series) => series.key === key)?.history ?? []).map((point) => point.value).filter(Number.isFinite);
    const latest = values.at(-1);
    const past = values.at(-21);
    const rateChange = Number.isFinite(latest) && Number.isFinite(past) && past ? ((latest / past) - 1) * 100 : null;
    const strengthChange = rateChange === null ? null : key === 'eurUsd' ? rateChange : -rateChange;
    return {
      currency,
      name,
      change: strengthChange,
      bias: strengthChange === null ? 'Unavailable' : strengthChange > 0.5 ? 'USD weak' : strengthChange < -0.5 ? 'USD strong' : 'Range',
      score: strengthChange === null ? null : Math.round(Math.max(0, Math.min(100, 50 + (strengthChange * 8)))),
      driver,
    };
  });
  const fxCurrencyRows = (fxWorkspace?.pairs ?? []).map((pair) => ({
    currency: pair.key.toUpperCase(),
    name: pair.name,
    change: pair.momentum20d,
    bias: pair.momentum20d === null || pair.momentum20d === undefined ? 'Unavailable' : pair.momentum20d > 0.5 ? 'USD weak' : pair.momentum20d < -0.5 ? 'USD strong' : 'Range',
    score: pair.score ?? null,
    driver: pair.cot ? `COT ${pair.cot.percentile}th pct · ${pair.cot.crowd}` : 'CFTC pending',
  }));
  const currencyMomentum = [
    ...fxCurrencyRows,
    ...fredCurrencyRows.filter((row) => !fxCurrencyRows.some((fxRow) => fxRow.currency === row.currency)),
  ];
  const calculatedCurrencies = currencyMomentum.filter((row) => row.score !== null);

  return <div className="forex-dashboard">
    <section className="macro-intro">
      <div><p className="eyebrow">FOREX RESEARCH SYSTEM</p><h1>Currencies trade the dollar cycle.</h1><p className="intro">Momentum, speculative positioning, and cross-market links for the major currencies versus the dollar.</p></div>
      <div className="model-tabs"><button className="active">Live workspace</button></div>
    </section>
    <DataDisclosure data={data} message="Currency momentum, CFTC positioning, commodity links, and rotation signals are versioned calculations from Yahoo crosses, CFTC COT futures data, and stored FRED H.10 rates." />
    <section className="macro-section-heading"><div><p className="section-kicker">POSITIONING AND MOMENTUM</p><h2>Where currencies stand against the dollar</h2></div><span className="data-pill">{fxWorkspace?.usdBreadth ? `${fxWorkspace.usdBreadth.read} · USD stronger vs ${fxWorkspace.usdBreadth.strong20d}/${fxWorkspace.usdBreadth.total} crosses (20D)` : '20-session momentum'}</span></section>
    <section className="forex-grid">
      <article className={`fx-outlook-panel panel ${calculatedCurrencies.length ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">20-SESSION RELATIVE-VALUE OUTLOOK · CALCULATED</p><h3>Currency momentum versus the dollar</h3></div><span className="data-pill">{calculatedCurrencies.length ? `${calculatedCurrencies.length} of ${currencyMomentum.length} calculated` : 'Awaiting rates'}</span></div><div className="fx-outlook-head"><span>Currency</span><span>Bias</span><span>Score</span><span>Dominant driver</span></div>{currencyMomentum.map((row) => <div className="fx-outlook-row" key={row.currency}><b>{row.currency}</b><span className={row.bias === 'USD weak' ? 'positive' : row.bias === 'USD strong' ? 'negative' : 'neutral'}>{row.bias}</span><strong>{row.score ?? '—'}</strong><small>{Number.isFinite(row.change) ? `${row.change > 0 ? '+' : ''}${row.change.toFixed(2)}% 20-session` : row.driver}</small></div>)}{fxWorkspace?.usdBreadth && <div className="fx-outlook-row" key="usd-breadth"><b>USD</b><span className={fxWorkspace.usdBreadth.pct20d >= 70 ? 'negative' : fxWorkspace.usdBreadth.pct20d <= 30 ? 'positive' : 'neutral'}>{fxWorkspace.usdBreadth.read}</span><strong>{fxWorkspace.usdBreadth.pct20d ?? '—'}</strong><small>{`stronger vs ${fxWorkspace.usdBreadth.strong20d}/${fxWorkspace.usdBreadth.total} crosses 20D · ${fxWorkspace.usdBreadth.strong60d}/60D window`}</small></div>}<p className="model-footnote">Six currencies come from the calculated FX workspace (Yahoo crosses oriented for currency strength, technical-v1 scores, CFTC COT percentiles); CNH derives from stored FRED H.10 rates. Per-USD quotes are inverted so positive change means currency strength. The USD breadth row counts crosses where the dollar gained over the trailing 20 and 60 sessions.</p></article>
      <article className={`fx-positioning-panel panel ${fxWorkspace?.pairs?.some((pair) => pair.cot) || fxWorkspace?.usdCot ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">FX POSITIONING · CALCULATED</p><h3>CFTC net speculative exposure</h3></div><span className="data-pill">3Y percentile</span></div>{fxWorkspace?.usdCot && <div className="fx-position-row" key="usd"><div><b>US Dollar Index</b><small>{fxWorkspace.usdCot.stance}{Number.isFinite(fxWorkspace.usdCot.weeklyChange) ? ` · weekly ${fxWorkspace.usdCot.weeklyChange >= 0 ? '+' : ''}${fxWorkspace.usdCot.weeklyChange.toLocaleString()}` : ''} · {fxWorkspace.usdCot.asOf} · ICE</small></div><i><b style={{ width: `${Math.min(fxWorkspace.usdCot.percentile ?? 0, 100)}%` }}></b></i><strong>{Number.isFinite(fxWorkspace.usdCot.netNoncomm) ? `${Math.round(fxWorkspace.usdCot.netNoncomm / 1000)}k` : '—'}</strong><span>{fxWorkspace.usdCot.crowd}</span></div>}{(fxWorkspace?.pairs ?? []).filter((pair) => pair.cot).map((pair) => <div className="fx-position-row" key={pair.key}><div><b>{pair.name}</b><small>{pair.cot.stance}{Number.isFinite(pair.cot.weeklyChange) ? ` · weekly ${pair.cot.weeklyChange >= 0 ? '+' : ''}${pair.cot.weeklyChange.toLocaleString()}` : ''} · {pair.cot.asOf}</small></div><i><b style={{ width: `${Math.min(pair.cot.percentile ?? 0, 100)}%` }}></b></i><strong>{Number.isFinite(pair.cot.netNoncomm) ? `${Math.round(pair.cot.netNoncomm / 1000)}k` : '—'}</strong><span>{pair.cot.crowd}</span></div>)}{!(fxWorkspace?.pairs ?? []).some((pair) => pair.cot) && !fxWorkspace?.usdCot && <div className="calculation-empty">CFTC currency contracts are required before positioning can publish.</div>}<p className="model-footnote">{fxWorkspace?.methodology ?? 'Awaiting FX workspace.'}</p></article>
      <article className={`fx-commodity-panel panel ${(fxWorkspace?.links ?? []).length ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">FX COMMODITY LINKS · CALCULATED</p><h3>60-day change correlations</h3></div><span className="data-pill">{fxWorkspace?.riskRegime ?? '—'}</span></div><div className="fx-commodity-head"><span>FX</span><span>Linked market</span><span>r</span><span>State</span><span>Moves first</span><span>Momentum</span></div>{(fxWorkspace?.links ?? []).map((link) => <div className="fx-commodity-row" key={`${link.currency}-${link.market}`}><b>{link.currency}</b><span>{link.market}</span><strong>{Number.isFinite(link.correlation60d) ? `${link.correlation60d > 0 ? '+' : ''}${link.correlation60d}` : '—'}</strong><i className={link.state === 'Aligned' ? 'positive' : link.state === 'Inverse' ? 'caution' : 'neutral'}>{link.state}</i><em className={link.leadLag?.leader ? 'lead-flag' : 'lead-flag lead-flat'} title={link.leadLag ? `Peak correlation ${link.leadLag.corrAtBest.toFixed(2)} at a lag of ${link.leadLag.bestLagBars} sessions versus ${Number.isFinite(link.leadLag.synchronousCorr) ? link.leadLag.synchronousCorr.toFixed(2) : '—'} synchronous` : 'Needs at least 40 aligned sessions'}>{link.leadLag ? link.leadLag.read : 'Pending'}</em><small>{Number.isFinite(link.currencyMomentum20d) && Number.isFinite(link.marketMomentum20d) ? `${link.currencyMomentum20d > 0 ? '+' : ''}${link.currencyMomentum20d}% / ${link.marketMomentum20d > 0 ? '+' : ''}${link.marketMomentum20d}%` : '—'}</small></div>)}{!(fxWorkspace?.links ?? []).length && <div className="calculation-empty">Currency and commodity histories are required before links can publish.</div>}</article>
      <article className={`fx-rotation-panel panel ${(fxWorkspace?.rotationSignals ?? []).some((signal) => signal.status !== 'Unavailable') ? '' : 'preview-section'}`}><p className="section-kicker">FX ROTATION SIGNALS · CALCULATED</p><h3>20-session momentum handoffs {fxWorkspace?.riskRegime ? `· ${fxWorkspace.riskRegime}` : ''}</h3>{(fxWorkspace?.rotationSignals ?? []).map((signal) => <div className="fx-rotation-row" key={signal.signal}><div><b>{signal.signal}</b><small>{signal.detail}{Number.isFinite(signal.left) && Number.isFinite(signal.right) ? ` · ${signal.left > 0 ? '+' : ''}${signal.left}% vs ${signal.right > 0 ? '+' : ''}${signal.right}%` : ''}</small></div><span className={signal.status === 'Confirmed' ? fxWorkspace?.riskRegime === 'Risk-off' ? 'riskoff' : 'riskon' : signal.status === 'Diverged' ? 'neutral' : 'neutral'}>{signal.status}</span></div>)}<p>Confirmation compares 20-session momenta by sign; divergences flag potential rotations in risk appetite. Lead/lag timing for each commodity link is published in the panel above, scanned over daily closes; intraday handoffs still require intraday histories.</p></article>
    </section>
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
  </div>;
}

function technicalCell(label, value, note) {
  return <div className="btc-cycle-cell" key={label}><small>{label}</small><b>{value}</b><span>{note}</span></div>;
}

/**
 * The close-only technical block. Models the close series genuinely cannot
 * support - TD countdown, setup perfection, the TDST line - are listed as
 * withheld with the feed they need, never rendered as a number.
 */
/**
 * The OHLCV-dependent block. It only appears once a bar feed carrying highs and
 * lows responds; on a close-only feed it says so instead of substituting closes
 * for the extremes.
 */
function BitcoinRangeSection({ rangeModels }) {
  const status = rangeModels?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  const modules = rangeModels?.modules ?? {};
  const atr = modules.atr ?? {};
  const donchian = modules.donchian ?? {};
  const countdown = modules.tdCountdown ?? {};
  const obv = modules.onBalanceVolume ?? {};
  const channels = donchian.channels ?? [];

  return <>
    <section className="macro-section-heading"><div><p className="section-kicker">RANGE, CHANNELS &amp; VOLUME · {status.toUpperCase()}</p><h2>{published ? (donchian.read ?? 'Range models published') : 'Awaiting a daily bar feed with highs and lows'}</h2></div>{published ? <span className="data-pill">{rangeModels.observations} bars · {rangeModels.withVolume} with volume</span> : null}</section>
    <section className={`screener-panel panel ${published ? '' : 'preview-section'}`}>
      <div className="btc-cycle-grid">
        {technicalCell('True range (ATR)', Number.isFinite(atr.atrPercent) ? `${atr.atrPercent}%` : '—', atr.state ? `${atr.state} · ${atr.ratio}x its level 20 bars ago · ${atr.percentile}th percentile` : atr.reason ?? 'Unavailable')}
        {channels.length ? channels.map((channel) => technicalCell(`${channel.period}-bar channel`, channel.state === 'inside' ? `${channel.positionPercent}%` : channel.state === 'breakout up' ? 'Break up' : 'Break down', `${channel.lower}–${channel.upper} · ${channel.widthPercent}% wide`))
          : technicalCell('Donchian channels', '—', donchian.reason ?? 'Unavailable')}
        {technicalCell('TD countdown', countdown.countdown ? `${countdown.countdown.direction === 'buy' ? 'Buy' : 'Sell'} ${countdown.countdown.count}` : countdown.status === 'calculated' ? 'None' : '—', countdown.countdown
          ? `${countdown.countdown.complete ? 'complete at 13' : countdown.countdown.deferred ? '13 deferred — bar-13 close did not clear bar 8' : 'counting toward 13'} · ${countdown.setup.perfected ? 'perfected' : 'plain'} setup ${countdown.setup.completedOn}`
          : countdown.status === 'calculated' ? 'No nine-bar setup has completed' : countdown.reason ?? 'Unavailable')}
        {technicalCell('TDST line', Number.isFinite(countdown.tdst?.level) ? `${countdown.tdst.level}` : '—', countdown.tdst ? `${countdown.tdst.side} · ${countdown.tdst.broken ? 'broken' : 'holding'}` : 'Needs a completed setup on daily bars')}
        {technicalCell('On-balance volume', obv.agreement ? obv.agreement.charAt(0).toUpperCase() + obv.agreement.slice(1) : '—', obv.status === 'calculated' ? `OBV ${obv.obvDirection} while price is ${obv.priceDirection} over ${obv.window} bars` : obv.reason ?? 'Unavailable')}
      </div>
      <p className="cycle-phase-read">{published ? [atr.read, countdown.read, obv.read].filter(Boolean).join(' ') : rangeModels?.reason ?? 'Range, channel, countdown and volume models publish once a daily bar feed carrying highs and lows responds.'}</p>
      <p className="model-footnote">{[donchian.methodology, countdown.methodology].filter(Boolean).join(' ') || 'These models are withheld on a close-only feed rather than approximated from closes.'}</p>
    </section>
  </>;
}

function BitcoinTechnicalsSection({ technicals, rangeAvailable = false }) {
  const status = technicals?.status ?? 'unavailable';
  const published = status !== 'unavailable';
  const modules = technicals?.modules ?? {};
  const stack = modules.movingAverages ?? {};
  const stochastic = modules.stochasticRsi ?? {};
  const squeeze = modules.squeeze ?? {};
  const range = modules.range ?? {};
  const setup = modules.tdSetup ?? {};
  const slope = modules.momentumSlope ?? {};
  const riskAdjusted = modules.volatilityAdjustedMomentum ?? {};
  const divergences = modules.divergences?.divergences ?? [];
  const withheld = [setup.countdown, setup.perfected, setup.tdst].filter((entry) => entry?.status === 'unavailable');

  return <>
    <section className="macro-section-heading"><div><p className="section-kicker">PRICE TECHNICALS · {status.toUpperCase()}</p><h2>{published ? `${technicals.stance} tape` : 'Awaiting bitcoin price history'}</h2></div>{published ? <span className="data-pill">{technicals.score}/100 · {technicals.coverage}% of legs</span> : null}</section>
    <section className={`screener-panel panel ${published ? '' : 'preview-section'}`}>
      <div className="btc-cycle-grid">
        {technicalCell('Stochastic RSI', stochastic.status === 'calculated' ? `${stochastic.k}` : '—', stochastic.status === 'calculated' ? `%D ${stochastic.d} · ${stochastic.zone}${stochastic.cross ? ` · ${stochastic.cross} cross` : ''}` : stochastic.reason ?? 'Unavailable')}
        {technicalCell('RSI & slope', slope.status === 'calculated' ? `${slope.rsi}` : '—', slope.status === 'calculated' ? `${slope.slopePerWindow > 0 ? '+' : ''}${slope.slopePerWindow} pts/14 bars · ${slope.direction}` : slope.reason ?? 'Unavailable')}
        {technicalCell('Moving-average stack', Number.isFinite(stack.aboveCount) ? `${stack.aboveCount}/${stack.totalPublished}` : '—', Number.isFinite(stack.aboveCount)
          ? `${stack.stackAlignment ? `${stack.stackAlignment} alignment` : 'alignment needs all four daily EMAs'} · ${stack.totalPublished} of ${stack.totalDefined} averages published${stack.missingAverages?.length ? ` · missing ${stack.missingAverages.join(', ')}` : ''}`
          : stack.reason ?? 'Unavailable')}
        {technicalCell('50/200 cross', stack.crossState ? `${stack.crossState === 'golden' ? 'Golden' : 'Death'}` : '—', stack.cross ? `since ${stack.cross.date} · ${stack.cross.barsSince} bars` : stack.crossState ? `50D has been ${stack.crossState === 'golden' ? 'above' : 'below'} the 200D for the whole available history` : 'Needs 200 daily closes')}
        {technicalCell('Stretch from 200D', Number.isFinite(stack.zScore) ? `${stack.zScore > 0 ? '+' : ''}${stack.zScore}σ` : '—', stack.zScoreStatus === 'provisional' ? `provisional · ${stack.zScoreObservations} observations` : Number.isFinite(stack.zScore) ? `Z-score of log(price / 200D) over ${stack.zScoreObservations} bars` : 'Needs 200 daily closes')}
        {technicalCell('Bollinger bandwidth', Number.isFinite(squeeze.percentile) ? `${squeeze.percentile}th` : '—', Number.isFinite(squeeze.percentile) ? `${squeeze.state} · ${squeeze.bandwidthPercent}% wide over ${squeeze.rankedAgainst} bars` : squeeze.reason ?? 'Unavailable')}
        {technicalCell('Range percentile', Number.isFinite(range.percentile) ? `${range.percentile}th` : '—', Number.isFinite(range.positionInRange) ? `${range.rangePercent}% span · price ${range.positionInRange}% up it` : range.reason ?? 'Unavailable')}
        {technicalCell('TD setup', setup.direction ? `${setup.direction === 'buy' ? 'Buy' : 'Sell'} ${setup.count}` : setup.status === 'calculated' ? 'None' : '—', setup.status === 'calculated' ? (setup.complete ? `count complete · raw run ${setup.rawCount}` : 'counting toward 9') : setup.reason ?? 'Unavailable')}
        {technicalCell('Vol-adjusted momentum', Number.isFinite(riskAdjusted.ratio) ? `${riskAdjusted.ratio}` : '—', riskAdjusted.status === 'calculated' ? `${riskAdjusted.returnPercent > 0 ? '+' : ''}${riskAdjusted.returnPercent}% over ${riskAdjusted.window} bars at ${riskAdjusted.annualizedVolatilityPercent}% vol` : riskAdjusted.reason ?? 'Unavailable')}
      </div>
      {(technicals?.legs ?? []).map((leg) => <div className="scenario-row" key={leg.key}><span>{leg.name}</span><i><b style={{ width: `${leg.score}%` }}></b></i><strong>{leg.score}</strong></div>)}
      <p className="cycle-phase-read">{divergences.length
        ? divergences.map((entry) => `${entry.name}: ${entry.from.date} to ${entry.to.date}, confirmed ${entry.barsSinceConfirmed} bars ago.`).join(' ')
        : modules.divergences?.read ?? 'RSI divergences publish once enough history is available to confirm two pivots.'}</p>
      {withheld.length ? <p className="model-footnote">{rangeAvailable
        ? 'The TD countdown, setup perfection and the TDST line need daily highs and lows, so they are published in the range block below rather than approximated from closes here.'
        : `Withheld rather than approximated: ${withheld.map((entry) => entry.reason).join(' ')}`}</p> : null}
      <p className="model-footnote">{technicals?.methodology ?? technicals?.reason ?? 'Bitcoin price technicals publish once Yahoo BTC-USD history responds.'}</p>
    </section>
  </>;
}

function CryptoDashboard({ data }) {
  const [correlationWindow, setCorrelationWindow] = React.useState('60D');
  const dxyBtcModel = data.dxyBtc?.model;
  const dxyBtcCorrelationValue = dxyBtcModel?.correlations?.[correlationWindow];
  const dxyHistory = normalizeSparkline(dxyBtcModel?.history?.left ?? []);
  const bitcoinHistory = normalizeSparkline(dxyBtcModel?.history?.right ?? []);
  const btc = data.bitcoin;
  const cyclePhase = btc?.phase;
  const cryptoRotation = btc?.cryptoGlobal?.rotation;
  const hasBtc = Boolean(btc?.calculatedCount);
  const usdStrength = published(data.liquidity?.usdStrength) ? data.liquidity.usdStrength : null;
  const liquidityModel = published(data.liquidity?.model) ? data.liquidity.model : null;
  const usdMomentum = usdStrength?.indicators?.momentum20d;
  const corr60 = dxyBtcModel?.correlations?.['60D'];
  // Calculated server-side so the browser and the persisted alerts can never
  // disagree about whether the dollar is helping or hurting.
  const transmission = data.dxyBtc?.dollarTransmission ?? null;
  const tailwindScore = transmission?.tailwindScore ?? null;
  const hasDollarInputs = transmission?.status === 'calculated';
  const tailwindLabel = transmission?.tailwindLabel ?? (transmission?.status === 'provisional' ? 'Link not yet measured' : 'Awaiting dollar inputs');

  return <div className="crypto-dashboard">
    <section className="macro-intro">
      <div><p className="eyebrow">CRYPTO RESEARCH SYSTEM</p><h1>Bitcoin trades liquidity, not headlines.</h1><p className="intro">Cycle valuation, leverage crowding, and the dollar transmission that sets the tailwind or headwind.</p></div>
      <div className="model-tabs"><button className="active">Cycle &amp; crowding</button></div>
    </section>
    <DataDisclosure data={data} message="Trend, MVRV-Z, short-term-holder cost basis, funding, open interest, stablecoins, and the DXY/BTC relationship are versioned calculations. Spot ETF flows remain unavailable without a licensed source." />

    <section className="macro-section-heading cycle-phase-heading"><div><p className="section-kicker">CYCLE PHASE · {cyclePhase?.status?.toUpperCase() ?? 'UNAVAILABLE'}</p><h2>{cyclePhase?.leading ? cyclePhase.leading.name : cyclePhase?.status && cyclePhase.status !== 'unavailable' ? 'No phase is clearly ahead' : 'Awaiting cycle legs'}</h2></div>{cyclePhase?.leading ? <span className="data-pill">{cyclePhase.leading.score}/100{Number.isFinite(cyclePhase.leading.margin) ? ` · ${cyclePhase.leading.margin} clear` : ''}</span> : null}</section>
    <section className={`screener-panel panel ${cyclePhase?.status && cyclePhase.status !== 'unavailable' ? '' : 'preview-section'}`}>
      <p className="cycle-phase-read">{cyclePhase?.read ?? 'Trend, valuation, drawdown and derivatives legs are required before a cycle phase can be placed.'}</p>
      {(cyclePhase?.phases ?? []).map((phase) => <div className={`scenario-row ${cyclePhase?.leading?.key === phase.key ? 'scenario-leading' : ''}`} key={phase.key} title={phase.legs.map((leg) => `${leg.name}: ${leg.score ?? 'unavailable'}`).join('\n')}><span>{phase.name}<small>{phase.outcome}{phase.missing.length ? ` · missing ${phase.missing.length} of ${phase.legs.length} legs` : ''}</small></span><i><b style={{ width: `${phase.score ?? 0}%` }}></b></i><strong>{Number.isFinite(phase.score) ? phase.score : '—'}</strong></div>)}
      <p className="model-footnote">{cyclePhase?.methodology ?? 'Trend, valuation, drawdown and derivatives legs are required before a cycle phase can be placed.'}</p>
    </section>
    <BitcoinTechnicalsSection technicals={btc?.technicals} rangeAvailable={btc?.rangeModels?.modules?.tdCountdown?.status === 'calculated'} />
    <BitcoinRangeSection rangeModels={btc?.rangeModels} />
    <section className="macro-section-heading"><div><p className="section-kicker">DOLLAR TRANSMISSION · {transmission?.status?.toUpperCase() ?? 'UNAVAILABLE'}</p><h2>{transmission?.linkSign === 0 ? 'The dollar link is too weak to move bitcoin' : `${tailwindLabel} for bitcoin`}</h2></div><span className="data-pill">Favorability read</span></section>
    <section className="crypto-grid">
      <article className={`crypto-tailwind-panel panel ${hasDollarInputs ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">IS THE DOLLAR A TAILWIND?</p><h3>{tailwindLabel}</h3></div><span className="data-pill">{Number.isFinite(tailwindScore) ? `${tailwindScore > 0 ? '+' : ''}${tailwindScore} signal` : 'Unavailable'}</span></div>
        <div className="btc-cycle-grid">
          <div className="btc-cycle-cell"><small>Broad-dollar momentum</small><b>{formatPercent(usdMomentum)}</b><span>20-session change · {usdStrength?.regime ?? 'regime unavailable'}</span></div>
          <div className="btc-cycle-cell"><small>Dollar strength score</small><b>{usdStrength?.score ?? '—'}</b><span>{usdStrength ? `${usdStrength.coverage}% coverage · a weaker dollar favors BTC` : 'Awaiting FRED broad-dollar history'}</span></div>
          <div className="btc-cycle-cell"><small>DXY ↔ BTC link</small><b>{Number.isFinite(corr60) ? corr60.toFixed(2) : '—'}</b><span>{dxyBtcModel ? `${dxyBtcModel.regime} · an inverse link means a falling dollar lifts BTC` : 'Awaiting synchronized histories'}</span></div>
          <div className="btc-cycle-cell"><small>Liquidity impulse</small><b>{liquidityModel?.momentum ?? '—'}</b><span>{liquidityModel ? `Net US liquidity regime: ${liquidityModel.regime}` : 'Awaiting FRED'}</span></div>
        </div>
        <p className="model-footnote">{transmission?.reason ? `${transmission.reason} ` : ''}Favorability applies broad-dollar direction and level through the measured DXY/BTC correlation rather than an assumed one: a falling dollar only helps bitcoin while the link is inverse, the same move reads as a headwind under a positive link, and inside a ±0.2 correlation band the dollar transmits nothing.</p>
      </article>
      <article className={`crypto-tailwind-panel panel ${data.bitcoin?.ethRotation?.status === 'calculated' ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">ETHEREUM &amp; ROTATION · CALCULATED</p><h3>{data.bitcoin?.ethRotation?.btcEthRatio?.read ?? 'Awaiting histories'}</h3></div><span className="data-pill">{data.bitcoin?.ethRotation?.version ?? 'Unavailable'}</span></div>
        <div className="btc-cycle-grid">
          <div className="btc-cycle-cell"><small>ETH spot</small><b>{Number.isFinite(data.bitcoin?.ethRotation?.price) ? `$${Math.round(data.bitcoin.ethRotation.price).toLocaleString()}` : '—'}</b><span>{Number.isFinite(data.bitcoin?.ethRotation?.pctVsSma200) ? `${data.bitcoin.ethRotation.pctVsSma200 > 0 ? '+' : ''}${data.bitcoin.ethRotation.pctVsSma200}% vs 200D` : 'Yahoo ETH-USD history required'}</span></div>
          <div className="btc-cycle-cell"><small>ETH momentum</small><b>{Number.isFinite(data.bitcoin?.ethRotation?.momentum20d) ? `${data.bitcoin.ethRotation.momentum20d > 0 ? '+' : ''}${data.bitcoin.ethRotation.momentum20d}%` : '—'}</b><span>20-session change</span></div>
          <div className="btc-cycle-cell"><small>BTC/ETH ratio</small><b>{Number.isFinite(data.bitcoin?.ethRotation?.btcEthRatio?.ratio) ? data.bitcoin.ethRotation.btcEthRatio.ratio : '—'}</b><span>{Number.isFinite(data.bitcoin?.ethRotation?.btcEthRatio?.percentile) ? `${data.bitcoin.ethRotation.btcEthRatio.percentile}th pct · ${data.bitcoin.ethRotation.btcEthRatio.change20d > 0 ? '+' : ''}${data.bitcoin.ethRotation.btcEthRatio.change20d}% 20d` : 'Aligned BTC/ETH histories required'}</span></div>
        </div>
        <p className="model-footnote">{data.bitcoin?.ethRotation?.methodology ?? 'Ethereum rotation publishes once Yahoo ETH-USD and BTC-USD histories respond.'}</p>
      </article>
      <IntradayRotationPanel fallback={data.bitcoin?.intraday ?? null} />
      <article className={`crypto-tailwind-panel panel ${data.bitcoin?.cryptoGlobal?.status === 'calculated' ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">GLOBAL CRYPTO LIQUIDITY · CALCULATED</p><h3>{cryptoRotation?.status === 'calculated' ? cryptoRotation.regime : Number.isFinite(data.bitcoin?.cryptoGlobal?.mcapChange24hPct) ? `${data.bitcoin.cryptoGlobal.mcapChange24hPct >= 0 ? 'Expanding' : 'Contracting'} ${Math.abs(data.bitcoin.cryptoGlobal.mcapChange24hPct).toFixed(2)}% today` : 'Awaiting CoinGecko'}</h3></div><span className="data-pill">{cryptoRotation?.status === 'calculated' ? `BTC ${cryptoRotation.bitcoinChange24hPct > 0 ? '+' : ''}${cryptoRotation.bitcoinChange24hPct}% vs total ${cryptoRotation.marketChange24hPct > 0 ? '+' : ''}${cryptoRotation.marketChange24hPct}%` : data.bitcoin?.cryptoGlobal?.version ?? 'Unavailable'}</span></div>{cryptoRotation ? <p className="cycle-phase-read">{cryptoRotation.read ?? cryptoRotation.reason}{cryptoRotation.status === 'calculated' ? ` Bitcoin's 24-hour spread against the whole complex is ${cryptoRotation.spread > 0 ? '+' : ''}${cryptoRotation.spread} points${Number.isFinite(cryptoRotation.btcDominancePct) ? `, with dominance at ${cryptoRotation.btcDominancePct}%` : ''}.` : ''}</p> : null}
        <div className="btc-cycle-grid">
          <div className="btc-cycle-cell"><small>Total market cap</small><b>{Number.isFinite(data.bitcoin?.cryptoGlobal?.totalMcapUsd) ? formatLiquidityValue(data.bitcoin.cryptoGlobal.totalMcapUsd / 1e6) : '—'}</b><span>All tracked crypto assets</span></div>
          <div className="btc-cycle-cell"><small>24h change</small><b className={data.bitcoin?.cryptoGlobal?.mcapChange24hPct >= 0 ? 'positive' : 'negative'}>{Number.isFinite(data.bitcoin?.cryptoGlobal?.mcapChange24hPct) ? `${data.bitcoin.cryptoGlobal.mcapChange24hPct > 0 ? '+' : ''}${data.bitcoin.cryptoGlobal.mcapChange24hPct.toFixed(2)}%` : '—'}</b><span>Aggregate USD capitalization</span></div>
          <div className="btc-cycle-cell"><small>BTC dominance</small><b>{Number.isFinite(data.bitcoin?.cryptoGlobal?.btcDominance) ? `${data.bitcoin.cryptoGlobal.btcDominance.toFixed(1)}%` : '—'}</b><span>Share of total capitalization</span></div>
          <div className="btc-cycle-cell"><small>ETH dominance</small><b>{Number.isFinite(data.bitcoin?.cryptoGlobal?.ethDominance) ? `${data.bitcoin.cryptoGlobal.ethDominance.toFixed(1)}%` : '—'}</b><span>Share of total capitalization</span></div>
        </div>
        <p className="model-footnote">{data.bitcoin?.cryptoGlobal?.methodology ?? 'Global aggregates publish once the CoinGecko global endpoint responds.'}</p>
      </article>
      <article className={`crypto-tailwind-panel panel ${data.bitcoin?.stablecoinLead?.status === 'calculated' ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">STABLECOIN ↔ BTC LEAD/LAG · CALCULATED</p><h3>{data.bitcoin?.stablecoinLead?.read ?? 'Awaiting aligned histories'}</h3></div><span className="data-pill">{data.bitcoin?.stablecoinLead?.version ?? 'Unavailable'}</span></div>
        <div className="btc-cycle-grid">
          <div className="btc-cycle-cell"><small>Peak correlation</small><b>{Number.isFinite(data.bitcoin?.stablecoinLead?.corrAtBest) ? data.bitcoin.stablecoinLead.corrAtBest.toFixed(2) : '—'}</b><span>best daily lag window</span></div>
          <div className="btc-cycle-cell"><small>Lag at peak</small><b>{Number.isFinite(data.bitcoin?.stablecoinLead?.bestLagDays) ? `${data.bitcoin.stablecoinLead.bestLagDays > 0 ? '+' : ''}${data.bitcoin.stablecoinLead.bestLagDays}d` : '—'}</b><span>positive means supply moves first</span></div>
          <div className="btc-cycle-cell"><small>Synchronous r</small><b>{Number.isFinite(data.bitcoin?.stablecoinLead?.synchronousCorr) ? data.bitcoin.stablecoinLead.synchronousCorr.toFixed(2) : '—'}</b><span>zero-lag weekly changes</span></div>
          <div className="btc-cycle-cell"><small>Observations</small><b>{data.bitcoin?.stablecoinLead?.observations ?? '—'}</b><span>aligned daily pairs, trailing year</span></div>
        </div>
        <p className="model-footnote">{data.bitcoin?.stablecoinLead?.methodology ?? data.bitcoin?.stablecoinLead?.reason ?? 'Lead/lag publishes once DefiLlama stablecoin history and Yahoo BTC-USD closes align.'}</p>
      </article>
      <article className={`dxy-btc-panel panel ${hasBtc ? '' : 'preview-section'}`}><div className="panel-title"><div><p className="section-kicker">BITCOIN CYCLE &amp; CROWDING · CALCULATED</p><h3>{btc?.trend?.status === 'calculated' ? `Spot $${Math.round(btc.trend.price).toLocaleString()} · ${btc.trend.pctVsSma200w > 0 ? '+' : ''}${btc.trend.pctVsSma200w}% vs 200W` : 'Cycle dashboard'}</h3></div><span className="data-pill">{btc ? `${btc.calculatedCount}/${btc.totalLegs} legs` : 'Unavailable'}</span></div>
        {hasBtc ? <>
          <div className="btc-cycle-grid">
            <div className="btc-cycle-cell"><small>Trend regime</small><b>{btc.trend?.status === 'calculated' ? `${btc.trend.pctVsSma200d > 0 ? '+' : ''}${btc.trend.pctVsSma200d}% / ${btc.trend.pctVsSma200w > 0 ? '+' : ''}${btc.trend.pctVsSma200w}%` : '—'}</b><span>vs 200D / 200W SMA</span></div>
            <div className="btc-cycle-cell"><small>MVRV Z-Score</small><b>{btc.valuation?.status === 'calculated' ? btc.valuation.mvrvZ : '—'}</b><span>{btc.valuation?.status === 'calculated' ? `${btc.valuation.band} · ${btc.valuation.percentile}th pct` : btc.valuation?.reason}</span></div>
            <div className="btc-cycle-cell"><small>STH realized price</small><b>{btc.shortTermHolder?.status === 'calculated' ? `$${Number.isFinite(btc.shortTermHolder.sthRealizedPrice) ? btc.shortTermHolder.sthRealizedPrice.toLocaleString() : '—'}` : '—'}</b><span>{btc.shortTermHolder?.status === 'calculated' ? `${btc.shortTermHolder.premiumPercent > 0 ? '+' : ''}${btc.shortTermHolder.premiumPercent}% · ${btc.shortTermHolder.state}` : btc.shortTermHolder?.reason}</span></div>
            <div className="btc-cycle-cell"><small>Funding (agg.)</small><b>{btc.leverage?.status === 'calculated' ? `${btc.leverage.annualizedPercent}% APR` : '—'}</b><span>{btc.leverage?.status === 'calculated' ? `${btc.leverage.percentile}th pct · ${btc.leverage.note}` : btc.leverage?.reason}</span></div>
            <div className="btc-cycle-cell" title={btc.positioning?.read ?? undefined}><small>OI vs price (7d)</small><b>{btc.positioning?.status === 'calculated' ? btc.positioning.quadrant : '—'}</b><span>{btc.positioning?.status === 'calculated' ? `OI ${btc.positioning.oiChange7d > 0 ? '+' : ''}${btc.positioning.oiChange7d.toFixed(1)}% vs price ${btc.positioning.priceChange7d > 0 ? '+' : ''}${btc.positioning.priceChange7d.toFixed(1)}%` : btc.positioning?.reason}</span></div>
            <div className="btc-cycle-cell"><small>Stablecoin supply</small><b>{btc.stablecoins?.status === 'calculated' ? `$${btc.stablecoins.supplyUsdBillions}B` : '—'}</b><span>{btc.stablecoins?.status === 'calculated' ? `${btc.stablecoins.change30dUsdBillions > 0 ? '+' : ''}${btc.stablecoins.change30dUsdBillions}B 30d (${btc.stablecoins.state})` : btc.stablecoins?.reason}</span></div>
            <div className="btc-cycle-cell"><small>Drawdown from 10Y high</small><b>{btc.drawdown?.status === 'calculated' ? `${btc.drawdown.drawdownPct}%` : '—'}</b><span>{btc.drawdown?.status === 'calculated' ? `${btc.drawdown.read} · ATH $${Number.isFinite(btc.drawdown.allTimeHigh) ? btc.drawdown.allTimeHigh.toLocaleString() : '—'} · ${btc.drawdown.daysSinceAth}d ago` : btc.drawdown?.reason}</span></div>
            <div className="btc-cycle-cell"><small>Realized vol (30d)</small><b>{btc.realizedVolatility?.status === 'calculated' ? `${btc.realizedVolatility.realizedVol30dPct}%` : '—'}</b><span>{btc.realizedVolatility?.status === 'calculated' ? `${btc.realizedVolatility.read}${Number.isFinite(btc.realizedVolatility.percentile) ? ` · ${btc.realizedVolatility.percentile}th pct of 10Y` : ''}` : btc.realizedVolatility?.reason}</span></div>
            <div className="btc-cycle-cell"><small>Spot ETF flows</small><b>—</b><span>{btc.etfFlows?.reason}</span></div>
          </div>
          <p className="model-footnote">{btc.methodology}</p>
        </> : <div className="calculation-empty">Bitcoin cycle legs publish as their sources respond; ETF flows require a licensed feed.</div>}
      </article>
      <article className="dxy-btc-panel panel"><div className="panel-title"><div><p className="section-kicker">DXY VS BITCOIN · CALCULATED</p><h3>{dxyBtcModel?.interpretation ?? 'Awaiting synchronized histories'}</h3></div><span className="data-pill">{Number.isFinite(dxyBtcCorrelationValue) ? `${correlationWindow} r ${dxyBtcCorrelationValue.toFixed(2)}` : 'Unavailable'}</span></div><div className="window-buttons dxy-window-buttons">{['20D', '60D', '1Y'].map((item) => <button className={correlationWindow === item ? 'selected' : ''} key={item} onClick={() => setCorrelationWindow(item)}>{item}</button>)}</div><div className="dxy-btc-chart"><div><span><i className="dxy-key"></i>{data.dxyBtc?.source?.left?.startsWith('DXY') ? 'DXY' : 'Broad dollar proxy'}</span>{dxyHistory.length ? <Sparkline color="#d3a454" values={dxyHistory} /> : <div className="model-chart-empty">No dollar history</div>}</div><div><span><i className="btc-key"></i>Bitcoin</span>{bitcoinHistory.length ? <Sparkline color="#70c26b" values={bitcoinHistory} /> : <div className="model-chart-empty">No BTC history</div>}</div></div><div className="dxy-btc-diagnostics"><SignalCell label="Correlation regime" value={dxyBtcModel?.regime} /><SignalCell label="Momentum relationship" value={dxyBtcModel?.divergence} /><SignalCell label="Breakout read" value={dxyBtcModel?.interpretation} /><SignalCell label="Moves first" value={dxyBtcModel?.leadLag ? dxyBtcModel.leadLag.leader ? `${dxyBtcModel.leadLag.leader} by ${dxyBtcModel.leadLag.leadDays}d` : 'Neither side' : null} /></div>{dxyBtcModel?.leadLag ? <p className="dxy-lead-read">{dxyBtcModel.leadLag.read}. Peak correlation {dxyBtcModel.leadLag.corrAtBest > 0 ? '+' : ''}{dxyBtcModel.leadLag.corrAtBest.toFixed(2)} at that lag against {Number.isFinite(dxyBtcModel.leadLag.synchronousCorr) ? `${dxyBtcModel.leadLag.synchronousCorr > 0 ? '+' : ''}${dxyBtcModel.leadLag.synchronousCorr.toFixed(2)}` : '—'} with no lag, over {dxyBtcModel.leadLag.observations} aligned observations.</p> : null}<p>{dxyBtcModel ? `${dxyBtcModel.version} · ${dxyBtcModel.observations} aligned daily observations · ${data.dxyBtc.source.left} and ${data.dxyBtc.source.right}` : 'Configure Twelve Data or FRED and retain Bitcoin history to calculate this relationship.'}</p></article>
    </section>
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
  </div>;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
