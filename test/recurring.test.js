'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { detectSeries } = require('../server/recurring');

const t = (date, payee, cents) => ({ date, payee, amount_cents: cents, category_id: null });

test('detects a monthly subscription and predicts next charge', () => {
  const series = detectSeries([
    t('2026-03-15', 'Netflix.com', -1599),
    t('2026-04-15', 'Netflix.com', -1599),
    t('2026-05-15', 'Netflix.com', -1599),
    t('2026-06-15', 'Netflix.com', -1599),
  ], '2026-07-01');
  assert.equal(series.length, 1);
  const s = series[0];
  assert.equal(s.cadence, 'monthly');
  assert.equal(s.amount_cents, 1599);
  assert.equal(s.monthly_cost_cents, 1599);
  assert.equal(s.next_date, '2026-07-15');
  assert.equal(s.active, true);
});

test('ignores irregular spending', () => {
  const series = detectSeries([
    t('2026-01-03', 'Amazon', -2350),
    t('2026-01-19', 'Amazon', -899),
    t('2026-03-02', 'Amazon', -15000),
    t('2026-03-04', 'Amazon', -420),
  ], '2026-07-01');
  assert.equal(series.length, 0);
});

test('detects weekly cadence and scales monthly cost', () => {
  const series = detectSeries([
    t('2026-06-01', 'Yoga Studio', -2000),
    t('2026-06-08', 'Yoga Studio', -2000),
    t('2026-06-15', 'Yoga Studio', -2000),
    t('2026-06-22', 'Yoga Studio', -2000),
  ], '2026-06-25');
  assert.equal(series.length, 1);
  assert.equal(series[0].cadence, 'weekly');
  assert.equal(series[0].monthly_cost_cents, Math.round(2000 * 52 / 12));
});

test('marks a lapsed subscription inactive', () => {
  const series = detectSeries([
    t('2026-01-10', 'Hulu', -1799),
    t('2026-02-10', 'Hulu', -1799),
    t('2026-03-10', 'Hulu', -1799),
  ], '2026-07-01'); // no charge for ~4 months
  assert.equal(series.length, 1);
  assert.equal(series[0].active, false);
});

test('tolerates small amount variations (usage-based bills)', () => {
  const series = detectSeries([
    t('2026-03-01', 'City Power & Light', -8410),
    t('2026-04-01', 'City Power & Light', -9125),
    t('2026-05-01', 'City Power & Light', -8890),
    t('2026-06-01', 'City Power & Light', -9310),
  ], '2026-06-20');
  assert.equal(series.length, 1);
  assert.equal(series[0].cadence, 'monthly');
});

test('groups payees despite store numbers', () => {
  const series = detectSeries([
    t('2026-04-05', 'PLANET FIT #1234', -1000),
    t('2026-05-05', 'PLANET FIT #1240', -1000),
    t('2026-06-05', 'PLANET FIT #1234', -1000),
  ], '2026-06-20');
  assert.equal(series.length, 1);
  assert.equal(series[0].count, 3);
});
