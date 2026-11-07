import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
describe('1.10.74 Hisaab tool row keeps its size with or without PIN', () => {
  it('excel button is hidden (not removed) while amounts are hidden', () => {
    const src = readFileSync('src/screens/Hisaab.jsx', 'utf8');
    expect(src).not.toMatch(/\{showTotals && \(\s*<button[^>]*\s*type="button"\s*className="btn small icon-only"\s*data-testid="export-excel"/);
    expect(src).toMatch(/visibility: 'hidden'/);
  });
  it('total tiles shrink long amounts instead of cutting them', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toMatch(/\.total b \{ display: block; white-space: nowrap; font-size: clamp\(/);
    expect(css).toMatch(/\.total \{[^}]*min-width: 0/);
  });
});
