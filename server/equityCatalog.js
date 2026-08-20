import { isDailyCloseStale } from './freshness.js';

export const indexCatalog = [
  { id: 'sp500', region: 'United States', name: 'S&P 500', symbol: 'SPY', instrument: 'ETF proxy', priority: 1 },
  { id: 'nasdaq100', region: 'United States', name: 'Nasdaq-100', symbol: 'QQQ', instrument: 'ETF proxy', priority: 1 },
  { id: 'dow', region: 'United States', name: 'Dow Jones Industrial Average', symbol: 'DIA', instrument: 'ETF proxy', priority: 1 },
  { id: 'russell2000', region: 'United States', name: 'Russell 2000', symbol: 'IWM', instrument: 'ETF proxy', priority: 1 },
  { id: 'dax', region: 'Europe', name: 'DAX', symbol: 'EWG', instrument: 'Germany ETF proxy', priority: 1 },
  { id: 'ftse100', region: 'Europe', name: 'FTSE 100', symbol: 'EWU', instrument: 'United Kingdom ETF proxy', priority: 1 },
  { id: 'cac40', region: 'Europe', name: 'CAC 40', symbol: 'EWQ', instrument: 'France ETF proxy', priority: 1 },
  { id: 'eurostoxx50', region: 'Europe', name: 'Euro Stoxx 50', symbol: 'FEZ', instrument: 'ETF proxy', priority: 1 },
  { id: 'nikkei225', region: 'Japan', name: 'Nikkei 225', symbol: 'EWJ', instrument: 'Japan ETF proxy', priority: 1 },
  { id: 'topix', region: 'Japan', name: 'TOPIX', symbol: 'JPXN', instrument: 'Japan equity proxy', priority: 2 },
  { id: 'csi300', region: 'China / Hong Kong', name: 'CSI 300', symbol: 'ASHR', instrument: 'ETF proxy', priority: 1 },
  { id: 'shanghai', region: 'China / Hong Kong', name: 'Shanghai Composite', symbol: 'MCHI', instrument: 'China ETF proxy', priority: 2 },
  { id: 'hangseng', region: 'China / Hong Kong', name: 'Hang Seng', symbol: 'EWH', instrument: 'Hong Kong ETF proxy', priority: 1 },
  { id: 'hangsengtech', region: 'China / Hong Kong', name: 'Hang Seng Tech', symbol: 'KWEB', instrument: 'China technology ETF proxy', priority: 1 },
  { id: 'bovespa', region: 'Latin America', name: 'Brazil Bovespa', symbol: 'EWZ', instrument: 'Brazil ETF proxy', priority: 1 },
  { id: 'mexicoipc', region: 'Latin America', name: 'Mexico IPC', symbol: 'EWW', instrument: 'Mexico ETF proxy', priority: 1 },
  { id: 'emerging', region: 'Emerging Markets', name: 'Broad Emerging Markets', symbol: 'EEM', instrument: 'ETF proxy', priority: 1 },
  { id: 'emerging-vanguard', region: 'Emerging Markets', name: 'Emerging Markets ex-specialization', symbol: 'VWO', instrument: 'ETF proxy', priority: 2 },
];

export const sectorCatalog = [
  { name: 'Technology', symbol: 'XLK', sensitivity: 'Rates and growth' },
  { name: 'Healthcare', symbol: 'XLV', sensitivity: 'Defensive growth' },
  { name: 'Financials', symbol: 'XLF', sensitivity: 'Curve and credit' },
  { name: 'Industrials', symbol: 'XLI', sensitivity: 'Growth and capex' },
  { name: 'Energy', symbol: 'XLE', sensitivity: 'Oil and inflation' },
  { name: 'Materials', symbol: 'XLB', sensitivity: 'Commodities and China' },
  { name: 'Consumer Discretionary', symbol: 'XLY', sensitivity: 'Growth and real income' },
  { name: 'Consumer Staples', symbol: 'XLP', sensitivity: 'Defensive and yields' },
  { name: 'Utilities', symbol: 'XLU', sensitivity: 'Bond yields' },
  { name: 'Real Estate', symbol: 'XLRE', sensitivity: 'Real yields and credit' },
  { name: 'Communication Services', symbol: 'XLC', sensitivity: 'Growth and advertising' },
];

export const subsectorCatalog = [
  { group: 'Technology', name: 'Semiconductors', symbol: 'SOXX' },
  { group: 'Technology', name: 'Software', symbol: 'IGV' },
  { group: 'Technology', name: 'Cybersecurity', symbol: 'CIBR' },
  { group: 'Healthcare', name: 'Biotechnology', symbol: 'XBI' },
  { group: 'Healthcare', name: 'Pharmaceuticals', symbol: 'PPH' },
  { group: 'Healthcare', name: 'Medical devices', symbol: 'IHI' },
  { group: 'Financials', name: 'Banks', symbol: 'KBE' },
  { group: 'Financials', name: 'Insurance', symbol: 'KIE' },
  { group: 'Financials', name: 'Capital markets', symbol: 'IAI' },
  { group: 'Energy', name: 'Oil and gas exploration', symbol: 'XOP' },
  { group: 'Energy', name: 'Oilfield services', symbol: 'OIH' },
  { group: 'Energy', name: 'Midstream and pipelines', symbol: 'AMLP' },
  { group: 'Industrials', name: 'Aerospace and defense', symbol: 'ITA' },
  { group: 'Industrials', name: 'Transportation', symbol: 'IYT' },
  { group: 'Consumer', name: 'Homebuilders', symbol: 'XHB' },
  { group: 'Consumer', name: 'Retail', symbol: 'XRT' },
  { group: 'Materials', name: 'Mining', symbol: 'XME' },
  { group: 'Materials', name: 'Gold miners', symbol: 'GDX' },
  { group: 'Materials', name: 'Silver miners', symbol: 'SIL' },
];

export const breadthRequirements = [
  'Advance/Decline Line',
  'Advance/Decline Volume',
  'McClellan Oscillator',
  'McClellan Summation',
  '% above 20DMA',
  '% above 50DMA',
  '% above 200DMA',
  'New highs/new lows',
  'Equal-weight vs cap-weight',
  'Breadth thrust',
  'Sector breadth',
  'Small-cap vs large-cap participation',
];

export const sentimentRequirements = [
  'AAII sentiment',
  'Fear and Greed composite',
  'Equity put/call',
  'Index put/call',
  'Options skew',
  'Retail flow',
  'Social sentiment',
  'Google Trends',
  'Fund-manager surveys',
];

export const positioningRequirements = [
  'COT equity index futures',
  'Asset-manager positioning',
  'Leveraged-fund positioning',
  'Dealer positioning',
  'ETF flows',
  'Mutual-fund flows',
  'Options positioning',
  'Short interest',
  'Borrow utilization',
  'Days-to-cover',
];

export function getCoreEquityHistorySymbols() {
  return [...new Set([
    ...indexCatalog.filter((item) => item.priority === 1).map((item) => item.symbol),
    ...sectorCatalog.map((item) => item.symbol),
  ])];
}

export function getAllEquityHistorySymbols() {
  return [...new Set([
    ...indexCatalog.map((item) => item.symbol),
    ...sectorCatalog.map((item) => item.symbol),
    ...subsectorCatalog.map((item) => item.symbol),
  ])];
}

export function attachSeriesCoverage(items, coverageRows, now = Date.now()) {
  const coverage = new Map(coverageRows.map((row) => [row.symbol, row]));
  return items.map((item) => {
    const row = coverage.get(item.symbol);
    const observations = row?.observations ?? 0;
    const latestTimestamp = new Date(row?.endsAt).getTime();
    const stale = observations > 0 && isDailyCloseStale(latestTimestamp, now);
    return {
      ...item,
      coverage: {
        status: observations >= 200 ? stale ? 'stale' : 'ready' : observations >= 30 ? 'partial' : 'pending',
        observations,
        startsAt: row?.startsAt ?? null,
        endsAt: row?.endsAt ?? null,
        stale,
      },
    };
  });
}
