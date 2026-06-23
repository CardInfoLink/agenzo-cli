import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { ApiClient } from '@agenzo/cli-core';

// @inquirer/prompts is mocked so the non-`--yes` confirm branches of book /
// cancel can be driven without a TTY. PromptEngine.resolveInput returns a
// supplied flag value directly, so password/input are never reached as long as
// tests pass --api-key (and --idempotency-key where a key is needed).
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));
import { confirm } from '@inquirer/prompts';

import { registerQuoteCommand } from '../src/ride-elife/quote.js';
import { registerBookCommand } from '../src/ride-elife/book.js';
import { registerRideGetCommand } from '../src/ride-elife/get.js';
import { registerCancelCommand } from '../src/ride-elife/cancel.js';
import { registerListOrdersCommand } from '../src/ride-elife/list-orders.js';
import { buildProgram, captureStdout, captureStderr, parseJsonOutput, mockApiClient } from './helpers.js';

const confirmMock = vi.mocked(confirm);

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENZO_FORMAT;
});

beforeEach(() => {
  confirmMock.mockReset();
});

// ============================================================
// Response fixtures (modeled on the v3 backend shapes — decimal amounts,
// from_location/to_location snake_case, etc.)
// ============================================================

const QUOTE_RESP = {
  vehicle_classes: [
    {
      vehicle_class: 'Sedan',
      price: { amount: 42.5, currency: 'USD', quote_id: 'qte_1' },
      passenger_capacity: 4,
      luggage_capacity: 2,
    },
  ],
  meet_and_greet: { available: true, price: { amount: 10, currency: 'USD' } },
  is_airport_transfer: true,
  airport_direction: 'dropoff',
};

const BOOK_RESP = {
  ride_id: 'ride_1',
  order_id: 'ord_1',
  status: 'Pending',
  is_scheduled: false,
  order_type: 'realtime',
  price: { amount: 42.5, currency: 'USD', quote_id: 'qte_1' },
  payment_status: 'ON_ACCOUNT',
  billing_entry_id: 'be_1',
};

const GET_RESP = {
  ride_id: 'ride_1',
  status: 'Accepted',
  source: 'mock',
  is_scheduled: false,
  from_location: { lat: 37.7937, lng: -122.3956, name: '1 Market St' },
  to_location: { lat: 37.6213, lng: -122.379, name: 'SFO Airport' },
  price: { amount: 42.5, currency: 'USD', quote_id: 'qte_1' },
};

const CANCEL_RESP = {
  ride_id: 'ride_1',
  ride_stat: 'Cancelled',
  cancellation: { cancellation_fee: 5, reversal_amount: 37.5, currency: 'USD' },
  refund_amount: 37.5,
};

const LIST_RESP = {
  orders: [
    {
      order_id: 'ord_1',
      ride_id: 'ride_1',
      status: 'Pending',
      vehicle_class: 'Sedan',
      is_scheduled: false,
      scheduled_at: '',
      price_amount: 42.5,
      final_amount: null,
      price_currency: 'USD',
      payment_status: 'ON_ACCOUNT',
      final_settlement_status: 'pending',
      cancellation_fee: null,
      provider: 'elife',
      created_at: null,
      updated_at: null,
    },
  ],
  total: 1,
  page: 1,
  page_size: 20,
};

// ============================================================
// Program builders
// ============================================================

type Mock = ReturnType<typeof mockApiClient>;

function rideProgram(apiClient: Mock) {
  const program = buildProgram();
  const ride = program.command('ride-elife');
  const deps = { apiClient: apiClient as unknown as ApiClient };
  registerQuoteCommand(ride, deps);
  registerBookCommand(ride, deps);
  registerRideGetCommand(ride, deps);
  registerCancelCommand(ride, deps);
  registerListOrdersCommand(ride, deps);
  return program;
}

const BASE = ['node', 'cli', 'ride-elife'];

// ============================================================
// 5.3 ride-elife quote (R, POST /ride/quote) — TC-QUOTE-01..10 + UT-BODY
// ============================================================

describe('ride-elife quote', () => {
  it('TC-QUOTE-01/02/03: happy path POSTs /ride/quote with number-ified coordinates + pickup_time', async () => {
    const api = mockApiClient({ '/ride/quote': QUOTE_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'quote',
      '--api-key', 'test-key',
      '--pickup-lat', '37.7937', '--pickup-lng', '-122.3956', '--pickup-name', '1 Market St',
      '--dropoff-lat', '37.6213', '--dropoff-lng', '-122.3790', '--dropoff-name', 'SFO Airport',
      '--pickup-time', 'now',
      '--format', 'json',
    ]);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(path).toBe('/ride/quote');
    expect(auth).toEqual({ type: 'api-key', key: 'test-key' });

    // TC-QUOTE-02: coordinates are numbers, NOT strings (§4.4.1.3).
    expect(body.pickup.lat).toBe(37.7937);
    expect(typeof body.pickup.lat).toBe('number');
    expect(body.pickup.lng).toBe(-122.3956);
    expect(body.pickup.name).toBe('1 Market St');
    expect(body.dropoff.lat).toBe(37.6213);
    // TC-QUOTE-01: pickup_time literal "now" preserved.
    expect(body.pickup_time).toBe('now');
  });

  it('TC-QUOTE-03: epoch pickup-time is number-ified', async () => {
    const api = mockApiClient({ '/ride/quote': QUOTE_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'quote', '--api-key', 'k',
      '--pickup-lat', '1', '--pickup-lng', '2', '--pickup-name', 'A',
      '--dropoff-lat', '3', '--dropoff-lng', '4', '--dropoff-name', 'B',
      '--pickup-time', '1735689600',
    ]);

    const body = api.post.mock.calls[0][2] as Record<string, any>;
    expect(body.pickup_time).toBe(1735689600);
    expect(typeof body.pickup_time).toBe('number');
  });

  it('TC-QUOTE-06: optional passenger/luggage fields are number-ified and only included when set', async () => {
    const api = mockApiClient({ '/ride/quote': QUOTE_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'quote', '--api-key', 'k',
      '--pickup-lat', '1', '--pickup-lng', '2', '--pickup-name', 'A',
      '--dropoff-lat', '3', '--dropoff-lng', '4', '--dropoff-name', 'B',
      '--pickup-time', 'now',
      '--passenger-count', '2', '--luggage-count', '1',
    ]);

    const body = api.post.mock.calls[0][2] as Record<string, any>;
    expect(body.passenger_count).toBe(2);
    expect(body.luggage_count).toBe(1);
    // Omitted optionals carry no key.
    expect(body).not.toHaveProperty('children_count');
    expect(body).not.toHaveProperty('passenger_email');
  });

  it('TC-QUOTE-07: json stdout carries QuoteResponse fields verbatim + profile/endpoint envelope; decimal amount preserved', async () => {
    const api = mockApiClient({ '/ride/quote': QUOTE_RESP });
    const program = rideProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'quote', '--api-key', 'k',
      '--pickup-lat', '1', '--pickup-lng', '2', '--pickup-name', 'A',
      '--dropoff-lat', '3', '--dropoff-lng', '4', '--dropoff-name', 'B',
      '--pickup-time', 'now', '--format', 'json',
    ]);

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload).toHaveProperty('profile');
    expect(payload).toHaveProperty('endpoint');
    expect(payload.is_airport_transfer).toBe(true);
    expect(payload.vehicle_classes[0].vehicle_class).toBe('Sedan');
    // Decimal currency units (NOT cents) — passed through unchanged.
    expect(payload.vehicle_classes[0].price.amount).toBe(42.5);
    expect(payload.vehicle_classes[0].price.quote_id).toBe('qte_1');
  });

  it('TC-QUOTE-04: missing required --dropoff-name throws PARAM_INVALID and sends no request', async () => {
    const api = mockApiClient();
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        ...BASE, 'quote', '--api-key', 'k',
        '--pickup-lat', '1', '--pickup-lng', '2', '--pickup-name', 'A',
        '--dropoff-lat', '3', '--dropoff-lng', '4',
        '--pickup-time', 'now',
      ]),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('TC-QUOTE-05: non-numeric coordinate throws PARAM_INVALID (must be a number) and sends no request', async () => {
    const api = mockApiClient();
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    let caught: any;
    try {
      await program.parseAsync([
        ...BASE, 'quote', '--api-key', 'k',
        '--pickup-lat', 'abc', '--pickup-lng', '2', '--pickup-name', 'A',
        '--dropoff-lat', '3', '--dropoff-lng', '4', '--dropoff-name', 'B',
        '--pickup-time', 'now',
      ]);
    } catch (e) {
      caught = e;
    }
    expect(caught?.code).toBe('PARAM_INVALID');
    expect(String(caught?.message)).toContain('must be a number');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('TC-QUOTE-09: json mode keeps the progress line off stderr', async () => {
    const api = mockApiClient({ '/ride/quote': QUOTE_RESP });
    const program = rideProgram(api);
    captureStdout();
    const err = captureStderr();

    await program.parseAsync([
      ...BASE, 'quote', '--api-key', 'k',
      '--pickup-lat', '1', '--pickup-lng', '2', '--pickup-name', 'A',
      '--dropoff-lat', '3', '--dropoff-lng', '4', '--dropoff-name', 'B',
      '--pickup-time', 'now', '--format', 'json',
    ]);

    expect(err.text()).toBe('');
    expect(err.text()).not.toContain('Fetching quotes');
  });

  it('TC-QUOTE-10: table mode emits the progress line on stderr', async () => {
    const api = mockApiClient({ '/ride/quote': QUOTE_RESP });
    const program = rideProgram(api);
    captureStdout();
    const err = captureStderr();

    await program.parseAsync([
      ...BASE, 'quote', '--api-key', 'k',
      '--pickup-lat', '1', '--pickup-lng', '2', '--pickup-name', 'A',
      '--dropoff-lat', '3', '--dropoff-lng', '4', '--dropoff-name', 'B',
      '--pickup-time', 'now', '--format', 'table',
    ]);

    expect(err.text()).toContain('Fetching quotes');
  });
});

// ============================================================
// 5.4 ride-elife book (W/Y, POST /ride/book) — TC-BOOK + Property 5
// ============================================================

describe('ride-elife book', () => {
  const bookArgs = (extra: string[] = []) => [
    ...BASE, 'book', '--api-key', 'test-key',
    '--quote-id', 'qte_1', '--vehicle-class', 'Sedan', '--price-amount', '42.50',
    '--passenger-name', 'Alice', '--passenger-phone', '+14155551234',
    ...extra,
  ];

  it('TC-BOOK-01/04/05: --yes happy path POSTs /ride/book with number price, default USD currency', async () => {
    const api = mockApiClient({ '/ride/book': BOOK_RESP });
    const program = rideProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync(bookArgs(['--yes', '--idempotency-key', 'book-123', '--format', 'json']));

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(path).toBe('/ride/book');
    expect(auth).toEqual({ type: 'api-key', key: 'test-key' });
    expect(body.quote_id).toBe('qte_1');
    expect(body.vehicle_class).toBe('Sedan');
    // TC-BOOK-05: price number-ified (decimal, not cents).
    expect(body.price_amount).toBe(42.5);
    expect(typeof body.price_amount).toBe('number');
    // TC-BOOK-04: default currency USD.
    expect(body.price_currency).toBe('USD');
    expect(body.passenger_name).toBe('Alice');
    expect(body.passenger_phone).toBe('+14155551234');
    // confirm skipped under --yes.
    expect(confirmMock).not.toHaveBeenCalled();

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.ride_id).toBe('ride_1');
    expect(payload).toHaveProperty('profile');
  });

  it('TC-BOOK-02: body NEVER contains payment_method_id or card fields (Property 5)', async () => {
    const api = mockApiClient({ '/ride/book': BOOK_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(bookArgs(['--yes', '--idempotency-key', 'book-123']));

    const body = api.post.mock.calls[0][2] as Record<string, any>;
    expect(body).not.toHaveProperty('payment_method_id');
    expect(body).not.toHaveProperty('card_number');
    expect(body).not.toHaveProperty('cvv');
    expect(body).not.toHaveProperty('card');
  });

  it('TC-BOOK-03: --payment-order-id is forwarded (pay_per_call); omitted otherwise (monthly_settlement)', async () => {
    const api = mockApiClient({ '/ride/book': BOOK_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(bookArgs(['--yes', '--idempotency-key', 'k1', '--payment-order-id', 'po_1']));
    expect((api.post.mock.calls[0][2] as Record<string, any>).payment_order_id).toBe('po_1');

    api.post.mockClear();
    await program.parseAsync(bookArgs(['--yes', '--idempotency-key', 'k2']));
    expect(api.post.mock.calls[0][2] as Record<string, any>).not.toHaveProperty('payment_order_id');
  });

  it('TC-BOOK-14: idempotency key is sent as the Idempotency-Key header, never in the body', async () => {
    const api = mockApiClient({ '/ride/book': BOOK_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(bookArgs(['--yes', '--idempotency-key', 'book-xyz']));

    const [, , body, headers] = api.post.mock.calls[0] as [string, unknown, Record<string, any>, Record<string, string>];
    expect(headers).toEqual({ 'Idempotency-Key': 'book-xyz' });
    expect(body).not.toHaveProperty('idempotency_key');
    expect(body).not.toHaveProperty('idempotencyKey');
    expect(body).not.toHaveProperty('Idempotency-Key');
  });

  it('TC-BOOK-09: arrival flight group is assembled when its flags are present', async () => {
    const api = mockApiClient({ '/ride/book': BOOK_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(
      bookArgs(['--yes', '--idempotency-key', 'k', '--arrival-flight-no', 'AA1', '--arrival-airline', 'AA']),
    );
    const body = api.post.mock.calls[0][2] as Record<string, any>;
    expect(body.arrival_flight).toEqual({ flight_no: 'AA1', airline: 'AA' });
  });

  it('TC-BOOK-06: missing required --passenger-phone throws PARAM_INVALID and sends no request', async () => {
    const api = mockApiClient({ '/ride/book': BOOK_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        ...BASE, 'book', '--api-key', 'k', '--yes', '--idempotency-key', 'k',
        '--quote-id', 'qte_1', '--vehicle-class', 'Sedan', '--price-amount', '42.50',
        '--passenger-name', 'Alice',
      ]),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('TC-BOOK-07: seat count out of the 0-5 range throws PARAM_INVALID', async () => {
    const api = mockApiClient({ '/ride/book': BOOK_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(bookArgs(['--yes', '--idempotency-key', 'k', '--child-seat-count', '6'])),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('TC-BOOK-10: non-`--yes` prompts confirm (default true); confirming proceeds to book', async () => {
    confirmMock.mockResolvedValue(true);
    const api = mockApiClient({ '/ride/book': BOOK_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(bookArgs(['--idempotency-key', 'book-123']));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const promptArg = confirmMock.mock.calls[0][0] as { message: string; default?: boolean };
    expect(promptArg.message).toContain('Book ride with quote qte_1');
    expect(promptArg.default).toBe(true);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('TC-BOOK-11: declining the confirm throws CLIENT_ABORTED and sends no request', async () => {
    confirmMock.mockResolvedValue(false);
    const api = mockApiClient({ '/ride/book': BOOK_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(bookArgs(['--idempotency-key', 'book-123'])),
    ).rejects.toMatchObject({ code: 'CLIENT_ABORTED' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('TC-BOOK-17: json mode keeps "Booking ride..." off stderr', async () => {
    const api = mockApiClient({ '/ride/book': BOOK_RESP });
    const program = rideProgram(api);
    captureStdout();
    const err = captureStderr();

    await program.parseAsync(bookArgs(['--yes', '--idempotency-key', 'k', '--format', 'json']));
    expect(err.text()).toBe('');
  });
});

// ============================================================
// 5.5 ride-elife get (R, GET /ride/<id>/status, non-watch only) — TC-GET-01..03
// ============================================================

describe('ride-elife get (non-watch)', () => {
  it('TC-GET-01: single-shot GET /ride/<id>/status with X-Api-Key auth', async () => {
    const api = mockApiClient({ '/ride/ride_1/status': GET_RESP });
    const program = rideProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([...BASE, 'get', '--api-key', 'test-key', '--order-id', 'ride_1', '--format', 'json']);

    expect(api.get).toHaveBeenCalledTimes(1);
    const [path, auth] = api.get.mock.calls[0] as [string, unknown];
    expect(path).toBe('/ride/ride_1/status');
    expect(auth).toEqual({ type: 'api-key', key: 'test-key' });

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload).toHaveProperty('profile');
    expect(payload).toHaveProperty('endpoint');
    expect(payload.ride_id).toBe('ride_1');
  });

  it('TC-GET-02: response keeps from_location/to_location (v3 snake_case) and the source marker', async () => {
    const api = mockApiClient({ '/ride/ride_1/status': GET_RESP });
    const program = rideProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([...BASE, 'get', '--api-key', 'k', '--order-id', 'ride_1', '--format', 'json']);

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload).toHaveProperty('from_location');
    expect(payload).toHaveProperty('to_location');
    expect(payload).not.toHaveProperty('from');
    expect(payload).not.toHaveProperty('to');
    expect(payload.from_location.name).toBe('1 Market St');
    expect(payload.source).toBe('mock');
    // Single-shot path carries the envelope (it is NOT a watch line stream).
    expect(payload).toHaveProperty('profile');
  });

  it('TC-GET-03: missing --order-id throws PARAM_INVALID and sends no request', async () => {
    const api = mockApiClient();
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([...BASE, 'get', '--api-key', 'k']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.get).not.toHaveBeenCalled();
  });
});

// ============================================================
// 5.6 ride-elife cancel (W/Y, POST /ride/<id>/cancel, no body) — TC-CANCEL
// ============================================================

describe('ride-elife cancel', () => {
  it('TC-CANCEL-01/02: --yes happy path POSTs /ride/<id>/cancel with NO body; key only in header', async () => {
    const api = mockApiClient({ '/ride/ride_1/cancel': CANCEL_RESP });
    const program = rideProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'cancel', '--api-key', 'test-key', '--yes',
      '--order-id', 'ride_1', '--idempotency-key', 'cancel-1', '--format', 'json',
    ]);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body, headers] = api.post.mock.calls[0] as [string, unknown, unknown, Record<string, string>];
    expect(path).toBe('/ride/ride_1/cancel');
    expect(auth).toEqual({ type: 'api-key', key: 'test-key' });
    // TC-CANCEL-02: no request body — the 3rd arg is undefined; key only in header.
    expect(body).toBeUndefined();
    expect(headers).toEqual({ 'Idempotency-Key': 'cancel-1' });

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.ride_id).toBe('ride_1');
    expect(payload.ride_stat).toBe('Cancelled');
    expect(payload.refund_amount).toBe(37.5);
  });

  it('TC-CANCEL-04: non-`--yes` confirm warns it may incur a fee (default false); confirming proceeds', async () => {
    confirmMock.mockResolvedValue(true);
    const api = mockApiClient({ '/ride/ride_1/cancel': CANCEL_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'cancel', '--api-key', 'k', '--order-id', 'ride_1', '--idempotency-key', 'cancel-1',
    ]);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const promptArg = confirmMock.mock.calls[0][0] as { message: string; default?: boolean };
    expect(promptArg.message).toContain('may incur a fee');
    expect(promptArg.message).toContain('Cancel ride ride_1');
    expect(promptArg.default).toBe(false);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('TC-CANCEL-05: declining the confirm throws CLIENT_ABORTED and sends no request', async () => {
    confirmMock.mockResolvedValue(false);
    const api = mockApiClient({ '/ride/ride_1/cancel': CANCEL_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        ...BASE, 'cancel', '--api-key', 'k', '--order-id', 'ride_1', '--idempotency-key', 'cancel-1',
      ]),
    ).rejects.toMatchObject({ code: 'CLIENT_ABORTED' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('TC-CANCEL-03: missing --order-id throws PARAM_INVALID and sends no request', async () => {
    const api = mockApiClient({ '/ride/ride_1/cancel': CANCEL_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([...BASE, 'cancel', '--api-key', 'k', '--yes', '--idempotency-key', 'cancel-1']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('TC-CANCEL-08: a null cancellation is passed through unchanged in json', async () => {
    const api = mockApiClient({
      '/ride/ride_1/cancel': { ride_id: 'ride_1', ride_stat: 'Cancelled', cancellation: null },
    });
    const program = rideProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'cancel', '--api-key', 'k', '--yes', '--order-id', 'ride_1',
      '--idempotency-key', 'cancel-1', '--format', 'json',
    ]);

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.cancellation).toBeNull();
  });
});

// ============================================================
// 5.7 ride-elife list-orders (R, GET /ride/orders, query passthrough) — TC-LIST
// ============================================================

describe('ride-elife list-orders', () => {
  it('TC-LIST-01/02: default pagination passes page=1 & page_size=20 as query params', async () => {
    const api = mockApiClient({ '/ride/orders': LIST_RESP });
    const program = rideProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([...BASE, 'list-orders', '--api-key', 'test-key', '--format', 'json']);

    expect(api.get).toHaveBeenCalledTimes(1);
    const [path, auth, params] = api.get.mock.calls[0] as [string, unknown, Record<string, string>];
    expect(path).toBe('/ride/orders');
    expect(auth).toEqual({ type: 'api-key', key: 'test-key' });
    expect(params).toEqual({ page: '1', page_size: '20' });

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload).toHaveProperty('profile');
    expect(payload.total).toBe(1);
    expect(payload.orders[0].price_amount).toBe(42.5);
  });

  it('TC-LIST-03: status / order-type filters are forwarded only when set', async () => {
    const api = mockApiClient({ '/ride/orders': LIST_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'list-orders', '--api-key', 'k',
      '--status', 'Pending', '--order-type', 'airport', '--page', '2', '--page-size', '10',
    ]);

    const params = api.get.mock.calls[0][2] as Record<string, string>;
    expect(params).toEqual({ page: '2', page_size: '10', status: 'Pending', order_type: 'airport' });
  });

  it('TC-LIST-04: invalid --page throws PARAM_INVALID and sends no request', async () => {
    const api = mockApiClient({ '/ride/orders': LIST_RESP });
    const program = rideProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([...BASE, 'list-orders', '--api-key', 'k', '--page', '0']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.get).not.toHaveBeenCalled();
  });
});
