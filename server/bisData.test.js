import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBisMonthlySeries, parseCsvRows } from './bisData.js';

// Verbatim from the BIS API on the production server (lastNObservations=2).
const BIS_RESPONSE = `FREQ,REF_AREA,COMP_METHOD,UNIT_MEASURE,CURRENCY,TRANSFORMATION,COMMENT_DSET,DATA_COMP,METHOD_REF,COLLECTION_DETAIL,COMMENT_TS,DECIMALS,UNIT_MULT,BREAKS,SUPP_INFO_BREAKS,COMPILING_ORG,DISS_ORG,TITLE,TIME_FORMAT,COLLECTION,TIME_PERIOD,OBS_VALUE,FISCAL_YEAR,CONF_STATUS,OBS_STATUS,OBS_PRE_BREAK
M,CN,B,XDC,CNY,N,,"From January 2002 onwards: monthly balance sheet of the People's Bank of China. Between 1993 and 2001: sum of foreign assets (net), claims against the government, bank claims on deposit money, claims against non-monetary financial institutions and claims on the non-financial sector. Before 2000: Almanac of China's finance and banking.",BIS-spliced,"In 2017, renminbi (RMB) accounts with international financial organisations are calculated on a net basis.",,3,9,,"Annual: 2002, 1999, 1993. Monthly: Jan 2002.",People's Bank of China; Bank for International Settlements.,5B0,"China - Central bank, assets, total, BIS-spliced",,E,2026-05,48380.69,,F,A,
M,CN,B,XDC,CNY,N,,"From January 2002 onwards: monthly balance sheet of the People's Bank of China. Between 1993 and 2001: sum of foreign assets (net), claims against the government, bank claims on deposit money, claims against non-monetary financial institutions and claims on the non-financial sector. Before 2000: Almanac of China's finance and banking.",BIS-spliced,"In 2017, renminbi (RMB) accounts with international financial organisations are calculated on a net basis.",,3,9,,"Annual: 2002, 1999, 1993. Monthly: Jan 2002.",People's Bank of China; Bank for International Settlements.,5B0,"China - Central bank, assets, total, BIS-spliced",,E,2026-06,49433.5,,F,A,
`;

test('the real BIS response parses, despite commas inside its quoted comment fields', () => {
  const series = parseBisMonthlySeries(BIS_RESPONSE);
  assert.deepEqual(series.map((entry) => [entry.date, entry.value]), [['2026-06-01', 49433.5], ['2026-05-01', 48380.69]], 'newest first');
});

test('CSV rows honour quoted commas, doubled quotes, line breaks in fields and CRLF endings', () => {
  assert.deepEqual(parseCsvRows('a,"b, c","say ""hi""","line\nbreak"\r\nx,,z\r\n'), [['a', 'b, c', 'say "hi"', 'line\nbreak'], ['x', '', 'z']]);
});

test('an empty observation is a missing month, not a zero', () => {
  const csv = 'TIME_PERIOD,OBS_VALUE\n2026-04,\n2026-05,100\nnot-a-month,5\n';
  assert.deepEqual(parseBisMonthlySeries(csv).map((entry) => entry.date), ['2026-05-01']);
  assert.throws(() => parseBisMonthlySeries('A,B\n1,2\n'), /TIME_PERIOD and OBS_VALUE/);
});
