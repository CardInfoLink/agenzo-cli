/**
 * Documentation-presence smoke tests for hotel-redaug.
 *
 * Asserts that the README features table, the end-to-end example, and the
 * docs/ command matrix all reference the hotel-redaug verbs correctly.
 *
 * **Validates: Requirements 16.1, 16.3, 16.4**
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PKG_DIR = path.resolve(__dirname, '..');
const README = fs.readFileSync(path.join(PKG_DIR, 'README.md'), 'utf-8');
const MATRIX = fs.readFileSync(path.join(PKG_DIR, 'docs', 'test-design-command-matrix-v1.md'), 'utf-8');

describe('hotel-redaug documentation presence', () => {
  const HOTEL_VERBS = [
    'search',
    'find-destination',
    'hotel-filters',
    'list-cities',
    'hotel-detail',
    'quote',
    'book',
    'get',
    'cancel',
    'checkout',
    'get-checkout',
    'list-orders',
  ];

  it('README.md features table contains a row for each of the 12 hotel-redaug verbs', () => {
    for (const verb of HOTEL_VERBS) {
      // The README table format is: | `hotel-redaug` | `<verb>` | ...
      const escaped = verb.replace(/-/g, '\\-');
      const pattern = new RegExp(`hotel-redaug\`\\s*\\|\\s*\`${escaped}\``);
      expect(README).toMatch(pattern);
    }
  });

  it('README.md contains the end-to-end hotel-redaug example (search --api-key)', () => {
    expect(README).toContain('hotel-redaug search --api-key');
  });

  it('docs/test-design-command-matrix-v1.md contains the hotel-redaug Command Matrix section', () => {
    expect(MATRIX).toContain('hotel-redaug` Command Matrix');
  });
});
