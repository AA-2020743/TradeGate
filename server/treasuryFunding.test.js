import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTreasuryFunding, cashBalanceSeries, dailyNetLiquidity, parseAmount, summarizeAuctions, summarizeCashBalance, summarizeDebt, summarizeInterestCost, summarizeMaturityWall } from './treasuryFunding.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-07T12:00:00Z');
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const TERMS = ['2-Year', '3-Year', '5-Year', '7-Year', '10-Year', '20-Year', '30-Year'];

/** Monthly auctions per tenor, newest first, with a chosen result for the latest. */
function auctionRows({ months = 30, latest = {}, history = () => ({}), fields = 'all' } = {}) {
  const rows = [];
  TERMS.forEach((term, termIndex) => {
    for (let month = 0; month < months; month += 1) {
      const date = iso(NOW - ((5 + termIndex + (month * 30)) * DAY));
      const base = { security_type: Number(term.split('-')[0]) >= 20 ? 'Bond' : 'Note', security_term: term, auction_date: date, offering_amt: '50000000000' };
      const values = month === 0 ? { cover: 2.5, indirect: 65, dealer: 15, ...latest[term] } : { cover: 2.5 + (((month * 7) % 11) - 5) * 0.03, indirect: 65 + ((month * 5) % 9) - 4, dealer: 15 + ((month * 3) % 7) - 3, ...history(term, month) };
      const row = { ...base, bid_to_cover_ratio: String(values.cover), high_yield: '4.5' };
      if (fields === 'all') {
        row.comp_accepted = '50000000000';
        row.indirect_bidder_accepted = String(50e9 * values.indirect / 100);
        row.primary_dealer_accepted = String(50e9 * values.dealer / 100);
      }
      rows.push(row);
    }
  });
  return rows;
}

test('numbers arrive as strings, with commas and "null"', () => {
  assert.equal(parseAmount('1,234.5'), 1234.5);
  assert.equal(parseAmount('null'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(undefined), null);
});

test('an announced auction with no result does not displace the latest completed one', () => {
  // The dataset lists upcoming auctions with an offering size and no outcome.
  // Reading the newest row as the latest result dropped the tenor every time
  // one was pending.
  const rows = auctionRows();
  rows.push({ security_type: 'Note', security_term: '3-Year', auction_date: iso(NOW + DAY), offering_amt: '58000000000', bid_to_cover_ratio: 'null', high_yield: 'null' });
  const summary = summarizeAuctions(rows, { now: NOW });
  const three = summary.tenors.find((tenor) => tenor.tenor === '3-Year');
  assert.equal(three.status, 'calculated');
  assert.equal(three.bidToCover, 2.5);
  assert.ok(three.date < iso(NOW));
  assert.equal(summary.pendingAuctions, 1);
});

test('a rank needs twelve prior auctions of the same tenor', () => {
  // About five per tenor is what survives when bills fill a mixed window; a
  // 0th percentile against five values is not evidence.
  const thin = summarizeAuctions(auctionRows({ months: 6 }), { now: NOW });
  assert.ok(thin.tenors.every((tenor) => tenor.bidToCoverPercentile === null));
  assert.equal(thin.status, 'unavailable');
  assert.match(thin.reason, /four tenors/);
  const full = summarizeAuctions(auctionRows({ months: 30 }), { now: NOW });
  assert.ok(full.tenors.every((tenor) => Number.isFinite(tenor.bidToCoverPercentile)));
  assert.ok(full.tenors.every((tenor) => tenor.priorAuctions === 24));
});

test('demand is ranked within each tenor, so a structurally low-cover tenor is not weak by default', () => {
  // A 30-year that always covers 2.3 and a 2-year that always covers 2.7 are
  // both normal. Ranked across tenors, the 30-year would read weak forever.
  const rows = auctionRows({ history: (term, month) => ({ cover: (term === '30-Year' ? 2.3 : 2.7) + (((month * 7) % 11) - 5) * 0.02 }), latest: { '30-Year': { cover: 2.3 }, '2-Year': { cover: 2.7 } } });
  const summary = summarizeAuctions(rows, { now: NOW });
  const thirty = summary.tenors.find((tenor) => tenor.tenor === '30-Year');
  assert.ok(thirty.bidToCoverPercentile > 25 && thirty.bidToCoverPercentile < 75, `30-year at its own norm ranked ${thirty.bidToCoverPercentile}`);
});

test('three tenors in their own bottom quarter is soft demand, and a high dealer takedown counts against', () => {
  const weak = { cover: 2.2, indirect: 55, dealer: 25 };
  const summary = summarizeAuctions(auctionRows({ latest: { '5-Year': weak, '7-Year': weak, '10-Year': weak } }), { now: NOW });
  assert.equal(summary.state, 'Soft demand');
  assert.deepEqual(summary.weakTenors.sort(), ['10-Year', '5-Year', '7-Year']);
  const five = summary.tenors.find((tenor) => tenor.tenor === '5-Year');
  assert.ok(five.dealerPercentile >= 90, 'heavy dealer takedown ranks high');
  assert.equal(five.measuresRanked, 3);
});

test('a missing demand field is reported as missing, not read as no signal', () => {
  // A misspelled field returns nothing on every row and looks exactly like an
  // uneventful auction. Coverage says which measures existed at all.
  const summary = summarizeAuctions(auctionRows({ fields: 'cover-only' }), { now: NOW });
  assert.equal(summary.coverage.indirect, false);
  assert.equal(summary.coverage.dealer, false);
  assert.deepEqual(summary.missingMeasures, ['indirect share', 'dealer takedown']);
  assert.equal(summary.status, 'provisional');
  assert.ok(summary.tenors.every((tenor) => tenor.measuresRanked === 1));
});

test('inflation-linked and floating-rate auctions never mix into a tenor', () => {
  const rows = auctionRows();
  rows.push({ security_type: 'TIPS', security_term: '10-Year', auction_date: iso(NOW - DAY), bid_to_cover_ratio: '9.9', comp_accepted: '1', indirect_bidder_accepted: '1', primary_dealer_accepted: '0' });
  rows.push({ security_type: 'Note', security_term: '2-Year', floating_rate: 'Yes', auction_date: iso(NOW - DAY), bid_to_cover_ratio: '9.9' });
  const summary = summarizeAuctions(rows, { now: NOW });
  assert.notEqual(summary.tenors.find((tenor) => tenor.tenor === '10-Year').bidToCover, 9.9);
  assert.notEqual(summary.tenors.find((tenor) => tenor.tenor === '2-Year').bidToCover, 9.9);
});

test('a reopening ranks with its tenor when the original term is published', () => {
  const rows = auctionRows();
  rows.push({ security_type: 'Note', security_term: '9-Year 10-Month', original_security_term: '10-Year', auction_date: iso(NOW - DAY), bid_to_cover_ratio: '2.61', comp_accepted: '1', indirect_bidder_accepted: '0.6', primary_dealer_accepted: '0.15' });
  const ten = summarizeAuctions(rows, { now: NOW }).tenors.find((tenor) => tenor.tenor === '10-Year');
  assert.equal(ten.bidToCover, 2.61);
});

const cashRows = (days, valueAt) => Array.from({ length: days }, (_, index) => ({ record_date: iso(NOW - ((days - 1 - index) * DAY)), account_type: 'Treasury General Account (TGA) Closing Balance', open_today_bal: String(valueAt(index)), close_today_bal: 'null' }));

test('the TGA closing balance is read from whichever column carries it, and other rows are ignored', () => {
  const rows = [...cashRows(40, () => 800000), { record_date: iso(NOW), account_type: 'Total TGA Deposits (Table II)', open_today_bal: '99999999' }];
  const series = cashBalanceSeries(rows);
  assert.equal(series.length, 40);
  assert.ok(series.every((point) => point.value === 800000));
});

test('a rising cash balance is reported as a drain on reserves', () => {
  const series = cashBalanceSeries(cashRows(400, (index) => 700000 + (index >= 372 ? 150000 : 0)));
  const cash = summarizeCashBalance(series);
  assert.equal(cash.change28Billions, 150);
  assert.equal(cash.liquidityEffect28Billions, -150);
  assert.equal(cash.billions, 850);
});

test('debt growth compares the last quarter annualized with the last year', () => {
  const rows = Array.from({ length: 400 }, (_, index) => ({ record_date: iso(NOW - ((399 - index) * DAY)), debt_held_public_amt: String(30e12 * (1.0002 ** index)), tot_pub_debt_out_amt: String(37e12 * (1.0002 ** index)) }));
  const debt = summarizeDebt(rows);
  assert.ok(Math.abs(debt.growth1yPercent - ((1.0002 ** 365 - 1) * 100)) < 0.05);
  assert.ok(Math.abs(debt.growth90dAnnualizedPercent - debt.growth1yPercent) < 0.1, 'a constant pace annualizes to the same rate');
});

test('interest cost reads the Total Marketable line and its year-on-year change', () => {
  const rows = [];
  for (let month = 0; month < 14; month += 1) {
    const date = iso(Date.UTC(2025, 7 + month, 28));
    rows.push({ record_date: date, security_desc: 'Total Marketable', avg_interest_rate_amt: String(3.2 + (month * 0.025)) });
    rows.push({ record_date: date, security_desc: 'Treasury Bills', avg_interest_rate_amt: '3.8' });
  }
  const interest = summarizeInterestCost(rows);
  assert.equal(interest.averageRate, 3.525);
  assert.equal(interest.change12mPoints, 0.3);
  assert.equal(interest.billsRate, 3.8);
});

test('the maturity wall uses only the latest statement and only unmatured securities', () => {
  const record = '2026-08-31';
  const rows = [];
  for (let index = 0; index < 100; index += 1) {
    rows.push({ record_date: record, maturity_date: iso(Date.parse(`${record}T00:00:00Z`) + ((30 + index * 40) * DAY)), outstanding_amt: '100000' });
  }
  rows.push({ record_date: record, maturity_date: '2026-08-15', outstanding_amt: '999999999' });
  rows.push({ record_date: '2026-07-31', maturity_date: '2027-01-01', outstanding_amt: '999999999' });
  const wall = summarizeMaturityWall(rows);
  assert.equal(wall.asOf, record);
  assert.equal(wall.securities, 100);
  // Maturities every 40 days from day 30: those at or under 365 days are 9.
  assert.equal(wall.within12mPercent, 9);
});

test('daily net liquidity carries the weekly Fed print at most seven days', () => {
  const cash = Array.from({ length: 60 }, (_, index) => ({ date: iso(NOW - ((59 - index) * DAY)), value: 800000 }));
  const fed = Array.from({ length: 9 }, (_, index) => ({ date: iso(NOW - ((59 - (index * 7)) * DAY)), value: 6_600_000 }));
  const reverseRepo = cash.map((point) => ({ date: point.date, value: 100000 }));
  const net = dailyNetLiquidity({ fed, reverseRepo, cash });
  assert.equal(net.status, 'calculated');
  assert.equal(net.trillions, 5.7);
  // Stop the Fed series three weeks early: the nowcast ends instead of freezing.
  const stopped = dailyNetLiquidity({ fed: fed.slice(0, 6), reverseRepo, cash });
  assert.ok(stopped.status === 'unavailable' || stopped.asOf < iso(NOW - (14 * DAY)));
});

test('the workspace degrades leg by leg and writes a read from what it has', () => {
  const funding = calculateTreasuryFunding({ auctions: auctionRows({ latest: { '5-Year': { cover: 2.2, indirect: 55, dealer: 25 }, '7-Year': { cover: 2.2, indirect: 55, dealer: 25 }, '10-Year': { cover: 2.2, indirect: 55, dealer: 25 } } }), cash: cashRows(400, (index) => 700000 + (index >= 372 ? 150000 : 0)), now: NOW });
  assert.equal(funding.status, 'provisional');
  assert.equal(funding.debt.status, 'unavailable');
  assert.match(funding.read, /soft demand/);
  assert.match(funding.read, /draining that much from bank reserves/);
});

test('every clause of the read stands on its own when the clause before it is omitted', () => {
  // The cash clause is written only for moves of $50bn or more. The net
  // liquidity clause used to say "over the same span", which pointed at
  // nothing whenever the cash move was smaller.
  const cash = Array.from({ length: 400 }, (_, index) => ({ record_date: iso(NOW - ((399 - index) * DAY)), account_type: 'Treasury General Account (TGA) Closing Balance', open_today_bal: String(800000 + (index >= 372 ? 20000 : 0)) }));
  const fed = Array.from({ length: 60 }, (_, index) => ({ date: iso(NOW - ((59 - index) * 7 * DAY)), value: 6_600_000 }));
  const reverseRepo = cash.map((row) => ({ date: row.record_date, value: 50000 }));
  const funding = calculateTreasuryFunding({ cash, fed, reverseRepo, now: NOW });
  assert.doesNotMatch(funding.read, /draining|adding that much/, 'small cash move should not be narrated');
  assert.doesNotMatch(funding.read, /same span/);
  assert.match(funding.read, /over four weeks/);
});
