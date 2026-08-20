import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { formatPercent, formatTimestamp, formatUsd, useEquityResearch, useMarketHistory, usePlatformData, useTechnicalAnalytics } from './liveData.js';

const navItems = [
  ['⌘', 'Overview'],
  ['◌', 'Markets', 'Preview'],
  ['▥', 'Equities'],
  ['◇', 'Metals', 'Preview'],
  ['▦', 'Screener', 'Preview'],
  ['◫', 'Watchlists', 'Preview'],
  ['◔', 'Macro'],
];

const watchlist = [
  { ticker: 'NVDA', name: 'NVIDIA Corp.', color: '#75d95d' },
  { ticker: 'AAPL', name: 'Apple Inc.', color: '#f2a447' },
  { ticker: 'GLD', name: 'SPDR Gold Shares', color: '#c4a7ff' },
  { ticker: 'BTC', name: 'Bitcoin', color: '#ff7c4d' },
];

const news = [
  ['BLOOMBERG', 'Nvidia rallies as AI spending keeps its momentum alive', '12m ago'],
  ['FINANCIAL TIMES', 'The next leg of the market rally will demand broader participation', '36m ago'],
  ['MARKETWATCH', 'Gold is quietly making its case as rate-cut bets build', '1h ago'],
];

const correlationPairs = [
  { left: 'BTC', right: 'S&P 500', values: { '20D': 0.62, '60D': 0.54, '1Y': 0.43 }, regime: 'Risk-on linkage', note: 'Equity beta is elevated' },
  { left: 'DXY', right: 'BTC', values: { '20D': -0.57, '60D': -0.62, '1Y': -0.48 }, regime: 'Dollar headwind', note: 'Inverse relationship intact' },
  { left: 'WTI oil', right: 'CAD', values: { '20D': 0.66, '60D': 0.71, '1Y': 0.58 }, regime: 'Terms-of-trade', note: 'Stable commodity linkage' },
  { left: 'Gold', right: 'Real yields', values: { '20D': -0.68, '60D': -0.73, '1Y': -0.61 }, regime: 'Duration hedge', note: 'Strong inverse relationship' },
  { left: 'AUD', right: 'Metals', values: { '20D': 0.51, '60D': 0.69, '1Y': 0.56 }, regime: 'China sensitivity', note: 'Pro-cyclical confirmation' },
  { left: 'JPY', right: 'Global risk', values: { '20D': -0.48, '60D': -0.64, '1Y': -0.52 }, regime: 'Risk-off hedge', note: 'Hedge behavior persistent' },
  { left: 'Credit spreads', right: 'Equities', values: { '20D': -0.71, '60D': -0.78, '1Y': -0.66 }, regime: 'Stress transmission', note: 'Primary warning signal' },
];

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

const fxPositioning = [
  ['COT futures', 'USD long', '72', 'Crowded'],
  ['Risk reversals', 'USD calls bid', '64', 'Supportive'],
  ['FX options skew', 'USD upside', '58', 'Moderate'],
  ['Implied volatility', '7.4%', '43', 'Contained'],
  ['Realized volatility', '6.8%', '38', 'Low'],
  ['Cross-currency basis', 'Calm', '29', 'No stress'],
  ['Funding stress', 'Low', '24', 'Calm'],
];

const fxCommodityLinks = [
  ['AUD', 'Industrial metals', '+0.69', 'Aligned', 'Leads by 3d'],
  ['AUD', 'Iron ore', '+0.74', 'Aligned', 'Concurrent'],
  ['CAD', 'WTI oil', '+0.71', 'Aligned', 'Lags by 1d'],
  ['NZD', 'Agriculture', '+0.48', 'Diverging', 'Lags by 4d'],
  ['NOK', 'Brent oil', '+0.67', 'Aligned', 'Leads by 2d'],
];

const fxRotationSignals = [
  ['AUD/JPY', 'Global risk appetite', 'Positive lead', 'Risk-on'],
  ['USD/BRL', 'Emerging-market stress', 'Rising warning', 'Risk-off'],
  ['JPY strength', 'Deleveraging', 'No signal', 'Neutral'],
  ['USD strength', 'EM fund flows', 'Outflow risk', 'Risk-off'],
];

const heatmapColumns = [
  ['score', 'Score'],
  ['regime', 'Regime'],
  ['alignment', 'Alignment'],
  ['trend', 'Trend'],
  ['crowding', 'Crowding'],
  ['volatility', 'Volatility'],
  ['liquidity', 'Liquidity'],
];

const heatmapAssets = [
  { symbol: 'BTC', name: 'Bitcoin', group: 'Crypto', score: 81, regime: 'Risk-on', regimeTone: 'positive', alignment: 'High', alignmentTone: 'positive', trend: 'Uptrend', trendTone: 'positive', crowding: 'Elevated', crowdingTone: 'caution', volatility: 'High', volatilityTone: 'caution', liquidity: 'Deep', liquidityTone: 'positive', note: 'Liquidity-sensitive beta remains well supported.' },
  { symbol: 'SPX', name: 'S&P 500', group: 'US indices', score: 74, regime: 'Risk-on', regimeTone: 'positive', alignment: 'High', alignmentTone: 'positive', trend: 'Uptrend', trendTone: 'positive', crowding: 'High', crowdingTone: 'caution', volatility: 'Low', volatilityTone: 'positive', liquidity: 'Deep', liquidityTone: 'positive', note: 'Breadth and credit remain aligned with the advance.' },
  { symbol: 'NDX', name: 'Nasdaq 100', group: 'US indices', score: 77, regime: 'Risk-on', regimeTone: 'positive', alignment: 'High', alignmentTone: 'positive', trend: 'Uptrend', trendTone: 'positive', crowding: 'High', crowdingTone: 'caution', volatility: 'Moderate', volatilityTone: 'neutral', liquidity: 'Deep', liquidityTone: 'positive', note: 'AI leadership persists, though positioning is extended.' },
  { symbol: 'SX5E', name: 'Euro Stoxx 50', group: 'European indices', score: 58, regime: 'Constructive', regimeTone: 'positive', alignment: 'Medium', alignmentTone: 'neutral', trend: 'Uptrend', trendTone: 'positive', crowding: 'Balanced', crowdingTone: 'neutral', volatility: 'Low', volatilityTone: 'positive', liquidity: 'Deep', liquidityTone: 'positive', note: 'Improving growth impulse offsets a softer rate outlook.' },
  { symbol: 'NKY', name: 'Nikkei 225', group: 'Japan', score: 66, regime: 'Constructive', regimeTone: 'positive', alignment: 'High', alignmentTone: 'positive', trend: 'Uptrend', trendTone: 'positive', crowding: 'Balanced', crowdingTone: 'neutral', volatility: 'Moderate', volatilityTone: 'neutral', liquidity: 'Deep', liquidityTone: 'positive', note: 'Currency policy and corporate reform remain supportive.' },
  { symbol: 'CSI', name: 'CSI 300', group: 'China', score: 49, regime: 'Neutral', regimeTone: 'neutral', alignment: 'Low', alignmentTone: 'negative', trend: 'Range', trendTone: 'neutral', crowding: 'Light', crowdingTone: 'positive', volatility: 'Moderate', volatilityTone: 'neutral', liquidity: 'Deep', liquidityTone: 'positive', note: 'The credit impulse is improving, but follow-through is uneven.' },
  { symbol: 'IBOV', name: 'Ibovespa', group: 'LatAm', score: 55, regime: 'Constructive', regimeTone: 'positive', alignment: 'Medium', alignmentTone: 'neutral', trend: 'Range', trendTone: 'neutral', crowding: 'Light', crowdingTone: 'positive', volatility: 'High', volatilityTone: 'caution', liquidity: 'Moderate', liquidityTone: 'neutral', note: 'Commodity support is balanced by dollar sensitivity.' },
  { symbol: 'XAU', name: 'Gold', group: 'Metals', score: 68, regime: 'Constructive', regimeTone: 'positive', alignment: 'High', alignmentTone: 'positive', trend: 'Uptrend', trendTone: 'positive', crowding: 'Elevated', crowdingTone: 'caution', volatility: 'Moderate', volatilityTone: 'neutral', liquidity: 'Deep', liquidityTone: 'positive', note: 'Real-rate and central-bank demand support the trend.' },
  { symbol: 'XAG', name: 'Silver', group: 'Metals', score: 62, regime: 'Constructive', regimeTone: 'positive', alignment: 'Medium', alignmentTone: 'neutral', trend: 'Uptrend', trendTone: 'positive', crowding: 'Balanced', crowdingTone: 'neutral', volatility: 'High', volatilityTone: 'caution', liquidity: 'Moderate', liquidityTone: 'neutral', note: 'Industrial demand provides a higher-beta gold expression.' },
  { symbol: 'DXY', name: 'U.S. Dollar', group: 'FX', score: 64, regime: 'Strength', regimeTone: 'positive', alignment: 'High', alignmentTone: 'positive', trend: 'Uptrend', trendTone: 'positive', crowding: 'Elevated', crowdingTone: 'caution', volatility: 'Low', volatilityTone: 'positive', liquidity: 'Deep', liquidityTone: 'positive', note: 'Rate differentials and safe-haven asymmetry remain supportive.' },
  { symbol: 'SPX OPT', name: 'SPX options positioning', group: 'Options', score: 43, regime: 'Guarded', regimeTone: 'negative', alignment: 'Low', alignmentTone: 'negative', trend: 'Range', trendTone: 'neutral', crowding: 'High', crowdingTone: 'caution', volatility: 'Suppressed', volatilityTone: 'caution', liquidity: 'Deep', liquidityTone: 'positive', note: 'Dealer gamma is supportive, but leaves little room for a volatility shock.' },
];

const preciousMetalAssets = [
  { symbol: 'XAU', name: 'Gold', type: 'Metal', price: '$2,386.10', change: '+1.22%', score: 74, regime: 'Constructive', color: '#d2a644', values: [14, 18, 17, 23, 21, 29, 28, 34, 31, 38, 37, 43] },
  { symbol: 'XAG', name: 'Silver', type: 'Metal', price: '$28.72', change: '+1.85%', score: 68, regime: 'Constructive', color: '#b6c5d2', values: [12, 16, 13, 19, 17, 25, 22, 30, 27, 34, 31, 39] },
  { symbol: 'XPT', name: 'Platinum', type: 'Metal', price: '$1,003.20', change: '+0.48%', score: 53, regime: 'Neutral', color: '#a8aeba', values: [20, 18, 22, 21, 24, 23, 27, 25, 28, 27, 30, 29] },
  { symbol: 'XPD', name: 'Palladium', type: 'Metal', price: '$986.40', change: '-0.62%', score: 42, regime: 'Guarded', color: '#879291', values: [38, 36, 34, 32, 33, 29, 27, 28, 24, 23, 20, 18] },
];

const minerEtfs = [
  ['GDX', 'VanEck Gold Miners', '+2.01%', 'positive'],
  ['GDXJ', 'VanEck Junior Gold Miners', '+2.44%', 'positive'],
  ['SIL', 'Global X Silver Miners', '+1.61%', 'positive'],
  ['SILJ', 'Amplify Junior Silver Miners', '+1.98%', 'positive'],
];

const metalTechnicalIndicators = [
  ['RSI (14)', '63', 'Constructive', 'positive'],
  ['RSI divergence', 'None', 'Confirmed', 'positive'],
  ['Stochastic RSI', '78', 'Elevated', 'caution'],
  ['MACD', 'Bullish', 'Rising', 'positive'],
  ['Moving averages', '5/5', 'Above key MAs', 'positive'],
  ['DeMark', '8', 'Setup maturing', 'neutral'],
  ['Volume', '+18%', 'Above 20D avg.', 'positive'],
  ['KAMA', 'Up', 'Trend intact', 'positive'],
  ['Donchian', 'Upper', 'Breakout zone', 'positive'],
  ['ATR (14)', '1.6%', 'Orderly', 'neutral'],
  ['Gold/Silver ratio', '83.1', 'Favors silver beta', 'positive'],
];

const metalMacroIndicators = [
  ['Real yields', 'Supportive', 'Falling impulse', 'positive'],
  ['Nominal yields', 'Neutral', 'Range-bound', 'neutral'],
  ['Inflation expectations', 'Supportive', 'Firming breakevens', 'positive'],
  ['DXY', 'Headwind', 'Dollar breakout risk', 'negative'],
  ['Central-bank policy', 'Supportive', 'Easing bias broadens', 'positive'],
  ['Global liquidity', 'Expansion', 'Broadening impulse', 'positive'],
  ['Risk-off flows', 'Supportive', 'Hedge demand present', 'positive'],
  ['Commodity regime', 'Constructive', 'Broad complex stable', 'positive'],
];

const metalFlows = [
  ['Gold ETF holdings', '83.2M oz', '+0.18M', 'positive'],
  ['Silver ETF holdings', '675M oz', '+1.4M', 'positive'],
  ['Daily ETF flows', '$184M', 'Net inflow', 'positive'],
  ['Institutional demand', 'Firm', 'Allocators adding', 'positive'],
  ['Central-bank purchases', 'High', 'Persistent buyer base', 'positive'],
  ['Central-bank sales', 'Low', 'No material supply', 'neutral'],
];

const physicalMarket = [
  ['LBMA vs futures', 'Normal', 'No dislocation', 'positive'],
  ['Spot/futures spread', '+0.12%', 'Orderly carry', 'neutral'],
  ['Futures basis', 'Positive', 'Within range', 'neutral'],
  ['Physical premiums', 'Firm', 'Asia demand stable', 'positive'],
  ['Supply stress', 'Low', 'Refining flows normal', 'positive'],
  ['Delivery stress', 'Low', 'Exchange stocks ample', 'positive'],
];

const metalCosts = [
  ['Oil', '$78.40', 'Input cost contained', 'positive'],
  ['Natural gas', '$2.11', 'Below 1Y median', 'positive'],
  ['Mining margins', 'Expanding', 'Gold price outpaces AISC', 'positive'],
  ['Producer cost pressure', 'Moderate', 'Labor remains the watch item', 'neutral'],
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

function LiquidityHistoryChart({ history, range, onRangeChange, expanded = false }) {
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
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Calculated net US liquidity from ${points[0].date} through ${points.at(-1).date}`}>
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

function LiquidityChartDialog({ history, onClose }) {
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
      <header><div><p className="section-kicker">HISTORICAL MODEL INSPECTOR</p><h2 id="liquidity-dialog-title">Calculated net US liquidity</h2><p>Move across the chart to inspect a date. Click or tap to pin the observation for comparison.</p></div><button className="liquidity-dialog-close" onClick={onClose} aria-label="Close liquidity chart">×</button></header>
      <LiquidityHistoryChart history={history} range={range} onRangeChange={setRange} expanded />
    </section>
  </div>;
}

function App() {
  const [activeNav, setActiveNav] = React.useState('Overview');
  const [period, setPeriod] = React.useState('1D');
  const [selectedTicker, setSelectedTicker] = React.useState('NVDA');
  const [theme, setTheme] = React.useState(() => window.localStorage.getItem('tradegate-theme') ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [commandIndex, setCommandIndex] = React.useState(0);
  const searchInputRef = React.useRef(null);
  const platformData = usePlatformData();
  const history = useMarketHistory(selectedTicker, period);
  const technical = useTechnicalAnalytics(selectedTicker);
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
    { label: 'Macro research', detail: 'Workspace', action: () => setActiveNav('Macro') },
    ...watchlist.map((asset) => ({ label: asset.ticker, detail: asset.name, action: () => { setSelectedTicker(asset.ticker); setActiveNav('Overview'); } })),
  ];
  const matchingCommands = commands.filter((command) => `${command.label} ${command.detail}`.toLowerCase().includes(searchQuery.toLowerCase()));

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem('tradegate-theme', theme);
  }, [theme]);

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
          {activeNav === 'Macro' ? <MacroDashboard data={platformData} /> : activeNav === 'Markets' ? <MarketsDashboard data={platformData} /> : activeNav === 'Equities' ? <EquitiesDashboard /> : activeNav === 'Metals' ? <MetalsDashboard data={platformData} /> : ['Screener', 'Watchlists'].includes(activeNav) ? <PreviewWorkspace name={activeNav} /> : <>
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
            <article className="watchlist-card panel preview-section"><div className="card-heading"><div><p className="section-kicker">LIVE PRICES · PREVIEW SPARKLINES</p><h3>Watchlist</h3></div><button>View all <span>→</span></button></div><div className="watchlist-table">{hydratedWatchlist.map((item, index) => <button className={`watch-row ${selectedTicker === item.ticker ? 'watch-selected' : ''}`} onClick={() => setSelectedTicker(item.ticker)} key={item.ticker}><span className="asset-badge" style={{ backgroundColor: item.color }}>{item.ticker.charAt(0)}</span><span className="asset-name"><b>{item.ticker}</b><small>{item.name}</small></span><span className="mini-chart"><Sparkline color={item.color} values={[8 + index, 18, 13, 26, 21, 32, 27, 37, 34, 42]} /></span><span className="asset-price"><b>{formatUsd(item.quote?.price)}</b><small className={item.quote?.changePercent < 0 ? 'negative' : ''}>{formatPercent(item.quote?.changePercent)}{item.quote?.stored ? ' · stored' : ''}</small></span></button>)}</div></article>
            <article className="news-card panel preview-section"><div className="card-heading"><div><p className="section-kicker">WHAT MATTERS</p><h3>Market intelligence</h3></div><button>All news <span>→</span></button></div><div className="news-list">{news.map(([source, title, time]) => <article className="news-item" key={title}><div><p><span>{source}</span> <small>{time}</small></p><h4>{title}</h4></div><span className="news-arrow">↗</span></article>)}</div></article>
          </section>
          <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
          </>}
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
  const configured = Object.values(data.health?.providers ?? {}).filter((provider) => provider.configured).length;
  return <span className={`data-status ${data.status}`} title={data.error ?? `${configured} providers configured`}><i></i>{labels[data.status]}</span>;
}

function DataDisclosure({ data, message }) {
  const title = data.status === 'offline' ? 'Data service offline' : data.status === 'partial' ? 'Provider coverage is partial' : data.status === 'loading' ? 'Connecting to data service' : 'Provider data connected';
  return <section className={`data-disclosure ${data.status}`}><span className="data-disclosure-icon">{data.status === 'live' ? '✓' : 'i'}</span><div><b>{title}</b><p>{message}</p></div></section>;
}

function PreviewBadge({ label = 'Preview' }) {
  return <span className="preview-badge">{label}</span>;
}

function PreviewWorkspace({ name }) {
  return <div className="preview-workspace"><section className="markets-intro"><div><p className="eyebrow">DESIGNED WORKSPACE</p><h1>{name}</h1><p className="intro">This workspace is visible for product review but does not publish research outputs yet.</p></div><PreviewBadge /></section><article className="preview-placeholder panel"><PreviewBadge /><span>◌</span><h2>{name} is a preview.</h2><p>Provider inputs, calculations, source lineage, and tests must be connected before values appear here.</p></article><p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p></div>;
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

function EquitiesDashboard() {
  const [selectedSymbol, setSelectedSymbol] = React.useState('SPY');
  const research = useEquityResearch(selectedSymbol);
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
    </section>

    <section className="equity-regime-layout">
      <article className="equity-driver-panel panel"><div className="panel-title"><div><p className="section-kicker">REGIME INPUTS</p><h3>{regime?.regime ?? 'Waiting for minimum coverage'}</h3></div><EquityStatus status={regime?.status} label={regime ? `${regime.coverage}% coverage` : 'unavailable'} /></div><div className="equity-driver-list">{(regime?.drivers ?? []).map((driver) => <div key={driver.key}><span><b>{driver.name}</b><small>{driver.source ?? 'Source unavailable'}</small></span><i><b style={{ width: `${driver.score ?? 0}%` }}></b></i><strong>{driver.score ?? '—'}</strong></div>)}</div></article>
      <article className="equity-settings-panel panel"><div className="panel-title"><div><p className="section-kicker">DYNAMIC PLAYBOOK</p><h3>Regime-dependent settings</h3></div><span className="data-pill">{regime?.version ?? 'No model'}</span></div>{regime?.settings ? <div className="equity-settings"><div><span>Alert threshold</span><b>{regime.settings.alertThreshold}/100</b></div><div><span>Holding period</span><b>{regime.settings.holdingPeriod}</b></div><div><span>Trend / momentum</span><b>{regime.settings.trend}% / {regime.settings.momentum}%</b></div><div><span>Mean reversion</span><b>{regime.settings.meanReversion}%</b></div><div><span>Defensive / macro</span><b>{regime.settings.defensive}% / {regime.settings.macro}%</b></div></div> : <div className="equity-empty">Settings are not published without a regime.</div>}<p>Weights, thresholds, and expected holding periods change with the classified regime; one static model is not applied across all conditions.</p></article>
    </section>

    <section className="equity-section-heading"><div><p className="section-kicker">SECTOR AND SUBSECTOR ROTATION</p><h2>Relative strength with stored history</h2></div><EquityStatus status={rotation?.status} /></section>
    <section className="equity-sector-layout">
      <article className="equity-rotation-panel panel"><div className="equity-rotation-head"><span>Rank</span><span>Sector</span><span>Quadrant</span><span>20D vs SPY</span><span>60D vs SPY</span><span>Score</span></div>{rotation?.sectors?.length ? rotation.sectors.map((sector) => <div className="equity-rotation-row" key={sector.symbol}><b>{sector.rank}</b><span><strong>{sector.name}</strong><small>{sector.symbol} · {sector.sensitivity}</small></span><i className={sector.quadrant.toLowerCase()}>{sector.quadrant}</i><span className={sector.relative20 >= 0 ? 'positive' : 'negative'}>{formatPercent(sector.relative20)}</span><span className={sector.relative60 >= 0 ? 'positive' : 'negative'}>{formatPercent(sector.relative60)}</span><b>{sector.score}</b></div>) : <div className="equity-empty">{sectorData?.storage?.configured ? 'Run the daily history ingestion to calculate sector rotation.' : 'PostgreSQL history is required for sector rotation.'}</div>}<p className="equity-source-line">{sectorData?.methodology ?? 'Awaiting sector API.'}</p></article>
      <article className="equity-sector-coverage panel"><div className="panel-title"><div><p className="section-kicker">HISTORY READINESS</p><h3>Sectors and subsectors</h3></div><span className="data-pill">Twelve Data</span></div><div className="equity-coverage-list">{(sectorData?.sectors ?? []).map((sector) => <div key={sector.symbol}><span><b>{sector.symbol}</b><small>{sector.name}</small></span><EquityStatus status={sector.coverage.status} label={`${sector.coverage.observations} obs.`} /></div>)}</div><details><summary>Subsector coverage ({sectorData?.subsectors?.length ?? 0})</summary><div className="equity-subsector-list">{(sectorData?.subsectors ?? []).map((sector) => <div key={sector.symbol}><span>{sector.symbol}</span><b>{sector.name}</b><small>{sector.coverage.status}</small></div>)}</div></details></article>
    </section>

    <section className="equity-section-heading"><div><p className="section-kicker">PARTICIPATION AND POSITIONING</p><h2>Inputs required for reliable extremes</h2></div><EquityStatus status="unavailable" label="Feeds pending" /></section>
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

function heatmapCellTone(asset, key) {
  if (key === 'score') return asset.score >= 65 ? 'positive' : asset.score >= 50 ? 'neutral' : 'negative';
  return asset[`${key}Tone`] ?? 'neutral';
}

function MarketsDashboard({ data }) {
  const [group, setGroup] = React.useState('All');
  const [timeframe, setTimeframe] = React.useState('1W');
  const [activeMetric, setActiveMetric] = React.useState('score');
  const [selectedSymbol, setSelectedSymbol] = React.useState('BTC');
  const groups = ['All', 'Crypto', 'US indices', 'European indices', 'Japan', 'China', 'LatAm', 'Metals', 'FX', 'Options'];
  const visibleAssets = group === 'All' ? heatmapAssets : heatmapAssets.filter((asset) => asset.group === group);
  const selectedAsset = heatmapAssets.find((asset) => asset.symbol === selectedSymbol) ?? heatmapAssets[0];
  const activeColumn = heatmapColumns.find(([key]) => key === activeMetric) ?? heatmapColumns[0];

  return <div className="markets-dashboard">
    <section className="markets-intro">
      <div><p className="eyebrow">MULTI-ASSET INTELLIGENCE</p><h1>See the market before it moves.</h1><p className="intro">A single scorecard for regime, participation, positioning, and market quality.</p></div>
      <div className="markets-status"><PreviewBadge /><div><b>11 designed markets</b><small>Values are not live signals</small></div></div>
    </section>
    <DataDisclosure data={data} message="This heatmap is still a model preview. Live prices are connected at the platform layer; regime, alignment, crowding, volatility, and liquidity calculations are next in the pipeline." />

    <section className="heatmap-summary-grid">
      <article className="heatmap-hero panel preview-section"><div><p className="section-kicker">CROSS-ASSET REGIME</p><h2>Broadly constructive <span className="status-dot"></span></h2><p>Risk assets, metals, and the dollar remain mostly aligned. Crowding is the constraint.</p></div><div className="regime-distribution"><span className="positive">5</span><span className="neutral">4</span><span className="negative">2</span><small>Constructive</small><small>Neutral</small><small>Guarded</small></div></article>
      <article className="heatmap-stat panel preview-section"><p className="section-kicker">ALIGNMENT</p><b>73<span>/100</span></b><p>Trend and macro agreement</p><i><span style={{ width: '73%' }}></span></i></article>
      <article className="heatmap-stat panel preview-section"><p className="section-kicker">CROWDING</p><b>61<span>/100</span></b><p>Risk appetite is elevated</p><i className="amber"><span style={{ width: '61%' }}></span></i></article>
      <article className="heatmap-stat panel preview-section"><p className="section-kicker">MARKET QUALITY</p><b>76<span>/100</span></b><p>Liquidity remains resilient</p><i><span style={{ width: '76%' }}></span></i></article>
    </section>

    <section className="heatmap-heading"><div><p className="section-kicker">MARKET MATRIX</p><h2>Multi-asset heatmap <PreviewBadge /></h2></div><div className="heatmap-controls"><div className="group-filter">{groups.map((item) => <button className={group === item ? 'active' : ''} key={item} onClick={() => setGroup(item)}>{item}</button>)}</div><div className="window-buttons">{['1D', '1W', '1M'].map((item) => <button className={timeframe === item ? 'selected' : ''} key={item} onClick={() => setTimeframe(item)}>{item}</button>)}</div></div></section>

    <section className="heatmap-workspace">
      <article className="heatmap-panel panel preview-section"><div className="heatmap-legend"><span><i className="positive"></i>Supportive</span><span><i className="neutral"></i>Mixed</span><span><i className="negative"></i>Guarded</span><small>{timeframe} model window</small></div><div className="heatmap-scroll"><div className="heatmap-table"><div className="heatmap-table-head"><span>Market</span>{heatmapColumns.map(([key, label]) => <button className={activeMetric === key ? 'metric-active' : ''} key={key} onClick={() => setActiveMetric(key)}>{label}</button>)}</div>{visibleAssets.map((asset) => <button className={`heatmap-row ${selectedAsset.symbol === asset.symbol ? 'asset-selected' : ''}`} onClick={() => setSelectedSymbol(asset.symbol)} key={asset.symbol}><span className="heatmap-asset"><b>{asset.symbol}</b><small>{asset.name}</small></span>{heatmapColumns.map(([key]) => <span className={`heatmap-cell ${heatmapCellTone(asset, key)} ${activeMetric === key ? 'metric-active' : ''}`} key={key}>{key === 'score' ? asset.score : asset[key]}</span>)}</button>)}</div></div></article>
      <article className="heatmap-detail panel preview-section"><div className="panel-title"><div><p className="section-kicker">SELECTED MARKET</p><h3>{selectedAsset.name}</h3></div><span className={`market-symbol ${selectedAsset.group.toLowerCase().replace(' ', '-')}`}>{selectedAsset.symbol}</span></div><div className="detail-score"><span>{activeColumn[1]} signal</span><b className={heatmapCellTone(selectedAsset, activeMetric)}>{activeMetric === 'score' ? selectedAsset.score : selectedAsset[activeMetric]}</b><small>{selectedAsset.regime} regime</small></div><div className="detail-metrics">{heatmapColumns.filter(([key]) => key !== activeMetric).map(([key, label]) => <div key={key}><span>{label}</span><b className={heatmapCellTone(selectedAsset, key)}>{key === 'score' ? selectedAsset.score : selectedAsset[key]}</b></div>)}</div><div className="heatmap-callout"><span>Model read</span><p>{selectedAsset.note}</p></div><button className="source-link">Open {selectedAsset.symbol} research →</button></article>
    </section>

    <section className="heatmap-bottom-grid">
      <article className="heatmap-method panel preview-section"><p className="section-kicker">MODEL DISCIPLINES</p><h3>One screen, seven lenses.</h3><p>Scores combine trend, cross-market alignment, positioning, volatility, and liquidity rather than relying on price direction alone.</p><div><span>Score</span><span>Regime</span><span>Alignment</span><span>Trend</span><span>Crowding</span><span>Volatility</span><span>Liquidity</span></div></article>
      <article className="heatmap-alert panel preview-section"><p className="section-kicker">WATCHLIST ALERT</p><h3>Options positioning is the weak link.</h3><p>Suppressed volatility and elevated dealer gamma can turn a quiet market into an unstable one if the index breaks its range.</p><button>Review positioning →</button></article>
    </section>
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
  </div>;
}

function MetalsDashboard({ data }) {
  const [selectedSymbol, setSelectedSymbol] = React.useState('XAU');
  const [horizon, setHorizon] = React.useState('1M');
  const selectedMetal = preciousMetalAssets.find((asset) => asset.symbol === selectedSymbol) ?? preciousMetalAssets[0];

  return <div className="metals-dashboard">
    <section className="metals-intro">
      <div><p className="eyebrow">PRECIOUS METALS RESEARCH</p><h1>Where monetary metal meets market structure.</h1><p className="intro">Technical, macro, physical, and positioning signals for metals and their equity proxies.</p></div>
      <div className="metals-pulse"><PreviewBadge /><div><b>Designed metals workspace</b><small>Values are not provider-backed yet</small></div></div>
    </section>
    <DataDisclosure data={data} message="Prices, technical readings, COT positioning, ETF flows, physical-market indicators, and cost metrics in this Metals workspace are still prototype values until their dedicated feeds are connected." />

    <section className="metal-asset-strip preview-section">{preciousMetalAssets.map((asset) => <button className={`metal-asset ${selectedMetal.symbol === asset.symbol ? 'selected' : ''}`} onClick={() => setSelectedSymbol(asset.symbol)} key={asset.symbol}><span className="metal-symbol" style={{ '--metal-color': asset.color }}>{asset.symbol}</span><span><b>{asset.name}</b><small>{asset.regime}</small></span><span className="metal-price"><b>{asset.price}</b><small className={asset.change.startsWith('-') ? 'negative' : 'positive'}>{asset.change}</small></span><span className="metal-spark"><Sparkline color={asset.color} values={asset.values} /></span></button>)}</section>

    <section className="metals-focus-heading"><div><p className="section-kicker">{selectedMetal.symbol} RESEARCH MAP</p><h2>{selectedMetal.name} <span>·</span> {selectedMetal.regime} <PreviewBadge /></h2></div><div className="window-buttons">{['1W', '1M', '3M'].map((item) => <button className={horizon === item ? 'selected' : ''} key={item} onClick={() => setHorizon(item)}>{item}</button>)}</div></section>

    <section className="metals-primary-grid">
      <article className="metal-price-panel panel preview-section"><div className="panel-title"><div><p className="section-kicker">PRICE AND TECHNICALS</p><h3>Trend has room to run.</h3></div><span className="data-pill">{horizon} window</span></div><div className="metal-quote"><b>{selectedMetal.price}</b><span className="positive">{selectedMetal.change}</span><small>USD per troy ounce</small></div><div className="metal-chart"><Sparkline color={selectedMetal.color} values={[12, 14, 13, 17, 16, 22, 20, 26, 24, 30, 28, 35, 33, 39, 37, 45, 43, 49, 48, 54]} /></div><div className="technical-grid">{metalTechnicalIndicators.map(([name, value, detail, tone]) => <div className="technical-item" key={name}><span>{name}</span><b className={tone}>{value}</b><small>{detail}</small></div>)}</div></article>
      <article className="metal-macro-panel panel preview-section"><div className="panel-title"><div><p className="section-kicker">METALS MACRO SCORE</p><h3>Monetary backdrop remains supportive.</h3></div><span className="macro-score">78</span></div><div className="metal-macro-list">{metalMacroIndicators.map(([name, state, detail, tone]) => <div className="metal-macro-row" key={name}><div><b>{name}</b><small>{detail}</small></div><span className={tone}>{state}</span></div>)}</div><div className="macro-conclusion"><span>Model conclusion</span><p>Falling real-yield impulse and expanding liquidity outweigh the DXY headwind.</p></div></article>
    </section>

    <section className="metals-section-heading"><div><p className="section-kicker">FLOWS AND POSITIONING</p><h2>Who owns the trade, and where is demand coming from? <PreviewBadge /></h2></div><span className="data-pill">Designed values</span></section>
    <section className="metals-flow-grid">
      <article className="positioning-panel panel preview-section"><div className="panel-title"><div><p className="section-kicker">CFTC COT</p><h3>Positioning is firm, not extreme.</h3></div><span className="positioning-percentile">72<span>th pct.</span></span></div><div className="positioning-rows"><div><span>Commercial positioning</span><i><b className="commercial" style={{ width: '41%' }}></b></i><small>41</small></div><div><span>Managed Money</span><i><b className="managed" style={{ width: '72%' }}></b></i><small>72</small></div><div><span>Producers</span><i><b className="producer" style={{ width: '34%' }}></b></i><small>34</small></div><div><span>Swap Dealers</span><i><b className="swap" style={{ width: '47%' }}></b></i><small>47</small></div><div><span>Speculator extremes</span><i><b className="speculator" style={{ width: '68%' }}></b></i><small>68</small></div></div><div className="positioning-note"><b>Positioning percentile</b><span>Elevated long exposure, but below historical blow-off thresholds.</span></div></article>
      <article className="metal-flows-panel panel preview-section"><div className="panel-title"><div><p className="section-kicker">FLOWS AND OFFICIAL DEMAND</p><h3>ETF and central-bank demand</h3></div><span className="data-pill">Daily</span></div>{metalFlows.map(([name, value, detail, tone]) => <div className="metal-flow-row" key={name}><div><b>{name}</b><small>{detail}</small></div><span className={tone}>{value}</span></div>)}</article>
      <article className="physical-market-panel panel preview-section"><div className="panel-title"><div><p className="section-kicker">PHYSICAL VS PAPER</p><h3>Market plumbing is orderly.</h3></div><span className="data-pill">Spot / futures</span></div>{physicalMarket.map(([name, value, detail, tone]) => <div className="physical-row" key={name}><div><b>{name}</b><small>{detail}</small></div><span className={tone}>{value}</span></div>)}</article>
    </section>

    <section className="metals-bottom-grid">
      <article className="miners-panel panel preview-section"><div className="panel-title"><div><p className="section-kicker">MINER EQUITY EXPRESSION</p><h3>Relevant miner ETFs</h3></div><button>Compare miners →</button></div><div className="miner-list">{minerEtfs.map(([ticker, name, change, tone]) => <button key={ticker}><span>{ticker}</span><b>{name}</b><small className={tone}>{change}</small><i>↗</i></button>)}</div><p>Miners add operating leverage to metal prices, but input costs and equity-beta remain separate risks.</p></article>
      <article className="metal-costs-panel panel preview-section"><div className="panel-title"><div><p className="section-kicker">METALS COST STRUCTURE</p><h3>Margins are expanding.</h3></div><span className="data-pill">Producer lens</span></div>{metalCosts.map(([name, value, detail, tone]) => <div className="metal-cost-row" key={name}><div><b>{name}</b><small>{detail}</small></div><span className={tone}>{value}</span></div>)}<div className="cost-callout"><span>What matters next</span><p>A sustained oil or labor-cost shock would compress producer margins before it reaches spot metals.</p></div></article>
    </section>
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
  </div>;
}

function MacroDashboard({ data }) {
  const [activeModel, setActiveModel] = React.useState('Liquidity');
  const [correlationWindow, setCorrelationWindow] = React.useState('60D');
  const [fxHorizon, setFxHorizon] = React.useState('1M');
  const [liquidityChartOpen, setLiquidityChartOpen] = React.useState(false);
  const liquidityModel = data.liquidity?.model;
  const globalLiquidity = data.liquidity?.globalLiquidity;
  const usdStrength = data.liquidity?.usdStrength;
  const macroRegime = data.liquidity?.macroRegime;
  const usdDrivers = Object.fromEntries((usdStrength?.drivers ?? []).map((driver) => [driver.key, driver]));
  const liquidityHistory = normalizeSparkline(liquidityModel?.history?.map((point) => point.value) ?? []);
  const globalLiquidityHistory = normalizeSparkline(globalLiquidity?.history?.map((point) => point.value) ?? []);
  const dxyBtcModel = data.dxyBtc?.model;
  const dxyBtcCorrelationValue = dxyBtcModel?.correlations?.[correlationWindow];
  const dxyHistory = normalizeSparkline(dxyBtcModel?.history?.left ?? []);
  const bitcoinHistory = normalizeSparkline(dxyBtcModel?.history?.right ?? []);

  return <div className="macro-dashboard">
    <section className="macro-intro">
      <div><p className="eyebrow">MACRO RESEARCH SYSTEM</p><h1>Liquidity leads. Risk confirms.</h1><p className="intro">A cross-asset view of the forces shaping capital availability and market regime.</p></div>
      <div className="model-tabs"><button className={activeModel === 'Liquidity' ? 'active' : ''} onClick={() => setActiveModel('Liquidity')}>US liquidity</button><button className={activeModel === 'Global' ? 'active' : ''} onClick={() => setActiveModel('Global')}>Global liquidity</button><button className={activeModel === 'Risk' ? 'active' : ''} onClick={() => setActiveModel('Risk')}>Macro regime</button><button className={activeModel === 'Correlations' ? 'active' : ''} onClick={() => setActiveModel('Correlations')}>Correlations <small className="tab-preview">Preview</small></button><button className={activeModel === 'FX' ? 'active' : ''} onClick={() => setActiveModel('FX')}>USD & FX <small className="tab-preview">Preview mix</small></button></div>
    </section>
    <DataDisclosure data={data} message="US liquidity, USD strength, macro regime, and DXY/BTC are versioned calculations. Every remaining designed value is labeled Preview at its tab or section." />
    {data.liquidity?.series?.length ? <section className="official-data-strip panel"><div><p className="section-kicker">OFFICIAL FRED OBSERVATIONS</p><b>Latest released data</b></div>{data.liquidity.series.slice(0, 5).map((series) => <div key={series.id}><span>{series.name}</span><strong>{formatMacroValue(series)}</strong><small>{series.date}{series.stale ? ' · stale' : series.stored ? ' · stored' : ' · live'}</small></div>)}</section> : <section className="provider-setup-note"><b>FRED macro feed not configured</b><span>Add `FRED_API_KEY` to the server environment to load official liquidity observations.</span></section>}

    <section className="model-overview-grid">
      <article className={`macro-model panel ${activeModel === 'Liquidity' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">US LIQUIDITY MODEL</p><h2>{liquidityModel?.regime ?? 'Awaiting FRED'} <span className="status-dot"></span></h2><p>{liquidityModel ? 'Fed net liquidity, M2, and dollar transmission' : 'Configure FRED to calculate the regime'}</p></div><div className="score-orbit"><b>{liquidityModel?.score ?? '—'}</b><small>/100</small></div></div>
        <div className="liquidity-chart"><div className="chart-caption"><span>Calculated net liquidity</span><div><strong>{liquidityModel ? formatLiquidityValue(liquidityModel.netLiquidity) : 'Unavailable'}</strong><button className="chart-expand-button" onClick={() => setLiquidityChartOpen(true)} disabled={!liquidityModel?.history?.length} aria-label="Enlarge liquidity history chart">↗</button></div></div>{liquidityHistory.length ? <Sparkline color="#75c966" values={liquidityHistory} /> : <div className="model-chart-empty">No calculated history</div>}<div className="liquidity-axis"><span>Oldest</span><span>Midpoint</span><span>Recent</span><span>Latest</span></div></div>
        <div className="signal-summary"><span>Momentum <b>{liquidityModel?.momentum ?? 'Unavailable'}</b></span><span>Breadth <b>{liquidityModel ? `${liquidityModel.breadth.positive} of ${liquidityModel.breadth.total} positive` : 'Unavailable'}</b></span><span>Confidence <b>{liquidityModel?.confidence ?? 'Unavailable'}</b></span></div>
        <div className="model-action"><span>{liquidityModel?.version ?? 'No model output'}</span><button onClick={() => setActiveModel('Liquidity')}>Open model →</button></div>
      </article>

      <article className={`macro-model panel global-model ${activeModel === 'Global' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">GLOBAL LIQUIDITY MODEL</p><h2>{globalLiquidity?.regime ?? 'Awaiting FRED'} <span className="status-dot violet"></span></h2><p>{globalLiquidity ? 'Fed, ECB, and BoJ balance sheets in USD' : 'Configure FRED to calculate the regime'}</p></div><div className="score-orbit violet-orbit"><b>{globalLiquidity?.score ?? '—'}</b><small>/100</small></div></div>
        <div className="liquidity-chart"><div className="chart-caption"><span>Central-bank liquidity, USD</span><strong>{globalLiquidity ? formatLiquidityValue(globalLiquidity.globalLiquidityUsdMillions) : 'Unavailable'}</strong></div>{globalLiquidityHistory.length ? <Sparkline color="#b08ad6" values={globalLiquidityHistory} /> : <div className="model-chart-empty">No calculated history</div>}<div className="liquidity-axis"><span>Oldest</span><span>Midpoint</span><span>Recent</span><span>Latest</span></div></div>
        <div className="signal-summary"><span>Momentum <b>{globalLiquidity?.momentum ?? 'Unavailable'}</b></span><span>Cycle percentile <b>{Number.isFinite(globalLiquidity?.cyclePercentile) ? `${globalLiquidity.cyclePercentile}%` : 'Unavailable'}</b></span><span>Confidence <b>{globalLiquidity?.confidence ?? 'Unavailable'}</b></span></div>
        <div className="model-action"><span>{globalLiquidity?.version ?? 'No model output'}</span><button onClick={() => setActiveModel('Global')}>Open model →</button></div>
      </article>

      <article className={`macro-model panel risk-model ${activeModel === 'Risk' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">MACRO REGIME · {macroRegime?.status?.toUpperCase() ?? 'UNAVAILABLE'}</p><h2>{macroRegime?.regime ?? 'Awaiting inputs'} <span className="status-dot blue"></span></h2><p>{macroRegime ? `${macroRegime.coverage}% independent-driver coverage` : 'Connect at least two independent FRED sleeves'}</p></div><div className="score-orbit blue-orbit"><b>{macroRegime?.score ?? '—'}</b><small>/100</small></div></div>
        <div className="risk-lanes">{(macroRegime?.drivers ?? []).slice(0, 3).map((driver) => <div key={driver.key}><span>{driver.name}</span><i><b style={{ width: `${driver.score ?? 0}%` }}></b></i><strong>{driver.score ?? '—'}</strong></div>)}</div>
        <div className="signal-summary"><span>Risk budget <b>{macroRegime?.settings?.riskBudget ?? 'Unavailable'}</b></span><span>Confidence <b>{macroRegime?.confidence ?? 'Unavailable'}</b></span><span>Panic <b>{macroRegime?.panicConfirmed === true ? 'Confirmed' : macroRegime?.panicConfirmed === false ? 'Not confirmed' : 'Unavailable'}</b></span></div>
        <div className="model-action"><span>{macroRegime?.version ?? 'No model output'}</span><button onClick={() => setActiveModel('Risk')}>Open model →</button></div>
      </article>
      <article className={`macro-model panel correlation-model preview-section ${activeModel === 'Correlations' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">REGIME CORRELATIONS · PREVIEW</p><h2>7 designed links <span className="status-dot violet"></span></h2><p>Awaiting synchronized stored histories</p></div><div className="correlation-glyph"><span></span><i></i><b></b><em></em></div></div>
        <div className="correlation-preview"><span>Strongest</span><b>Credit spreads <i>↔</i> Equities</b><strong>-0.78</strong><span>Most unstable</span><b>BTC <i>↔</i> S&P 500</b><strong>+0.54</strong></div>
        <div className="model-action"><span>Rolling and regime-adjusted</span><button onClick={() => setActiveModel('Correlations')}>Open map →</button></div>
      </article>
      <article className={`macro-model panel fx-model ${activeModel === 'FX' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">USD STRENGTH · {usdStrength?.status?.toUpperCase() ?? 'UNAVAILABLE'}</p><h2>{usdStrength?.regime ?? 'Awaiting FRED'} <span className="status-dot amber"></span></h2><p>Broad-dollar and connected U.S. macro drivers</p></div><div className="fx-pair-tile"><b>Broad USD</b><strong>{usdStrength?.score ?? '—'}</strong><small>{usdStrength ? `${usdStrength.coverage}% coverage` : 'No model'}</small></div></div>
        <div className="fx-preview"><span>20D momentum</span><b>{formatPercent(usdStrength?.indicators?.momentum20d)}</b><span>Real-yield impulse</span><b className={scoreTone(usdDrivers.realYield?.score)}>{usdDrivers.realYield?.score ?? '—'}</b><span>Dollar smile</span><b>{usdStrength?.dollarSmile ?? 'Unavailable'}</b></div>
        <div className="model-action"><span>{usdStrength?.version ?? 'No model output'}</span><button onClick={() => setActiveModel('FX')}>Open model →</button></div>
      </article>
    </section>

    <section className="macro-section-heading"><div><p className="section-kicker">{activeModel === 'Liquidity' ? 'NET US LIQUIDITY' : activeModel === 'Global' ? 'GLOBAL CENTRAL-BANK LIQUIDITY' : activeModel === 'Risk' ? 'CROSS-ASSET CONFIRMATION' : activeModel === 'Correlations' ? 'RELATIONSHIP INTELLIGENCE' : 'FOREX MACRO PREDICTORS'}</p><h2>{activeModel === 'Liquidity' ? 'The calculated drivers behind the impulse' : activeModel === 'Global' ? 'World central-bank liquidity in dollars' : activeModel === 'Risk' ? 'What markets are pricing now' : activeModel === 'Correlations' ? 'Correlations through the current regime' : 'Where macro points for each currency'} {(activeModel === 'Correlations' || activeModel === 'FX') && <PreviewBadge label="Contains previews" />}</h2></div>{activeModel === 'Liquidity' && <span className="data-pill">13W calculated window</span>}{activeModel === 'Global' && <span className="data-pill">13W calculated window</span>}{activeModel === 'Correlations' && <div className="window-buttons">{['20D', '60D', '1Y'].map((item) => <button className={correlationWindow === item ? 'selected' : ''} key={item} onClick={() => setCorrelationWindow(item)}>{item}</button>)}</div>}{activeModel === 'FX' && <div className="window-buttons">{['1W', '1M', '3M'].map((item) => <button className={fxHorizon === item ? 'selected' : ''} key={item} onClick={() => setFxHorizon(item)}>{item}</button>)}</div>}</section>

    {activeModel === 'Liquidity' ? <section className="liquidity-detail-grid">
      <article className="driver-panel panel"><div className="driver-panel-head"><span>Indicator</span><span>Impulse</span><span>13W change</span></div>{liquidityModel?.drivers?.length ? liquidityModel.drivers.map((driver) => { const tone = driver.impulse > 0.05 ? 'positive' : driver.impulse < -0.05 ? 'negative' : 'neutral'; return <div className="driver-row" key={driver.key}><span>{driver.name}</span><b className={tone}>{driver.impulse > 0.05 ? 'Supportive' : driver.impulse < -0.05 ? 'Restrictive' : 'Neutral'}</b><strong>{driver.changePercent >= 0 ? '+' : ''}{driver.changePercent.toFixed(2)}%</strong></div>; }) : <div className="calculation-empty">No calculated FRED drivers are available.</div>}<p className="model-footnote"><code>us-liquidity-v1</code> uses 55% Fed net liquidity, 25% US M2 growth, and 20% inverse dollar transmission. Inputs retain provider dates and units.</p></article>
      <article className="regional-panel panel"><div className="panel-title"><div><p className="section-kicker">GLOBAL EXTENSION</p><h3>World model calculated</h3></div><span className="data-pill">{globalLiquidity ? `${globalLiquidity.version}` : 'Not calculated'}</span></div>{globalLiquidity ? <div className="calculation-empty regional-empty">The Fed, ECB, and BoJ legs are aggregated in USD. Bank of England and PBoC balance sheets remain excluded until an official machine-readable source is connected.</div> : <div className="calculation-empty regional-empty">ECB and BoJ histories must be ingested and normalized before a global score can be published.</div>}<button className="source-link" onClick={() => setActiveModel('Global')}>Open global model →</button></article>
    </section> : activeModel === 'Global' ? <section className="liquidity-detail-grid">
      <article className="driver-panel panel"><div className="panel-title"><div><p className="section-kicker">GLOBAL LIQUIDITY DRIVERS</p><h3>{globalLiquidity?.regime ?? 'Regime unavailable'} · {globalLiquidity ? formatLiquidityValue(globalLiquidity.globalLiquidityUsdMillions) : 'Unavailable'}</h3></div><span className="data-pill">{globalLiquidity ? `${globalLiquidity.confidence} confidence` : 'Unavailable'}</span></div><div className="driver-panel-head"><span>Indicator</span><span>Impulse</span><span>13W change</span></div>{globalLiquidity?.drivers?.length ? globalLiquidity.drivers.map((driver) => { const tone = driver.impulse > 0.05 ? 'positive' : driver.impulse < -0.05 ? 'negative' : 'neutral'; return <div className="driver-row" key={driver.key}><span>{driver.name}</span><b className={tone}>{driver.impulse > 0.05 ? 'Supportive' : driver.impulse < -0.05 ? 'Restrictive' : 'Neutral'}</b><strong>{Number.isFinite(driver.changePercent) ? `${driver.changePercent >= 0 ? '+' : ''}${driver.changePercent.toFixed(2)}%` : '—'}</strong></div>; }) : <div className="calculation-empty">Fed, ECB, and BoJ balance sheets plus both FX conversion rates are required.</div>}<p className="model-footnote"><code>global-liquidity-v1</code> aggregates Fed, ECB, and BoJ balance sheets converted to USD at matching-date H.10 rates, weighted 40% global impulse, 25% Fed net liquidity, 15% ECB+BoJ impulse, 20% inverse broad dollar.</p></article>
      <article className="regional-panel panel"><div className="panel-title"><div><p className="section-kicker">CENTRAL-BANK BREAKDOWN</p><h3>Balance-sheet contributions</h3></div><span className="data-pill">{globalLiquidity ? `as of ${globalLiquidity.asOf}` : 'Unavailable'}</span></div>{globalLiquidity?.centralBanks?.length ? globalLiquidity.centralBanks.map((leg) => <div className="driver-row" key={leg.key}><span>{leg.name}<small>{leg.asOf}{Number.isFinite(leg.sharePercent) ? ` · ${leg.sharePercent}% of pool` : ''}</small></span><b className={(leg.change91d ?? 0) >= 0 ? 'positive' : 'negative'}>{formatLiquidityValue(leg.valueUsdMillions)}</b><strong>{Number.isFinite(leg.change365d) ? `${leg.change365d >= 0 ? '+' : ''}${leg.change365d.toFixed(2)}% YoY` : '—'}</strong></div>) : <div className="calculation-empty">No central-bank legs are available.</div>}<p className="model-footnote">Cycle percentile {Number.isFinite(globalLiquidity?.cyclePercentile) ? `${globalLiquidity.cyclePercentile}%` : 'unavailable'} of the pooled USD history. BoE and PBoC are documented exclusions, not silent omissions; broad-money feeds on FRED are frozen and cannot be used.</p></article>
    </section> : activeModel === 'Risk' ? <section className="risk-detail-grid">
      <article className="risk-inputs panel"><div className="panel-title"><div><p className="section-kicker">CALCULATED COMPONENTS</p><h3>Independent macro sleeves</h3></div><span className="data-pill">{macroRegime ? `${macroRegime.coverage}% coverage` : 'Unavailable'}</span></div><div className="risk-input-grid">{(macroRegime?.drivers ?? []).map((driver) => <div className="risk-input" key={driver.key}><span className={scoreTone(driver.score)}></span><b>{driver.name}</b><strong>{driver.score ?? '—'}</strong><small>{driver.score === null ? 'Missing' : driver.score > 60 ? 'Supportive' : driver.score < 40 ? 'Restrictive' : 'Balanced'}</small></div>)}</div>{!macroRegime && <div className="calculation-empty">At least two independent macro histories are required.</div>}<p className="model-footnote"><code>macro-regime-v1</code> uses liquidity, financial conditions, credit, volatility, and inverse dollar pressure. Missing: {macroRegime?.missing?.join(', ') || 'none'}.</p></article>
      <article className="regime-panel panel"><div className="panel-title"><div><p className="section-kicker">DYNAMIC REGIME SETTINGS</p><h3>{macroRegime?.regime ?? 'Regime unavailable'}</h3></div><span className="data-pill">{macroRegime?.status ?? 'unavailable'}</span></div>{macroRegime?.settings ? <div className="regime-settings"><div><span>Risk budget</span><b>{macroRegime.settings.riskBudget}</b></div><div><span>Alert threshold</span><b>{macroRegime.settings.alertThreshold}/100</b></div><div><span>Holding period</span><b>{macroRegime.settings.holdingPeriod}</b></div><div><span>Factor emphasis</span><b>{macroRegime.settings.emphasis}</b></div></div> : <div className="calculation-empty">No dynamic settings are published without a regime.</div>}<p className="model-footnote">Stress requires simultaneous VIX, high-yield spread, and financial-condition confirmation. No panic probability is fabricated.</p></article>
    </section> : activeModel === 'Correlations' ? <section className="correlation-detail-grid">
      <article className="correlation-map-panel panel preview-section"><div className="panel-title"><div><p className="section-kicker">{correlationWindow} ROLLING CORRELATION</p><h3>Cross-market relationship map</h3></div><span className="data-pill">Risk-on regime</span></div><div className="correlation-legend"><span><i className="correlation-negative"></i>Inverse</span><span><i className="correlation-neutral"></i>Mixed</span><span><i className="correlation-positive"></i>Positive</span><small>r = Pearson correlation</small></div><div className="correlation-rows">{correlationPairs.map((pair) => { const value = pair.values[correlationWindow]; const tone = correlationTone(value); return <div className="correlation-row" key={`${pair.left}-${pair.right}`}><b>{pair.left}</b><div className="correlation-link"><i className={tone}></i><span></span><i className={tone}></i></div><b>{pair.right}</b><strong className={tone}>{value > 0 ? '+' : ''}{value.toFixed(2)}</strong><small>{pair.regime}</small></div>; })}</div></article>
      <article className="correlation-insight-panel panel preview-section"><p className="section-kicker">REGIME READ</p><h3>Risk links are orderly.</h3><p>Credit and equities retain their usual inverse relationship while BTC remains closely tied to equity appetite. No material correlation breaks are currently flagged.</p><div className="stability-score"><span>Relationship stability</span><div><i><b></b></i><strong>81%</strong></div></div><div className="correlation-watch"><b>Watch for a break</b><span>BTC/SPX below +0.20 or credit/equity above -0.35</span></div></article>
      <article className="correlation-notes panel preview-section"><p className="section-kicker">HOW TO READ THIS</p><div>{correlationPairs.slice(0, 3).map((pair) => <p key={pair.left}><b>{pair.left} / {pair.right}</b><span>{pair.note}</span></p>)}</div><button>Open historical regime study →</button></article>
      <article className="dxy-btc-panel panel"><div className="panel-title"><div><p className="section-kicker">DXY VS BITCOIN · CALCULATED</p><h3>{dxyBtcModel?.interpretation ?? 'Awaiting synchronized histories'}</h3></div><span className="data-pill">{Number.isFinite(dxyBtcCorrelationValue) ? `${correlationWindow} r ${dxyBtcCorrelationValue.toFixed(2)}` : 'Unavailable'}</span></div><div className="dxy-btc-chart"><div><span><i className="dxy-key"></i>{data.dxyBtc?.source?.left?.startsWith('DXY') ? 'DXY' : 'Broad dollar proxy'}</span>{dxyHistory.length ? <Sparkline color="#d3a454" values={dxyHistory} /> : <div className="model-chart-empty">No dollar history</div>}</div><div><span><i className="btc-key"></i>Bitcoin</span>{bitcoinHistory.length ? <Sparkline color="#70c26b" values={bitcoinHistory} /> : <div className="model-chart-empty">No BTC history</div>}</div></div><div className="dxy-btc-diagnostics"><span>Correlation regime <b>{dxyBtcModel?.regime ?? 'Unavailable'}</b></span><span>Momentum relationship <b>{dxyBtcModel?.divergence ?? 'Unavailable'}</b></span><span>Breakout read <b>{dxyBtcModel?.interpretation ?? 'Unavailable'}</b></span></div><p>{dxyBtcModel ? `${dxyBtcModel.version} · ${dxyBtcModel.observations} aligned daily observations · ${data.dxyBtc.source.left} and ${data.dxyBtc.source.right}` : 'Configure Twelve Data or FRED and retain Bitcoin history to calculate this relationship.'}</p></article>
    </section> : <section className="fx-detail-grid">
      <article className="fx-outlook-panel panel preview-section"><div className="panel-title"><div><p className="section-kicker">{fxHorizon} RELATIVE-VALUE OUTLOOK</p><h3>G10 and CNH directional bias</h3></div><span className="data-pill">Macro composite</span></div><div className="fx-outlook-head"><span>Currency</span><span>Bias</span><span>Score</span><span>Dominant driver</span></div>{fxOutlook.map(([currency, bias, score, tone, driver]) => <div className="fx-outlook-row" key={currency}><b>{currency}</b><span className={tone}>{bias}</span><strong>{score}</strong><small>{driver}</small></div>)}</article>
      <article className="fx-predictor-panel panel"><div className="panel-title"><div><p className="section-kicker">USD STRENGTH ENGINE · {usdStrength?.status?.toUpperCase() ?? 'UNAVAILABLE'}</p><h3>Connected FRED driver stack</h3></div><span className="data-pill">{usdStrength ? `${usdStrength.score}/100` : 'Unavailable'}</span></div>{(usdStrength?.drivers ?? []).map((driver) => <div className="fx-predictor-row" key={driver.key}><div><b>{driver.name}</b><small>{driver.source}{Number.isFinite(driver.change) ? ` · change ${driver.change >= 0 ? '+' : ''}${driver.change.toFixed(2)}` : ''}</small></div><span className={scoreTone(driver.score)}>{driver.score ?? '—'}</span></div>)}{!usdStrength && <div className="calculation-empty">Broad-dollar history is required before this model can publish.</div>}<div className="dollar-smile"><b>Dollar Smile <span>{usdStrength?.dollarSmile ?? 'Unavailable'}</span></b><p>{usdStrength?.proxy ?? 'FRED broad-dollar and macro inputs are not available.'}</p><div><span>Global stress</span><i></i><span>Real-yield support</span></div></div></article>
      <article className="fx-positioning-panel panel preview-section"><div className="panel-title"><div><p className="section-kicker">POSITIONING AND VOLATILITY</p><h3>Flow and funding read</h3></div><span className="data-pill">7 lenses</span></div>{fxPositioning.map(([name, signal, score, label]) => <div className="fx-position-row" key={name}><div><b>{name}</b><small>{signal}</small></div><i><b style={{ width: `${score}%` }}></b></i><strong>{score}</strong><span>{label}</span></div>)}</article>
      <article className="fx-scenarios-panel panel preview-section"><p className="section-kicker">USD SCENARIO MAP</p><h3>Three paths, one framework.</h3><div><span>Global stress</span><b>USD, CHF, JPY bid</b></div><div><span>Strong U.S. growth</span><b>USD carry strengthens</b></div><div><span>Weak global growth</span><b>USD defensive premium</b></div><p>Central-bank stance, real rates, and funding stress determine the path weighting.</p></article>
      <article className="fx-commodity-panel panel preview-section"><div className="panel-title"><div><p className="section-kicker">FX COMMODITY LINKS</p><h3>Correlation, divergence, and lead/lag</h3></div><span className="data-pill">60D rolling</span></div><div className="fx-commodity-head"><span>FX</span><span>Linked market</span><span>r</span><span>State</span><span>Timing</span></div>{fxCommodityLinks.map(([currency, market, correlation, state, timing]) => <div className="fx-commodity-row" key={`${currency}-${market}`}><b>{currency}</b><span>{market}</span><strong>{correlation}</strong><i className={state === 'Aligned' ? 'positive' : 'caution'}>{state}</i><small>{timing}</small></div>)}</article>
      <article className="fx-rotation-panel panel preview-section"><p className="section-kicker">FX VS EQUITY ROTATION</p><h3>FX leads the risk handoff.</h3>{fxRotationSignals.map(([signal, market, status, regime]) => <div className="fx-rotation-row" key={signal}><div><b>{signal}</b><small>{market}</small></div><span className={regime.toLowerCase().replace('-', '')}>{status}</span></div>)}<p>Use FX breaks as early confirmation for EM equities, commodity sectors, regional equities, and broad risk rotation.</p></article>
    </section>}

    <section className="macro-bottom-grid">
      <article className="change-panel panel preview-section"><p className="section-kicker">NARRATIVE · MODEL PREVIEW</p><h3>Automated change detection pending.</h3><p className="change-copy">This panel will be generated from persisted model changes after global central-bank and credit histories are connected.</p><div className="change-tags"><span>Versioned changes</span><span>Source lineage</span><span>Release-aware</span></div></article>
      <article className="sensitivity-panel panel preview-section"><div className="panel-title"><div><p className="section-kicker">ASSET SENSITIVITY</p><h3>Current macro exposures</h3></div><button>Details →</button></div><div className="sensitivity-list"><div><b>BTC</b><span>Dollar liquidity <i>High</i></span><small>+0.71</small></div><div><b>Gold</b><span>Real yields <i>High</i></span><small>-0.64</small></div><div><b>Equities</b><span>Credit conditions <i>Medium</i></span><small>+0.48</small></div></div></article>
      <article className="sources-panel panel"><p className="section-kicker">DATA PROVENANCE</p><h3>Connected and target sources.</h3><p>FRED is connected, including ECB and BoJ balance sheets with H.10 FX conversion. BoE, PBoC, BIS, IMF, and institutional market feeds remain planned inputs.</p><button>Explore sources and lags →</button></article>
    </section>
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
    {liquidityChartOpen && <LiquidityChartDialog history={liquidityModel?.history ?? []} onClose={() => setLiquidityChartOpen(false)} />}
  </div>;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
