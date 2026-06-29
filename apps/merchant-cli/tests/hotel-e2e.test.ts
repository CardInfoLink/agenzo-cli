/**
 * Lightweight E2E validation test for hotel-redaug commands against the
 * testing profile (host: agent-test.everonet.com).
 *
 * SKIP-BY-DEFAULT: runs only when HOTEL_E2E_API_KEY env var is set.
 * This prevents CI failures when no test credentials are available.
 *
 * Feature: merchant-cli-hotel-redaug
 * Validates: Requirements 17.1, 17.4
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const API_KEY = process.env.HOTEL_E2E_API_KEY;

/**
 * Resolve the merchant-cli dist entry point. The compiled binary lives at
 * apps/merchant-cli/dist/index.js relative to the agenzo-cli workspace root.
 */
const CLI_BIN = resolve(__dirname, '../dist/index.js');

/** Helper: tomorrow's date as YYYY-MM-DD. */
function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Helper: day after tomorrow's date as YYYY-MM-DD. */
function dayAfterTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!API_KEY)('hotel-redaug E2E (testing profile)', () => {
  const checkIn = tomorrow();
  const checkOut = dayAfterTomorrow();

  it('search → exit 0, stdout is JSON with hotels array', () => {
    const result = execSync(
      `node ${CLI_BIN} hotel-redaug search ` +
        `--lat 31.23 --lng 121.47 ` +
        `--check-in ${checkIn} --check-out ${checkOut} ` +
        `--api-key ${API_KEY} --format json`,
      { encoding: 'utf-8', timeout: 30000 },
    );

    const parsed = JSON.parse(result.trim());
    expect(parsed).toHaveProperty('hotels');
    expect(Array.isArray(parsed.hotels)).toBe(true);
  });

  it('quote (first hotel from search) → exit 0, stdout is JSON with rates array', () => {
    // First, run search to get a hotel_id
    const searchResult = execSync(
      `node ${CLI_BIN} hotel-redaug search ` +
        `--lat 31.23 --lng 121.47 ` +
        `--check-in ${checkIn} --check-out ${checkOut} ` +
        `--api-key ${API_KEY} --format json`,
      { encoding: 'utf-8', timeout: 30000 },
    );

    const searchParsed = JSON.parse(searchResult.trim());
    const hotels = searchParsed.hotels;

    if (!hotels || hotels.length === 0) {
      // No hotels available — skip this assertion gracefully
      console.warn('No hotels returned by search; skipping quote E2E assertion.');
      return;
    }

    const hotelId = hotels[0].hotel_id;

    const quoteResult = execSync(
      `node ${CLI_BIN} hotel-redaug quote ` +
        `--hotel-id ${hotelId} ` +
        `--check-in ${checkIn} --check-out ${checkOut} ` +
        `--api-key ${API_KEY} --format json`,
      { encoding: 'utf-8', timeout: 30000 },
    );

    const quoteParsed = JSON.parse(quoteResult.trim());
    expect(quoteParsed).toHaveProperty('rates');
    expect(Array.isArray(quoteParsed.rates)).toBe(true);
  });

  // NOTE: Book is destructive (creates a real order with billing implications)
  // and is not safe for automated E2E without a teardown/cancel step.
  // Manual step: run book with a valid product_token from quote, then cancel.
});
