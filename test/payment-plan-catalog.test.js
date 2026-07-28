import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const paymentPageUrl = new URL('../client/src/pages/PaymentPage.jsx', import.meta.url);
const paymentRouteUrl = new URL('../src/routes/payment.js', import.meta.url);
const benchmarkUrl = new URL('../scripts/compare-correction-models.js', import.meta.url);

test('basic plan price stays aligned across server, client, and margin benchmark', async () => {
  const [paymentPage, paymentRoute, benchmark] = await Promise.all([
    readFile(paymentPageUrl, 'utf8'),
    readFile(paymentRouteUrl, 'utf8'),
    readFile(benchmarkUrl, 'utf8'),
  ]);

  assert.match(
    paymentRoute,
    /basic: \{ credits: 100, price: 5900, name: '베이직 100분' \}/,
  );
  assert.match(
    paymentPage,
    /id: 'basic',[\s\S]*?originalPrice: 9900,[\s\S]*?salePrice: 5900,[\s\S]*?discount: 40,/,
  );
  assert.match(benchmark, /basic: 59,/);
});
