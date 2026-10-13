// Headless smoke test of the built web app (not-configured screen) + screenshots of the
// signed-in screens via scripts/harness. Usage: node scripts/smoke.mjs <appUrl> <harnessUrl> <outDir>
import { chromium } from 'playwright';
const [appUrl, harnessUrl, out] = process.argv.slice(2);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(appUrl);
await page.waitForSelector('[data-testid=not-configured]', { timeout: 10000 });
const hi = await page.textContent('h2');
await page.screenshot({ path: `${out}/not-configured-hi.png` });
await page.click('.lang-toggle');
const en = await page.textContent('h2');
await page.reload();
await page.waitForSelector('[data-testid=not-configured]');
const enAfterReload = await page.textContent('h2');
await page.screenshot({ path: `${out}/not-configured-en.png` });
console.log(JSON.stringify({ hi, en, enAfterReload, errors }));
const shots = [['register', 'hi'], ['register', 'en'], ['hisaab', 'hi'], ['detail', 'en'], ['customers', 'hi'], ['settings', 'en'],
  ['welcome', 'hi'], ['welcome', 'en'], ['join', 'hi'], ['join', 'en'], ['setup', 'hi'], ['removed', 'hi'], ['removed', 'en'],
  ['settings', 'hi', 'pairing'], ['settings', 'en', 'nonowner']];
for (const [s, lang, variant] of shots) {
  const p2 = await ctx.newPage();
  const errs = [];
  p2.on('pageerror', (e) => errs.push(String(e)));
  await p2.goto(`${harnessUrl}?s=${s}&lang=${lang}${variant === 'nonowner' ? '&uid=p2' : ''}`);
  await p2.waitForTimeout(600);
  if (s === 'register') {
    await p2.locator('.btn.step').nth(5).click(); // + on 3rd row
    await p2.waitForTimeout(1500); // autosave fires
    const n = await p2.evaluate(() => window.__writes.length);
    console.log('register autosave writes:', n);
    await p2.evaluate(() => window.scrollTo(0, 0));
  }
  if (s === 'join') {
    await p2.fill('input[inputmode=numeric]', '482913');
    await p2.fill('input:not([inputmode])', lang === 'hi' ? 'भैया का फ़ोन' : "Bhaiya's phone");
    await p2.click('button[type=submit]');
    await p2.waitForSelector('[role=alert]');
    console.log('join (expired code) error:', await p2.textContent('[role=alert]'));
  }
  if (variant === 'pairing') {
    await p2.click('[data-testid=devices] .btn.primary.big');
    await p2.waitForSelector('[data-testid=pairing-code]');
    console.log('pairing code shown:', await p2.textContent('[data-testid=pairing-code]'));
    await p2.locator('[data-testid=devices]').scrollIntoViewIfNeeded();
  }
  if (s === 'settings') console.log('device rows:', await p2.locator('[data-testid=device-row]').count(), 'remove buttons:', await p2.locator('.device-row .btn.danger').count());
  const name = `${s}-${lang}${variant ? '-' + variant : ''}`;
  if (variant === 'pairing') await p2.locator('[data-testid=devices]').screenshot({ path: `${out}/${name}.png` });
  else await p2.screenshot({ path: `${out}/${name}.png`, fullPage: s !== 'register' });
  console.log(name, 'errors:', errs.length ? errs : 'none');
  await p2.close();
}
await browser.close();
