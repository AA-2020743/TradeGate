import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const navItems = [
  ['⌘', 'Overview'],
  ['◌', 'Markets'],
  ['◇', 'Metals'],
  ['▦', 'Screener'],
  ['◫', 'Watchlists'],
  ['◔', 'Macro'],
];

const watchlist = [
  { ticker: 'NVDA', name: 'NVIDIA Corp.', price: '$875.28', change: '+2.44%', color: '#75d95d' },
  { ticker: 'AAPL', name: 'Apple Inc.', price: '$189.98', change: '+0.63%', color: '#f2a447' },
  { ticker: 'GLD', name: 'SPDR Gold Shares', price: '$192.18', change: '+1.06%', color: '#c4a7ff' },
  { ticker: 'BTC', name: 'Bitcoin', price: '$68,425', change: '+4.12%', color: '#ff7c4d' },
];

const news = [
  ['BLOOMBERG', 'Nvidia rallies as AI spending keeps its momentum alive', '12m ago'],
  ['FINANCIAL TIMES', 'The next leg of the market rally will demand broader participation', '36m ago'],
  ['MARKETWATCH', 'Gold is quietly making its case as rate-cut bets build', '1h ago'],
];

const liquidityDrivers = [
  ['Fed net liquidity', 'Expansion', '+0.8σ', 'positive'],
  ['ECB balance sheet', 'Neutral', '+0.1σ', 'neutral'],
  ['BoJ balance sheet', 'Expansion', '+0.6σ', 'positive'],
  ['PBoC liquidity', 'Expansion', '+0.7σ', 'positive'],
  ['BoE balance sheet', 'Contraction', '-0.4σ', 'negative'],
  ['Global M2', 'Expansion', '+0.5σ', 'positive'],
  ['US M2', 'Neutral', '+0.1σ', 'neutral'],
  ['Dollar liquidity', 'Contraction', '-0.3σ', 'negative'],
  ['Reverse repo', 'Expansion', '+0.4σ', 'positive'],
  ['Treasury General Account', 'Neutral', '0.0σ', 'neutral'],
  ['Credit conditions', 'Constructive', '+0.3σ', 'positive'],
  ['DXY transmission', 'Restrictive', '-0.5σ', 'negative'],
  ['Cross-currency funding', 'Calm', '+0.2σ', 'positive'],
];

const regionalLiquidity = [
  ['United States', '68', 'Net liquidity improving', 'positive'],
  ['Eurozone', '51', 'Balance sheet stable', 'neutral'],
  ['Japan', '74', 'Accommodative policy', 'positive'],
  ['China', '71', 'Credit impulse broadening', 'positive'],
  ['United Kingdom', '38', 'QT remains a drag', 'negative'],
];

const riskInputs = [
  ['Equities', '74', 'positive'], ['Bonds', '52', 'neutral'], ['Credit', '69', 'positive'], ['USD', '39', 'negative'],
  ['VIX', '66', 'positive'], ['MOVE', '49', 'neutral'], ['Gold', '61', 'positive'], ['Oil', '55', 'neutral'],
  ['BTC', '77', 'positive'], ['FX carry', '63', 'positive'],
];

const riskMatrix = [
  ['1W', 'Risk-on', 'Risk-on', 'Neutral'],
  ['1M', 'Risk-on', 'Risk-on', 'Risk-on'],
  ['3M', 'Neutral', 'Risk-on', 'Risk-on'],
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

const fxPredictors = [
  ['Policy-rate differential', 'USD+', 'Fed premium persists', 'positive'],
  ['Short-rate differential', 'USD+', 'Front-end carry favors USD', 'positive'],
  ['2Y yield differential', 'USD+', 'Growth gap remains wide', 'positive'],
  ['10Y yield differential', 'USD+', 'Long-end premium supportive', 'positive'],
  ['Real-rate differential', 'USD+', 'Carry remains supportive', 'positive'],
  ['Central-bank stance', 'Mixed', 'ECB and BoE less restrictive', 'neutral'],
  ['Fiscal trajectory', 'Mixed', 'Debt, deficit, and sovereign-risk trend', 'neutral'],
  ['Safe-haven demand', 'USD+', 'USD, CHF, JPY, Treasuries, gold, and equity volatility', 'positive'],
];

const centralBankStances = [
  ['Fed', 'Restrictive'], ['ECB', 'Easing'], ['BoJ', 'Normalizing'], ['BoE', 'Easing'], ['SNB', 'Easing'],
  ['BoC', 'Easing'], ['RBA', 'Restrictive'], ['RBNZ', 'Easing'], ['PBoC', 'Supportive'],
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

const dxyBtcCorrelation = {
  values: { '20D': -0.57, '60D': -0.62, '1Y': -0.48 },
  dxy: [26, 29, 27, 32, 30, 35, 33, 38, 37, 42, 40, 45, 44, 49, 47, 54],
  btc: [52, 48, 50, 43, 45, 39, 42, 35, 37, 31, 34, 28, 30, 24, 27, 20],
};

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

function App() {
  const [activeNav, setActiveNav] = React.useState('Overview');
  const [period, setPeriod] = React.useState('1D');
  const [selectedTicker, setSelectedTicker] = React.useState('NVDA');
  const [theme, setTheme] = React.useState(() => window.localStorage.getItem('tradegate-theme') ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [commandIndex, setCommandIndex] = React.useState(0);
  const searchInputRef = React.useRef(null);
  const selectedAsset = watchlist.find((asset) => asset.ticker === selectedTicker) ?? watchlist[0];
  const chartValues = [29, 32, 29, 35, 34, 45, 42, 49, 47, 57, 52, 59, 58, 65, 62, 71, 67, 75, 72, 79, 77, 86, 82, 90, 88, 94, 91, 100, 97, 105, 102, 113, 109, 118, 112, 120, 116, 124, 121, 127, 125, 133, 129, 136, 132, 140, 138, 145, 141, 151, 146, 154, 151, 159, 157, 165];
  const commands = [
    { label: 'Overview', detail: 'Workspace', action: () => setActiveNav('Overview') },
    { label: 'Multi-asset heatmap', detail: 'Markets', action: () => setActiveNav('Markets') },
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
          {navItems.map(([icon, label]) => <button key={label} className={`nav-item ${activeNav === label ? 'active' : ''}`} onClick={() => setActiveNav(label)}><span>{icon}</span>{label}</button>)}
        </nav>
        <div className="sidebar-bottom">
          <div className="trial-card"><span className="trial-icon">✦</span><strong>Unlock the full view</strong><p>Get powerful research tools, all in one place.</p><button>Explore Pro <span>→</span></button></div>
          <button className="profile"><span className="avatar">AS</span><span className="profile-copy"><strong>Alex Simmons</strong><small>Free plan</small></span><span className="dots">•••</span></button>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div className="crumb"><span>Research</span><b>/</b><strong>{activeNav}</strong></div>
          <div className="top-actions"><button className="search" onClick={openSearch} aria-label="Search research"><span>⌕</span><span>Search anything</span><kbd>⌘ K</kbd></button><button className="icon-button theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>{theme === 'light' ? '☾' : '☼'}</button><button className="icon-button" aria-label="Help">?</button></div>
        </header>

        <div className="dashboard">
          {activeNav === 'Macro' ? <MacroDashboard /> : activeNav === 'Markets' ? <MarketsDashboard /> : activeNav === 'Metals' ? <MetalsDashboard /> : <>
          <section className="welcome-row">
            <div><p className="eyebrow">THURSDAY, MAY 16</p><h1>Good morning, Alex.</h1><p className="intro">Here is your market pulse for today.</p></div>
            <div className="market-status"><span className="live-dot"></span><span>U.S. markets open</span><strong>Closes in 05:42:18</strong></div>
          </section>

          <section className="market-strip">
            <div className="market-label"><span className="globe">◉</span><div><b>Global markets</b><small>Updated a moment ago</small></div></div>
            <MarketCell name="S&P 500" value="5,303.27" change="+0.27%" />
            <MarketCell name="Nasdaq" value="16,742.39" change="+0.14%" />
            <MarketCell name="Gold" value="$2,386.10" change="+1.22%" />
            <MarketCell name="Bitcoin" value="$68,425.00" change="+4.12%" />
            <button className="strip-more">•••</button>
          </section>

          <section className="focus-header"><div><p className="section-kicker">IN FOCUS</p><h2>{selectedTicker} <span>·</span> {selectedAsset.name}</h2></div><button className="watch-button">☆ Add to watchlist</button></section>

          <section className="focus-grid">
            <article className="chart-card panel">
              <div className="chart-top"><div><p className="quote">{selectedAsset.price} <span>USD</span></p><p className="gain">+20.84 <span>{selectedAsset.change}</span> <small>Today</small></p></div><div className="range-selector">{['1D', '5D', '1M', '6M', 'YTD', '1Y', 'All'].map(item => <button className={period === item ? 'selected' : ''} key={item} onClick={() => setPeriod(item)}>{item}</button>)}</div></div>
              <div className="chart-area"><div className="price-line"><span>$876.00</span><span className="price-tag">875.28</span></div><svg viewBox="0 0 640 234" preserveAspectRatio="none" aria-label="NVDA positive price chart"><defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#7dff77" stopOpacity=".25"/><stop offset="1" stopColor="#7dff77" stopOpacity="0"/></linearGradient></defs><path d={`M0,${234 - chartValues[0] * 1.55} ${chartValues.map((value, index) => `L${index * (640 / (chartValues.length - 1))},${234 - value * 1.55}`).join(' ')} L640,234 L0,234Z`} fill="url(#fill)"/><polyline points={chartValues.map((value, index) => `${index * (640 / (chartValues.length - 1))},${234 - value * 1.55}`).join(' ')} fill="none" stroke="#83ec69" strokeWidth="3" vectorEffect="non-scaling-stroke"/></svg><div className="chart-times"><span>9:30 AM</span><span>11:00 AM</span><span>1:00 PM</span><span>3:00 PM</span><span>4:00 PM</span></div></div>
              <div className="chart-footer"><span>Open <b>861.00</b></span><span>High <b>878.80</b></span><span>Low <b>854.12</b></span><span>Volume <b>34.8M</b></span><span>Avg. Vol <b>51.2M</b></span></div>
            </article>

            <article className="thesis-card panel"><div className="thesis-heading"><div><p className="section-kicker">RESEARCH SIGNAL</p><h3>Investment thesis</h3></div><button>View report →</button></div><div className="signal"><span className="signal-icon">↗</span><div><strong>Constructive</strong><p>Strong earnings revisions and persistent AI demand support the setup.</p></div></div><div className="factor"><span>Earnings momentum</span><div className="factor-bar"><i style={{ width: '88%' }}></i></div><b>88</b></div><div className="factor"><span>Valuation</span><div className="factor-bar neutral"><i style={{ width: '56%' }}></i></div><b>56</b></div><div className="factor"><span>Technical setup</span><div className="factor-bar"><i style={{ width: '74%' }}></i></div><b>74</b></div><p className="updated">Last updated today at 10:14 AM</p></article>
          </section>

          <section className="lower-grid">
            <article className="watchlist-card panel"><div className="card-heading"><div><p className="section-kicker">YOUR LIST</p><h3>Watchlist</h3></div><button>View all <span>→</span></button></div><div className="watchlist-table">{watchlist.map((item, index) => <button className={`watch-row ${selectedTicker === item.ticker ? 'watch-selected' : ''}`} onClick={() => setSelectedTicker(item.ticker)} key={item.ticker}><span className="asset-badge" style={{ backgroundColor: item.color }}>{item.ticker.charAt(0)}</span><span className="asset-name"><b>{item.ticker}</b><small>{item.name}</small></span><span className="mini-chart"><Sparkline color={item.color} values={[8 + index, 18, 13, 26, 21, 32, 27, 37, 34, 42]} /></span><span className="asset-price"><b>{item.price}</b><small>{item.change}</small></span></button>)}</div></article>
            <article className="news-card panel"><div className="card-heading"><div><p className="section-kicker">WHAT MATTERS</p><h3>Market intelligence</h3></div><button>All news <span>→</span></button></div><div className="news-list">{news.map(([source, title, time]) => <article className="news-item" key={title}><div><p><span>{source}</span> <small>{time}</small></p><h4>{title}</h4></div><span className="news-arrow">↗</span></article>)}</div></article>
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

function MarketCell({ name, value, change }) {
  return <div className="market-cell"><p>{name}</p><strong>{value}</strong><small className="positive">{change}</small></div>;
}

function heatmapCellTone(asset, key) {
  if (key === 'score') return asset.score >= 65 ? 'positive' : asset.score >= 50 ? 'neutral' : 'negative';
  return asset[`${key}Tone`] ?? 'neutral';
}

function MarketsDashboard() {
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
      <div className="markets-status"><span className="live-dot"></span><div><b>11 markets monitored</b><small>Signals refreshed 14m ago</small></div></div>
    </section>

    <section className="heatmap-summary-grid">
      <article className="heatmap-hero panel"><div><p className="section-kicker">CROSS-ASSET REGIME</p><h2>Broadly constructive <span className="status-dot"></span></h2><p>Risk assets, metals, and the dollar remain mostly aligned. Crowding is the constraint.</p></div><div className="regime-distribution"><span className="positive">5</span><span className="neutral">4</span><span className="negative">2</span><small>Constructive</small><small>Neutral</small><small>Guarded</small></div></article>
      <article className="heatmap-stat panel"><p className="section-kicker">ALIGNMENT</p><b>73<span>/100</span></b><p>Trend and macro agreement</p><i><span style={{ width: '73%' }}></span></i></article>
      <article className="heatmap-stat panel"><p className="section-kicker">CROWDING</p><b>61<span>/100</span></b><p>Risk appetite is elevated</p><i className="amber"><span style={{ width: '61%' }}></span></i></article>
      <article className="heatmap-stat panel"><p className="section-kicker">MARKET QUALITY</p><b>76<span>/100</span></b><p>Liquidity remains resilient</p><i><span style={{ width: '76%' }}></span></i></article>
    </section>

    <section className="heatmap-heading"><div><p className="section-kicker">MARKET MATRIX</p><h2>Multi-asset heatmap</h2></div><div className="heatmap-controls"><div className="group-filter">{groups.map((item) => <button className={group === item ? 'active' : ''} key={item} onClick={() => setGroup(item)}>{item}</button>)}</div><div className="window-buttons">{['1D', '1W', '1M'].map((item) => <button className={timeframe === item ? 'selected' : ''} key={item} onClick={() => setTimeframe(item)}>{item}</button>)}</div></div></section>

    <section className="heatmap-workspace">
      <article className="heatmap-panel panel"><div className="heatmap-legend"><span><i className="positive"></i>Supportive</span><span><i className="neutral"></i>Mixed</span><span><i className="negative"></i>Guarded</span><small>{timeframe} model window</small></div><div className="heatmap-scroll"><div className="heatmap-table"><div className="heatmap-table-head"><span>Market</span>{heatmapColumns.map(([key, label]) => <button className={activeMetric === key ? 'metric-active' : ''} key={key} onClick={() => setActiveMetric(key)}>{label}</button>)}</div>{visibleAssets.map((asset) => <button className={`heatmap-row ${selectedAsset.symbol === asset.symbol ? 'asset-selected' : ''}`} onClick={() => setSelectedSymbol(asset.symbol)} key={asset.symbol}><span className="heatmap-asset"><b>{asset.symbol}</b><small>{asset.name}</small></span>{heatmapColumns.map(([key]) => <span className={`heatmap-cell ${heatmapCellTone(asset, key)} ${activeMetric === key ? 'metric-active' : ''}`} key={key}>{key === 'score' ? asset.score : asset[key]}</span>)}</button>)}</div></div></article>
      <article className="heatmap-detail panel"><div className="panel-title"><div><p className="section-kicker">SELECTED MARKET</p><h3>{selectedAsset.name}</h3></div><span className={`market-symbol ${selectedAsset.group.toLowerCase().replace(' ', '-')}`}>{selectedAsset.symbol}</span></div><div className="detail-score"><span>{activeColumn[1]} signal</span><b className={heatmapCellTone(selectedAsset, activeMetric)}>{activeMetric === 'score' ? selectedAsset.score : selectedAsset[activeMetric]}</b><small>{selectedAsset.regime} regime</small></div><div className="detail-metrics">{heatmapColumns.filter(([key]) => key !== activeMetric).map(([key, label]) => <div key={key}><span>{label}</span><b className={heatmapCellTone(selectedAsset, key)}>{key === 'score' ? selectedAsset.score : selectedAsset[key]}</b></div>)}</div><div className="heatmap-callout"><span>Model read</span><p>{selectedAsset.note}</p></div><button className="source-link">Open {selectedAsset.symbol} research →</button></article>
    </section>

    <section className="heatmap-bottom-grid">
      <article className="heatmap-method panel"><p className="section-kicker">MODEL DISCIPLINES</p><h3>One screen, seven lenses.</h3><p>Scores combine trend, cross-market alignment, positioning, volatility, and liquidity rather than relying on price direction alone.</p><div><span>Score</span><span>Regime</span><span>Alignment</span><span>Trend</span><span>Crowding</span><span>Volatility</span><span>Liquidity</span></div></article>
      <article className="heatmap-alert panel"><p className="section-kicker">WATCHLIST ALERT</p><h3>Options positioning is the weak link.</h3><p>Suppressed volatility and elevated dealer gamma can turn a quiet market into an unstable one if the index breaks its range.</p><button>Review positioning →</button></article>
    </section>
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
  </div>;
}

function MetalsDashboard() {
  const [selectedSymbol, setSelectedSymbol] = React.useState('XAU');
  const [horizon, setHorizon] = React.useState('1M');
  const selectedMetal = preciousMetalAssets.find((asset) => asset.symbol === selectedSymbol) ?? preciousMetalAssets[0];

  return <div className="metals-dashboard">
    <section className="metals-intro">
      <div><p className="eyebrow">PRECIOUS METALS RESEARCH</p><h1>Where monetary metal meets market structure.</h1><p className="intro">Technical, macro, physical, and positioning signals for metals and their equity proxies.</p></div>
      <div className="metals-pulse"><span className="live-dot"></span><div><b>Precious metals constructive</b><small>Physical and macro signals aligned</small></div></div>
    </section>

    <section className="metal-asset-strip">{preciousMetalAssets.map((asset) => <button className={`metal-asset ${selectedMetal.symbol === asset.symbol ? 'selected' : ''}`} onClick={() => setSelectedSymbol(asset.symbol)} key={asset.symbol}><span className="metal-symbol" style={{ '--metal-color': asset.color }}>{asset.symbol}</span><span><b>{asset.name}</b><small>{asset.regime}</small></span><span className="metal-price"><b>{asset.price}</b><small className={asset.change.startsWith('-') ? 'negative' : 'positive'}>{asset.change}</small></span><span className="metal-spark"><Sparkline color={asset.color} values={asset.values} /></span></button>)}</section>

    <section className="metals-focus-heading"><div><p className="section-kicker">{selectedMetal.symbol} RESEARCH MAP</p><h2>{selectedMetal.name} <span>·</span> {selectedMetal.regime}</h2></div><div className="window-buttons">{['1W', '1M', '3M'].map((item) => <button className={horizon === item ? 'selected' : ''} key={item} onClick={() => setHorizon(item)}>{item}</button>)}</div></section>

    <section className="metals-primary-grid">
      <article className="metal-price-panel panel"><div className="panel-title"><div><p className="section-kicker">PRICE AND TECHNICALS</p><h3>Trend has room to run.</h3></div><span className="data-pill">{horizon} window</span></div><div className="metal-quote"><b>{selectedMetal.price}</b><span className="positive">{selectedMetal.change}</span><small>USD per troy ounce</small></div><div className="metal-chart"><Sparkline color={selectedMetal.color} values={[12, 14, 13, 17, 16, 22, 20, 26, 24, 30, 28, 35, 33, 39, 37, 45, 43, 49, 48, 54]} /></div><div className="technical-grid">{metalTechnicalIndicators.map(([name, value, detail, tone]) => <div className="technical-item" key={name}><span>{name}</span><b className={tone}>{value}</b><small>{detail}</small></div>)}</div></article>
      <article className="metal-macro-panel panel"><div className="panel-title"><div><p className="section-kicker">METALS MACRO SCORE</p><h3>Monetary backdrop remains supportive.</h3></div><span className="macro-score">78</span></div><div className="metal-macro-list">{metalMacroIndicators.map(([name, state, detail, tone]) => <div className="metal-macro-row" key={name}><div><b>{name}</b><small>{detail}</small></div><span className={tone}>{state}</span></div>)}</div><div className="macro-conclusion"><span>Model conclusion</span><p>Falling real-yield impulse and expanding liquidity outweigh the DXY headwind.</p></div></article>
    </section>

    <section className="metals-section-heading"><div><p className="section-kicker">FLOWS AND POSITIONING</p><h2>Who owns the trade, and where is demand coming from?</h2></div><span className="data-pill">Latest available releases</span></section>
    <section className="metals-flow-grid">
      <article className="positioning-panel panel"><div className="panel-title"><div><p className="section-kicker">CFTC COT</p><h3>Positioning is firm, not extreme.</h3></div><span className="positioning-percentile">72<span>th pct.</span></span></div><div className="positioning-rows"><div><span>Commercial positioning</span><i><b className="commercial" style={{ width: '41%' }}></b></i><small>41</small></div><div><span>Managed Money</span><i><b className="managed" style={{ width: '72%' }}></b></i><small>72</small></div><div><span>Producers</span><i><b className="producer" style={{ width: '34%' }}></b></i><small>34</small></div><div><span>Swap Dealers</span><i><b className="swap" style={{ width: '47%' }}></b></i><small>47</small></div><div><span>Speculator extremes</span><i><b className="speculator" style={{ width: '68%' }}></b></i><small>68</small></div></div><div className="positioning-note"><b>Positioning percentile</b><span>Elevated long exposure, but below historical blow-off thresholds.</span></div></article>
      <article className="metal-flows-panel panel"><div className="panel-title"><div><p className="section-kicker">FLOWS AND OFFICIAL DEMAND</p><h3>ETF and central-bank demand</h3></div><span className="data-pill">Daily</span></div>{metalFlows.map(([name, value, detail, tone]) => <div className="metal-flow-row" key={name}><div><b>{name}</b><small>{detail}</small></div><span className={tone}>{value}</span></div>)}</article>
      <article className="physical-market-panel panel"><div className="panel-title"><div><p className="section-kicker">PHYSICAL VS PAPER</p><h3>Market plumbing is orderly.</h3></div><span className="data-pill">Spot / futures</span></div>{physicalMarket.map(([name, value, detail, tone]) => <div className="physical-row" key={name}><div><b>{name}</b><small>{detail}</small></div><span className={tone}>{value}</span></div>)}</article>
    </section>

    <section className="metals-bottom-grid">
      <article className="miners-panel panel"><div className="panel-title"><div><p className="section-kicker">MINER EQUITY EXPRESSION</p><h3>Relevant miner ETFs</h3></div><button>Compare miners →</button></div><div className="miner-list">{minerEtfs.map(([ticker, name, change, tone]) => <button key={ticker}><span>{ticker}</span><b>{name}</b><small className={tone}>{change}</small><i>↗</i></button>)}</div><p>Miners add operating leverage to metal prices, but input costs and equity-beta remain separate risks.</p></article>
      <article className="metal-costs-panel panel"><div className="panel-title"><div><p className="section-kicker">METALS COST STRUCTURE</p><h3>Margins are expanding.</h3></div><span className="data-pill">Producer lens</span></div>{metalCosts.map(([name, value, detail, tone]) => <div className="metal-cost-row" key={name}><div><b>{name}</b><small>{detail}</small></div><span className={tone}>{value}</span></div>)}<div className="cost-callout"><span>What matters next</span><p>A sustained oil or labor-cost shock would compress producer margins before it reaches spot metals.</p></div></article>
    </section>
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
  </div>;
}

function MacroDashboard() {
  const [window, setWindow] = React.useState('13W');
  const [activeModel, setActiveModel] = React.useState('Liquidity');
  const [correlationWindow, setCorrelationWindow] = React.useState('60D');
  const [fxHorizon, setFxHorizon] = React.useState('1M');
  const windowLabel = window === '4W' ? 'near-term' : window === '26W' ? 'cyclical' : 'tactical';

  return <div className="macro-dashboard">
    <section className="macro-intro">
      <div><p className="eyebrow">MACRO RESEARCH SYSTEM</p><h1>Liquidity leads. Risk confirms.</h1><p className="intro">A cross-asset view of the forces shaping capital availability and market regime.</p></div>
      <div className="model-tabs"><button className={activeModel === 'Liquidity' ? 'active' : ''} onClick={() => setActiveModel('Liquidity')}>Global liquidity</button><button className={activeModel === 'Risk' ? 'active' : ''} onClick={() => setActiveModel('Risk')}>Inter-market risk</button><button className={activeModel === 'Correlations' ? 'active' : ''} onClick={() => setActiveModel('Correlations')}>Correlations</button><button className={activeModel === 'FX' ? 'active' : ''} onClick={() => setActiveModel('FX')}>FX predictive</button></div>
    </section>

    <section className="model-overview-grid">
      <article className={`macro-model panel ${activeModel === 'Liquidity' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">GLOBAL LIQUIDITY MODEL</p><h2>Expansion <span className="status-dot"></span></h2><p>Broadening policy and credit impulse</p></div><div className="score-orbit"><b>72</b><small>/100</small></div></div>
        <div className="liquidity-chart"><div className="chart-caption"><span>Composite liquidity impulse</span><strong>+0.48σ</strong></div><Sparkline color="#75c966" values={[10, 15, 14, 20, 17, 23, 21, 29, 27, 35, 31, 39, 37, 44, 41, 49, 47, 54, 52, 58, 60]} /><div className="liquidity-axis"><span>Oct</span><span>Jan</span><span>Apr</span><span>Today</span></div></div>
        <div className="signal-summary"><span>Momentum <b>Accelerating</b></span><span>Breadth <b>8 of 13 positive</b></span><span>Confidence <b>High</b></span></div>
        <div className="model-action"><span>View all liquidity inputs</span><button onClick={() => setActiveModel('Liquidity')}>Open model →</button></div>
      </article>

      <article className={`macro-model panel risk-model ${activeModel === 'Risk' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">INTER-MARKET RISK MODEL</p><h2>Risk-on <span className="status-dot blue"></span></h2><p>Credit and volatility confirm the advance</p></div><div className="score-orbit blue-orbit"><b>76</b><small>/100</small></div></div>
        <div className="risk-lanes"><div><span>Risk appetite</span><i><b style={{ width: '76%' }}></b></i><strong>76</strong></div><div><span>Funding stress</span><i><b style={{ width: '31%' }}></b></i><strong>31</strong></div><div><span>Volatility pressure</span><i><b style={{ width: '37%' }}></b></i><strong>37</strong></div></div>
        <div className="signal-summary"><span>1-week <b>Risk-on</b></span><span>1-month <b>Risk-on</b></span><span>Panic odds <b>6%</b></span></div>
        <div className="model-action"><span>10 independent market inputs</span><button onClick={() => setActiveModel('Risk')}>Open model →</button></div>
      </article>
      <article className={`macro-model panel correlation-model ${activeModel === 'Correlations' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">REGIME CORRELATION MAP</p><h2>7 active links <span className="status-dot violet"></span></h2><p>Relationships ranked by stability</p></div><div className="correlation-glyph"><span></span><i></i><b></b><em></em></div></div>
        <div className="correlation-preview"><span>Strongest</span><b>Credit spreads <i>↔</i> Equities</b><strong>-0.78</strong><span>Most unstable</span><b>BTC <i>↔</i> S&P 500</b><strong>+0.54</strong></div>
        <div className="model-action"><span>Rolling and regime-adjusted</span><button onClick={() => setActiveModel('Correlations')}>Open map →</button></div>
      </article>
      <article className={`macro-model panel fx-model ${activeModel === 'FX' ? 'model-emphasis' : ''}`}>
        <div className="macro-card-top"><div><p className="section-kicker">FOREX PREDICTIVE MODEL</p><h2>USD strength <span className="status-dot amber"></span></h2><p>Rate differentials and growth lead</p></div><div className="fx-pair-tile"><b>DXY</b><strong>106.4</strong><small>+0.41%</small></div></div>
        <div className="fx-preview"><span>Macro bias</span><b>USD / CHF <i>↑</i></b><span>Vulnerable</span><b>JPY / CNH <i>↓</i></b><span>Dollar smile</span><b>Active</b></div>
        <div className="model-action"><span>Rates, flows, and volatility</span><button onClick={() => setActiveModel('FX')}>Open model →</button></div>
      </article>
    </section>

    <section className="macro-section-heading"><div><p className="section-kicker">{activeModel === 'Liquidity' ? 'NET GLOBAL LIQUIDITY' : activeModel === 'Risk' ? 'CROSS-ASSET CONFIRMATION' : activeModel === 'Correlations' ? 'RELATIONSHIP INTELLIGENCE' : 'FOREX MACRO PREDICTORS'}</p><h2>{activeModel === 'Liquidity' ? 'The drivers behind the impulse' : activeModel === 'Risk' ? 'What markets are pricing now' : activeModel === 'Correlations' ? 'Correlations through the current regime' : 'Where macro points for each currency'}</h2></div>{activeModel === 'Liquidity' && <div className="window-buttons">{['4W', '13W', '26W'].map((item) => <button className={window === item ? 'selected' : ''} key={item} onClick={() => setWindow(item)}>{item}</button>)}</div>}{activeModel === 'Correlations' && <div className="window-buttons">{['20D', '60D', '1Y'].map((item) => <button className={correlationWindow === item ? 'selected' : ''} key={item} onClick={() => setCorrelationWindow(item)}>{item}</button>)}</div>}{activeModel === 'FX' && <div className="window-buttons">{['1W', '1M', '3M'].map((item) => <button className={fxHorizon === item ? 'selected' : ''} key={item} onClick={() => setFxHorizon(item)}>{item}</button>)}</div>}</section>

    {activeModel === 'Liquidity' ? <section className="liquidity-detail-grid">
      <article className="driver-panel panel"><div className="driver-panel-head"><span>Indicator</span><span>State</span><span>{window} z-score</span></div>{liquidityDrivers.map(([name, state, score, tone]) => <div className="driver-row" key={name}><span>{name}</span><b className={tone}>{state}</b><strong>{score}</strong></div>)}<p className="model-footnote">Scores use rolling history and latest available releases. {windowLabel[0].toUpperCase() + windowLabel.slice(1)} impulse window selected.</p></article>
      <article className="regional-panel panel"><div className="panel-title"><div><p className="section-kicker">REGIONAL CONTRIBUTION</p><h3>Liquidity breadth</h3></div><span className="data-pill">5 regions</span></div>{regionalLiquidity.map(([name, score, description, tone]) => <div className="region-row" key={name}><div><b>{name}</b><small>{description}</small></div><div className="region-score"><i><b className={tone} style={{ width: `${score}%` }}></b></i><strong>{score}</strong></div></div>)}<button className="source-link">See source methodology →</button></article>
    </section> : activeModel === 'Risk' ? <section className="risk-detail-grid">
      <article className="risk-inputs panel"><div className="panel-title"><div><p className="section-kicker">MODEL COMPONENTS</p><h3>Ten independent sleeves</h3></div><span className="data-pill">Live regime</span></div><div className="risk-input-grid">{riskInputs.map(([name, score, tone]) => <div className="risk-input" key={name}><span className={tone}></span><b>{name}</b><strong>{score}</strong><small>{Number(score) > 60 ? 'Supportive' : Number(score) < 45 ? 'Caution' : 'Balanced'}</small></div>)}</div></article>
      <article className="regime-panel panel"><div className="panel-title"><div><p className="section-kicker">REGIME HEATMAP</p><h3>Horizon agreement</h3></div><span className="data-pill">Updated 14m ago</span></div><div className="regime-table"><div className="regime-head"><span></span><span>Equities</span><span>Credit</span><span>Macro</span></div>{riskMatrix.map(([horizon, equity, credit, macro]) => <div className="regime-table-row" key={horizon}><b>{horizon}</b><span className={equity.toLowerCase().replace('-', '')}>{equity}</span><span className={credit.toLowerCase().replace('-', '')}>{credit}</span><span className={macro.toLowerCase().replace('-', '')}>{macro}</span></div>)}</div><p className="model-footnote">Panic requires simultaneous volatility, credit, funding, and drawdown deterioration.</p></article>
    </section> : activeModel === 'Correlations' ? <section className="correlation-detail-grid">
      <article className="correlation-map-panel panel"><div className="panel-title"><div><p className="section-kicker">{correlationWindow} ROLLING CORRELATION</p><h3>Cross-market relationship map</h3></div><span className="data-pill">Risk-on regime</span></div><div className="correlation-legend"><span><i className="correlation-negative"></i>Inverse</span><span><i className="correlation-neutral"></i>Mixed</span><span><i className="correlation-positive"></i>Positive</span><small>r = Pearson correlation</small></div><div className="correlation-rows">{correlationPairs.map((pair) => { const value = pair.values[correlationWindow]; const tone = correlationTone(value); return <div className="correlation-row" key={`${pair.left}-${pair.right}`}><b>{pair.left}</b><div className="correlation-link"><i className={tone}></i><span></span><i className={tone}></i></div><b>{pair.right}</b><strong className={tone}>{value > 0 ? '+' : ''}{value.toFixed(2)}</strong><small>{pair.regime}</small></div>; })}</div></article>
      <article className="correlation-insight-panel panel"><p className="section-kicker">REGIME READ</p><h3>Risk links are orderly.</h3><p>Credit and equities retain their usual inverse relationship while BTC remains closely tied to equity appetite. No material correlation breaks are currently flagged.</p><div className="stability-score"><span>Relationship stability</span><div><i><b></b></i><strong>81%</strong></div></div><div className="correlation-watch"><b>Watch for a break</b><span>BTC/SPX below +0.20 or credit/equity above -0.35</span></div></article>
      <article className="correlation-notes panel"><p className="section-kicker">HOW TO READ THIS</p><div>{correlationPairs.slice(0, 3).map((pair) => <p key={pair.left}><b>{pair.left} / {pair.right}</b><span>{pair.note}</span></p>)}</div><button>Open historical regime study →</button></article>
      <article className="dxy-btc-panel panel"><div className="panel-title"><div><p className="section-kicker">DXY VS BITCOIN</p><h3>Dollar strength is a BTC headwind.</h3></div><span className="data-pill">{correlationWindow} r {dxyBtcCorrelation.values[correlationWindow].toFixed(2)}</span></div><div className="dxy-btc-chart"><div><span><i className="dxy-key"></i>DXY momentum</span><Sparkline color="#d3a454" values={dxyBtcCorrelation.dxy} /></div><div><span><i className="btc-key"></i>BTC momentum</span><Sparkline color="#70c26b" values={dxyBtcCorrelation.btc} /></div></div><div className="dxy-btc-diagnostics"><span>Correlation regime <b>Inverse</b></span><span>Momentum divergence <b>DXY leading</b></span><span>Breakout read <b>BTC headwind</b></span></div><p>DXY weakness would reverse the current pressure and become a tailwind for BTC.</p></article>
    </section> : <section className="fx-detail-grid">
      <article className="fx-outlook-panel panel"><div className="panel-title"><div><p className="section-kicker">{fxHorizon} RELATIVE-VALUE OUTLOOK</p><h3>G10 and CNH directional bias</h3></div><span className="data-pill">Macro composite</span></div><div className="fx-outlook-head"><span>Currency</span><span>Bias</span><span>Score</span><span>Dominant driver</span></div>{fxOutlook.map(([currency, bias, score, tone, driver]) => <div className="fx-outlook-row" key={currency}><b>{currency}</b><span className={tone}>{bias}</span><strong>{score}</strong><small>{driver}</small></div>)}</article>
      <article className="fx-predictor-panel panel"><div className="panel-title"><div><p className="section-kicker">USD STRENGTH ENGINE</p><h3>Macro predictor stack</h3></div><span className="data-pill">Score 68</span></div>{fxPredictors.map(([name, direction, detail, tone]) => <div className="fx-predictor-row" key={name}><div><b>{name}</b><small>{detail}</small></div><span className={tone}>{direction}</span></div>)}<div className="central-bank-grid"><p>Central-bank stance</p><div>{centralBankStances.map(([bank, stance]) => <span key={bank}><b>{bank}</b>{stance}</span>)}</div></div><div className="dollar-smile"><b>Dollar Smile <span>Active</span></b><p>USD benefits if U.S. growth outperforms or global stress rises.</p><div><span>Global stress</span><i></i><span>Weak global growth</span></div></div></article>
      <article className="fx-positioning-panel panel"><div className="panel-title"><div><p className="section-kicker">POSITIONING AND VOLATILITY</p><h3>Flow and funding read</h3></div><span className="data-pill">7 lenses</span></div>{fxPositioning.map(([name, signal, score, label]) => <div className="fx-position-row" key={name}><div><b>{name}</b><small>{signal}</small></div><i><b style={{ width: `${score}%` }}></b></i><strong>{score}</strong><span>{label}</span></div>)}</article>
      <article className="fx-scenarios-panel panel"><p className="section-kicker">USD SCENARIO MAP</p><h3>Three paths, one framework.</h3><div><span>Global stress</span><b>USD, CHF, JPY bid</b></div><div><span>Strong U.S. growth</span><b>USD carry strengthens</b></div><div><span>Weak global growth</span><b>USD defensive premium</b></div><p>Central-bank stance, real rates, and funding stress determine the path weighting.</p></article>
      <article className="fx-commodity-panel panel"><div className="panel-title"><div><p className="section-kicker">FX COMMODITY LINKS</p><h3>Correlation, divergence, and lead/lag</h3></div><span className="data-pill">60D rolling</span></div><div className="fx-commodity-head"><span>FX</span><span>Linked market</span><span>r</span><span>State</span><span>Timing</span></div>{fxCommodityLinks.map(([currency, market, correlation, state, timing]) => <div className="fx-commodity-row" key={`${currency}-${market}`}><b>{currency}</b><span>{market}</span><strong>{correlation}</strong><i className={state === 'Aligned' ? 'positive' : 'caution'}>{state}</i><small>{timing}</small></div>)}</article>
      <article className="fx-rotation-panel panel"><p className="section-kicker">FX VS EQUITY ROTATION</p><h3>FX leads the risk handoff.</h3>{fxRotationSignals.map(([signal, market, status, regime]) => <div className="fx-rotation-row" key={signal}><div><b>{signal}</b><small>{market}</small></div><span className={regime.toLowerCase().replace('-', '')}>{status}</span></div>)}<p>Use FX breaks as early confirmation for EM equities, commodity sectors, regional equities, and broad risk rotation.</p></article>
    </section>}

    <section className="macro-bottom-grid">
      <article className="change-panel panel"><p className="section-kicker">WHAT CHANGED THIS WEEK</p><h3>Liquidity improved, with one caveat.</h3><p className="change-copy">PBoC funding and declining reverse-repo balances added to the impulse. A firmer dollar remains the primary restraint on global risk-taking.</p><div className="change-tags"><span>↑ China credit impulse</span><span>↑ U.S. net liquidity</span><span>↓ Dollar liquidity</span></div></article>
      <article className="sensitivity-panel panel"><div className="panel-title"><div><p className="section-kicker">ASSET SENSITIVITY</p><h3>Current macro exposures</h3></div><button>Details →</button></div><div className="sensitivity-list"><div><b>BTC</b><span>Dollar liquidity <i>High</i></span><small>+0.71</small></div><div><b>Gold</b><span>Real yields <i>High</i></span><small>-0.64</small></div><div><b>Equities</b><span>Credit conditions <i>Medium</i></span><small>+0.48</small></div></div></article>
      <article className="sources-panel panel"><p className="section-kicker">DATA PROVENANCE</p><h3>Built from official releases.</h3><p>Federal Reserve, U.S. Treasury, ECB, BoJ, BoE, PBoC, BIS, IMF, and market-based funding indicators.</p><button>Explore sources and lags →</button></article>
    </section>
    <p className="independence-note">TradeGate is an independent market research platform and is not affiliated with Tradegate AG.</p>
  </div>;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
