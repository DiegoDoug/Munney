'use strict';
// Browser end-to-end smoke test with Playwright against a live server + fresh DB.
// Run: npm run test:e2e
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright-core');
const { createApp } = require('../server/app');

const EXECUTABLE = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

let server, browser, page, base;

before(async () => {
  server = createApp({ dbPath: ':memory:' });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: EXECUTABLE });
  page = await browser.newPage();
  page.on('pageerror', e => { throw new Error('page error: ' + e.message); });
});

after(async () => {
  await browser?.close();
  server?.close();
});

test('full flow: account -> transactions -> budget -> dashboard', async () => {
  await page.goto(base + '/#/');
  await page.waitForSelector('#nav');

  // --- create an account with an opening balance
  await page.click('#add-account');
  await page.fill('#m-name', 'Checking');
  await page.fill('#m-balance', '2500.00');
  await page.click('#m-save');
  await page.waitForSelector('.acct-link');
  assert.match(await page.textContent('.acct-link'), /Checking/);
  assert.match(await page.textContent('.acct-link .amt'), /\$2,500\.00/);

  // --- budget shows the opening balance as Ready to Assign
  await page.goto(base + '/#/budget');
  await page.waitForSelector('.rta-banner');
  assert.match(await page.textContent('.rta-banner .big'), /\$2,500\.00/);

  // --- assign $400 to Groceries
  const groceriesRow = page.locator('tr', { has: page.locator('td', { hasText: 'Groceries' }) }).first();
  const input = groceriesRow.locator('.assign-input');
  await input.fill('400');
  await input.press('Enter');
  await page.waitForFunction(() =>
    document.querySelector('.rta-banner .big')?.textContent.includes('$2,100.00'));

  // --- add a spending transaction
  await page.goto(base + '/#/transactions');
  await page.waitForSelector('#add-txn');
  await page.click('#add-txn');
  await page.fill('#m-payee', 'Kroger');
  await page.selectOption('#m-cat', { label: 'Groceries' });
  await page.fill('#m-amount', '123.45');
  await page.click('#m-save');
  await page.waitForSelector('td:has-text("Kroger")');
  assert.match(await page.textContent('tbody'), /-\$123\.45/);

  // --- budget reflects the spending: Available = 400 - 123.45
  await page.goto(base + '/#/budget');
  await page.waitForSelector('.rta-banner');
  const rowText = await page.locator('tr', { has: page.locator('td', { hasText: 'Groceries' }) }).first().textContent();
  assert.match(rowText, /\$276\.55/);

  // --- auto-categorization learned the payee: add another Kroger txn uncategorized
  await page.goto(base + '/#/transactions');
  await page.click('#add-txn');
  await page.fill('#m-payee', 'Kroger');
  await page.fill('#m-amount', '50');
  await page.click('#m-save');
  await page.waitForSelector('tbody tr');
  const catCell = await page.locator('tbody tr').first().locator('select').inputValue();
  const groceriesId = await page.evaluate(async () => {
    const c = await (await fetch('/api/categories')).json();
    return String(c.groups.flatMap(g => g.categories).find(x => x.name === 'Groceries').id);
  });
  assert.equal(catCell, groceriesId, 'new Kroger transaction should auto-categorize as Groceries');

  // --- dashboard renders the headline numbers
  await page.goto(base + '/#/');
  await page.waitForSelector('.tile');
  const dash = await page.textContent('#main');
  assert.match(dash, /net worth/i);
  assert.match(dash, /\$2,326\.55/); // 2500 - 123.45 - 50
  assert.match(dash, /ready to assign/i);

  // --- reports render charts without errors
  await page.goto(base + '/#/reports');
  await page.waitForSelector('h1:has-text("Reports")');
  await page.waitForFunction(() => document.querySelectorAll('#main svg').length >= 2);

  // --- CSV import round-trip
  await page.goto(base + '/#/transactions');
  await page.click('#import-csv');
  await page.fill('#m-csv', 'Date,Description,Amount\n2026-06-20,Coffee Shop,-4.50\n2026-06-21,Refund,12.00');
  await page.click('.modal #m-save');
  await page.waitForSelector('td:has-text("Coffee Shop")');

  // --- credit card: spending on the card funds its payment category
  await page.click('#add-account');
  await page.fill('#m-name', 'Visa');
  await page.selectOption('.modal #m-type', 'credit');
  await page.click('.modal #m-save');
  await page.waitForSelector('.acct-link:has-text("Visa")');

  await page.click('#add-txn');
  await page.selectOption('.modal #m-acct', { label: 'Visa' });
  await page.fill('#m-payee', 'Target Store');
  await page.selectOption('#m-cat', { label: 'Groceries' });
  await page.fill('#m-amount', '60');
  await page.click('.modal #m-save');
  await page.waitForSelector('td:has-text("Target Store")');

  await page.goto(base + '/#/budget');
  await page.waitForSelector('tr:has-text("Credit Card Payments")');
  const ccRow = page.locator('tr', { has: page.locator('.tag:has-text("payment")') }).first();
  assert.match(await ccRow.textContent(), /\$60\.00/, 'payment category should hold $60 for the card bill');

  // --- target-by-date goal shows a per-month suggestion
  const vacationRow = page.locator('tr', { has: page.locator('td', { hasText: 'Vacation' }) }).first();
  await vacationRow.locator('[data-target]').click();
  await page.selectOption('#m-type', 'by_date');
  await page.fill('#m-target', '1200');
  await page.fill('#m-date', '2027-05');
  await page.click('.modal #m-save');
  await page.waitForSelector('.goal-hint');
  assert.match(await page.locator('.goal-hint').first().textContent(), /\/mo to hit \$1,200\.00 by May 2027/);

  // --- age of money tile appears on the dashboard
  await page.goto(base + '/#/');
  await page.waitForSelector('.tile:has-text("AGE OF MONEY")');
});
