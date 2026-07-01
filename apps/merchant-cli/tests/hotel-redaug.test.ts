import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { ApiClient } from '@agenzo/cli-core';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
}));
import { confirm } from '@inquirer/prompts';

import { registerHotelSearchCommand } from '../src/hotel-redaug/search.js';
import { registerHotelQuoteCommand } from '../src/hotel-redaug/quote.js';
import { registerHotelCreateOrderCommand } from '../src/hotel-redaug/create-order.js';
import { registerHotelGetCommand } from '../src/hotel-redaug/get.js';
import { registerHotelCancelCommand } from '../src/hotel-redaug/cancel.js';
import { registerHotelCheckoutCommand } from '../src/hotel-redaug/checkout.js';
import { registerHotelGetCheckoutCommand } from '../src/hotel-redaug/get-checkout.js';
import { registerHotelListOrdersCommand } from '../src/hotel-redaug/list-orders.js';
import { registerHotelFindDestinationCommand } from '../src/hotel-redaug/find-destination.js';
import { registerHotelFiltersCommand } from '../src/hotel-redaug/hotel-filters.js';
import { registerHotelListCitiesCommand } from '../src/hotel-redaug/list-cities.js';
import { registerHotelDetailCommand } from '../src/hotel-redaug/hotel-detail.js';
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
// Response fixtures
// ============================================================

const SEARCH_RESP = {
  hotels: [
    { hotel_id: 'h1', hotel_name: 'Grand Hotel', star: 5, address: '1 Main St', distance_km: 2.3, lowest_price: { amount: 320, currency: 'CNY' } },
  ],
};

const SEARCH_EMPTY_RESP = { hotels: [] };

const QUOTE_RESP = {
  rates: [
    { product_token: 'tok_1', room_name: 'Deluxe', total_price: { amount: 640, currency: 'CNY' }, price_items: [{ sale_date: '2026-03-01', sale_price: 320, breakfast_num: 2 }] },
  ],
};

const BOOK_RESP = {
  order_id: 'ord_h1', fc_order_code: 'fc_1', order_status: 'PROCESSING', rooms: [{ room_index: '1', guest_name: 'Alice' }], price: { amount: 640, currency: 'CNY' }, payment_status: 'ON_ACCOUNT', provider: 'redaug',
};

const GET_RESP = {
  order_id: 'ord_h1', fc_order_code: 'fc_1', order_status: 'CONFIRMED', order_status_code: 3, hotel_confirm_no: 'HCN123', hotel_name: 'Grand Hotel', source: 'provider',
};

const CANCEL_CONFIRMED_RESP = {
  order_id: 'ord_h1', order_status: 'CANCELLED', cancellation: { cancellation_fee: 50, reversal_amount: 590, currency: 'CNY' }, refund_amount: 590,
};

const CANCEL_PENDING_RESP = {
  order_id: 'ord_h1', order_status: 'PROCESSING', cancel_status: 'cancel_pending', cancel_result: { ack: true },
};

const CHECKOUT_RESP = {
  order_id: 'ord_h1', task_order_code: 'toc_1', apply_status: 'accepted', checkout_status: 'checkout_pending',
};

const GET_CHECKOUT_RESP = {
  task_order_code: 'toc_1', refund_status: 'approved', refund: { amount: 320, currency: 'CNY' },
};

const LIST_ORDERS_RESP = {
  orders: [{ order_id: 'ord_h1', fc_order_code: 'fc_1', status: 'CONFIRMED', provider: 'redaug', price_amount: 640, price_currency: 'CNY', payment_status: 'ON_ACCOUNT', created_at: '2026-01-01', updated_at: '2026-01-02' }],
  total: 1, page: 1, page_size: 20,
};

const FIND_DEST_RESP = {
  destinations: [{ destination_id: 'dest_1', type: 'city', name: 'Shanghai', city_name: 'Shanghai', city_code: 'SHA', country_name: 'China', lat: 31.23, lng: 121.47 }],
};

const FIND_DEST_EMPTY_RESP = { destinations: [] };

const FILTERS_RESP = {
  stars: [{ code: '5', name: '5 Star', count: 10 }], brands: [], groups: [], labels: [], sub_categories: [], hotel_facilities: [], room_facilities: [],
};

const LIST_CITIES_RESP = {
  cities: [{ city_code: 'SHA', city_name: 'Shanghai', destination_id: 'dest_sha', lat: 31.23, lng: 121.47, country_name: 'China', time_zone: 'Asia/Shanghai' }],
};

const HOTEL_DETAIL_RESP = {
  hotel_id: 'h1', hotel_name: 'Grand Hotel', hotel_eng_name: 'Grand Hotel', star: 5, address: '1 Main St', intro: 'A fine hotel', telephone: '123456', country_name: 'China', province_name: 'Shanghai', city_name: 'Shanghai', district_name: 'Pudong', business_name: 'Lujiazui', lat: 31.23, lng: 121.47, check_in_time: '14:00', check_out_time: '12:00', room_num: 200, facilities: [{ name: 'WiFi', type: 'hotel' }], images: [{ url: 'http://img.jpg', is_main: true }],
};

// ============================================================
// Program builder
// ============================================================

type Mock = ReturnType<typeof mockApiClient>;

function hotelProgram(apiClient: Mock) {
  const program = buildProgram();
  const hotel = program.command('hotel-redaug');
  const deps = { apiClient: apiClient as unknown as ApiClient };
  registerHotelSearchCommand(hotel, deps);
  registerHotelQuoteCommand(hotel, deps);
  registerHotelCreateOrderCommand(hotel, deps);
  registerHotelGetCommand(hotel, deps);
  registerHotelCancelCommand(hotel, deps);
  registerHotelCheckoutCommand(hotel, deps);
  registerHotelGetCheckoutCommand(hotel, deps);
  registerHotelListOrdersCommand(hotel, deps);
  registerHotelFindDestinationCommand(hotel, deps);
  registerHotelFiltersCommand(hotel, deps);
  registerHotelListCitiesCommand(hotel, deps);
  registerHotelDetailCommand(hotel, deps);
  return program;
}

const BASE = ['node', 'cli', 'hotel-redaug'];

// ============================================================
// search
// ============================================================

describe('hotel-redaug search', () => {
  it('happy path POSTs /hotel/search with correct body defaults (coord branch)', async () => {
    const api = mockApiClient({ '/hotel/search': SEARCH_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'search', '--api-key', 'k',
      '--lat', '31.23', '--lng', '121.47',
      '--check-in', '2026-03-01', '--check-out', '2026-03-03',
      '--format', 'json',
    ]);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(path).toBe('/hotel/search');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    expect(body.lat).toBe(31.23);
    expect(body.lng).toBe(121.47);
    expect(body.distance).toBe(20);
    expect(body.adults).toBe(2);
    expect(body.children).toBe(0);
    expect(body.room_num).toBe(1);
    expect(body.check_in).toBe('2026-03-01');
    expect(body.check_out).toBe('2026-03-03');
  });

  it('empty hotels list renders as success (exit 0)', async () => {
    const api = mockApiClient({ '/hotel/search': SEARCH_EMPTY_RESP });
    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'search', '--api-key', 'k',
      '--lat', '31.23', '--lng', '121.47',
      '--check-in', '2026-03-01', '--check-out', '2026-03-03',
      '--format', 'json',
    ]);

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.hotels).toEqual([]);
  });

  it('destination-id branch POSTs with destination_id, no lat/lng', async () => {
    const api = mockApiClient({ '/hotel/search': SEARCH_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'search', '--api-key', 'k',
      '--destination-id', 'dest_sha',
      '--check-in', '2026-03-01', '--check-out', '2026-03-03',
      '--format', 'json',
    ]);

    const body = api.post.mock.calls[0][2] as Record<string, any>;
    expect(body.destination_id).toBe('dest_sha');
    expect(body).not.toHaveProperty('lat');
    expect(body).not.toHaveProperty('lng');
  });

  it('missing both location branches throws PARAM_INVALID', async () => {
    const api = mockApiClient();
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        ...BASE, 'search', '--api-key', 'k',
        '--check-in', '2026-03-01', '--check-out', '2026-03-03',
      ]),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// quote
// ============================================================

describe('hotel-redaug quote', () => {
  it('happy path POSTs /hotel/quote with defaults (adults=2, nationality=CN)', async () => {
    const api = mockApiClient({ '/hotel/quote': QUOTE_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'quote', '--api-key', 'k',
      '--hotel-id', 'h1',
      '--check-in', '2026-03-01', '--check-out', '2026-03-03',
      '--format', 'json',
    ]);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(path).toBe('/hotel/quote');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    expect(body.hotel_id).toBe('h1');
    expect(body.adults).toBe(2);
    expect(body.children).toBe(0);
    expect(body.room_num).toBe(1);
    expect(body.nationality).toBe('CN');
  });

  it('missing --hotel-id throws PARAM_INVALID', async () => {
    const api = mockApiClient();
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        ...BASE, 'quote', '--api-key', 'k',
        '--check-in', '2026-03-01', '--check-out', '2026-03-03',
      ]),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// book
// ============================================================
// get
// ============================================================

describe('hotel-redaug get', () => {
  it('single-shot GET /hotel/{order_id}/status renders order_status and order_status_code', async () => {
    const api = mockApiClient({ '/hotel/ord_h1/status': GET_RESP });
    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'get', '--api-key', 'k', '--order-id', 'ord_h1', '--format', 'json',
    ]);

    expect(api.get).toHaveBeenCalledTimes(1);
    const [path, auth] = api.get.mock.calls[0] as [string, unknown];
    expect(path).toBe('/hotel/ord_h1/status');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.order_status).toBe('CONFIRMED');
    expect(payload.order_status_code).toBe(3);
    expect(payload.hotel_confirm_no).toBe('HCN123');
  });

  it('missing --order-id throws PARAM_INVALID', async () => {
    const api = mockApiClient();
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([...BASE, 'get', '--api-key', 'k']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.get).not.toHaveBeenCalled();
  });
});

// ============================================================
// cancel
// ============================================================

describe('hotel-redaug cancel', () => {
  it('--yes happy path POSTs /hotel/{order_id}/cancel with body and Idempotency-Key', async () => {
    const api = mockApiClient({ '/hotel/ord_h1/cancel': CANCEL_CONFIRMED_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'cancel', '--api-key', 'k', '--yes',
      '--order-id', 'ord_h1', '--fc-order-code', 'fc_1',
      '--reason', 'plans changed', '--idempotency-key', 'cancel-1',
      '--format', 'json',
    ]);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body, headers] = api.post.mock.calls[0] as [string, unknown, Record<string, any>, Record<string, string>];
    expect(path).toBe('/hotel/ord_h1/cancel');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    expect(body.fc_order_code).toBe('fc_1');
    expect(body.reason).toBe('plans changed');
    expect(headers).toEqual({ 'Idempotency-Key': 'cancel-1' });
  });

  it('declined confirmation → CLIENT_ABORTED, 0 requests', async () => {
    confirmMock.mockResolvedValue(false);
    const api = mockApiClient({ '/hotel/ord_h1/cancel': CANCEL_CONFIRMED_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([
        ...BASE, 'cancel', '--api-key', 'k',
        '--order-id', 'ord_h1', '--fc-order-code', 'fc_1', '--idempotency-key', 'c1',
      ]),
    ).rejects.toMatchObject({ code: 'CLIENT_ABORTED' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('--yes skips the prompt', async () => {
    const api = mockApiClient({ '/hotel/ord_h1/cancel': CANCEL_CONFIRMED_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'cancel', '--api-key', 'k', '--yes',
      '--order-id', 'ord_h1', '--fc-order-code', 'fc_1', '--idempotency-key', 'c1',
    ]);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('handles confirmed shape (cancellation/refund)', async () => {
    const api = mockApiClient({ '/hotel/ord_h1/cancel': CANCEL_CONFIRMED_RESP });
    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'cancel', '--api-key', 'k', '--yes',
      '--order-id', 'ord_h1', '--fc-order-code', 'fc_1', '--idempotency-key', 'c1',
      '--format', 'json',
    ]);

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.order_status).toBe('CANCELLED');
    expect(payload.cancellation.cancellation_fee).toBe(50);
    expect(payload.refund_amount).toBe(590);
  });

  it('handles pending shape (cancel_status)', async () => {
    const api = mockApiClient({ '/hotel/ord_h1/cancel': CANCEL_PENDING_RESP });
    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'cancel', '--api-key', 'k', '--yes',
      '--order-id', 'ord_h1', '--fc-order-code', 'fc_1', '--idempotency-key', 'c1',
      '--format', 'json',
    ]);

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.cancel_status).toBe('cancel_pending');
    expect(payload.order_status).toBe('PROCESSING');
  });
});

// ============================================================
// checkout
// ============================================================

describe('hotel-redaug checkout', () => {
  const checkoutArgs = (extra: string[] = []) => [
    ...BASE, 'checkout', '--api-key', 'k',
    '--order-id', 'ord_h1', '--fc-order-code', 'fc_1',
    '--reason', 'early departure',
    '--checkout-rooms', '[{"room_index":"1","guest_name":"Alice","cancel_check_in_date":"2026-03-02"}]',
    ...extra,
  ];

  it('--yes happy path POSTs /hotel/{order_id}/checkout with body and Idempotency-Key', async () => {
    const api = mockApiClient({ '/hotel/ord_h1/checkout': CHECKOUT_RESP });
    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync(checkoutArgs(['--yes', '--idempotency-key', 'co-1', '--format', 'json']));

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body, headers] = api.post.mock.calls[0] as [string, unknown, Record<string, any>, Record<string, string>];
    expect(path).toBe('/hotel/ord_h1/checkout');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    expect(body.fc_order_code).toBe('fc_1');
    expect(body.reason).toBe('early departure');
    expect(body.refund_type).toBe(1);
    expect(body.checkout_rooms).toEqual([{ room_index: '1', guest_name: 'Alice', cancel_check_in_date: '2026-03-02' }]);
    expect(headers).toEqual({ 'Idempotency-Key': 'co-1' });

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.task_order_code).toBe('toc_1');
  });

  it('declined confirmation → CLIENT_ABORTED, 0 requests', async () => {
    confirmMock.mockResolvedValue(false);
    const api = mockApiClient({ '/hotel/ord_h1/checkout': CHECKOUT_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync(checkoutArgs(['--idempotency-key', 'co-1'])),
    ).rejects.toMatchObject({ code: 'CLIENT_ABORTED' });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('--yes skips the prompt', async () => {
    const api = mockApiClient({ '/hotel/ord_h1/checkout': CHECKOUT_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync(checkoutArgs(['--yes', '--idempotency-key', 'co-1']));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// get-checkout
// ============================================================

describe('hotel-redaug get-checkout', () => {
  it('single-shot GET /hotel/checkout/{task_order_code} renders refund_status and refund', async () => {
    const api = mockApiClient({ '/hotel/checkout/toc_1': GET_CHECKOUT_RESP });
    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'get-checkout', '--api-key', 'k', '--task-order-code', 'toc_1', '--format', 'json',
    ]);

    expect(api.get).toHaveBeenCalledTimes(1);
    const [path] = api.get.mock.calls[0] as [string];
    expect(path).toBe('/hotel/checkout/toc_1');

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.refund_status).toBe('approved');
    expect(payload.refund.amount).toBe(320);
    expect(payload.refund.currency).toBe('CNY');
  });

  it('missing --task-order-code throws PARAM_INVALID', async () => {
    const api = mockApiClient();
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([...BASE, 'get-checkout', '--api-key', 'k']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.get).not.toHaveBeenCalled();
  });
});

// ============================================================
// list-orders
// ============================================================

describe('hotel-redaug list-orders', () => {
  it('default pagination passes page=1 & page_size=20 as query params', async () => {
    const api = mockApiClient({ '/hotel/orders': LIST_ORDERS_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([...BASE, 'list-orders', '--api-key', 'k', '--format', 'json']);

    expect(api.get).toHaveBeenCalledTimes(1);
    const [path, auth, params] = api.get.mock.calls[0] as [string, unknown, Record<string, string>];
    expect(path).toBe('/hotel/orders');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    expect(params).toEqual({ page: '1', page_size: '20' });
  });

  it('status filter is forwarded only when set', async () => {
    const api = mockApiClient({ '/hotel/orders': LIST_ORDERS_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'list-orders', '--api-key', 'k', '--status', 'CONFIRMED', '--page', '2', '--page-size', '10',
    ]);

    const params = api.get.mock.calls[0][2] as Record<string, string>;
    expect(params).toEqual({ page: '2', page_size: '10', status: 'CONFIRMED' });
  });

  it('invalid --page throws PARAM_INVALID and sends no request', async () => {
    const api = mockApiClient();
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([...BASE, 'list-orders', '--api-key', 'k', '--page', '0']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.get).not.toHaveBeenCalled();
  });
});

// ============================================================
// find-destination
// ============================================================

describe('hotel-redaug find-destination', () => {
  it('happy path POSTs /hotel/find-destination with keyword', async () => {
    const api = mockApiClient({ '/hotel/find-destination': FIND_DEST_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'find-destination', '--api-key', 'k', '--keyword', 'Shanghai', '--format', 'json',
    ]);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(path).toBe('/hotel/find-destination');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    expect(body.keyword).toBe('Shanghai');
    expect(body).not.toHaveProperty('data_type');
  });

  it('empty destinations → success (exit 0)', async () => {
    const api = mockApiClient({ '/hotel/find-destination': FIND_DEST_EMPTY_RESP });
    const program = hotelProgram(api);
    const out = captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'find-destination', '--api-key', 'k', '--keyword', 'xyz', '--format', 'json',
    ]);

    const payload = parseJsonOutput(out.text()) as Record<string, any>;
    expect(payload.destinations).toEqual([]);
  });

  it('missing --keyword throws PARAM_INVALID', async () => {
    const api = mockApiClient();
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([...BASE, 'find-destination', '--api-key', 'k']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// hotel-filters
// ============================================================

describe('hotel-redaug hotel-filters', () => {
  it('happy path POSTs /hotel/filters with coord branch', async () => {
    const api = mockApiClient({ '/hotel/filters': FILTERS_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'hotel-filters', '--api-key', 'k',
      '--lat', '31.23', '--lng', '121.47', '--format', 'json',
    ]);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(path).toBe('/hotel/filters');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    expect(body.lat).toBe(31.23);
    expect(body.lng).toBe(121.47);
    expect(body.distance).toBe(20);
  });

  it('missing location branch throws PARAM_INVALID', async () => {
    const api = mockApiClient();
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([...BASE, 'hotel-filters', '--api-key', 'k']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// list-cities
// ============================================================

describe('hotel-redaug list-cities', () => {
  it('happy path POSTs /hotel/cities with country_code', async () => {
    const api = mockApiClient({ '/hotel/cities': LIST_CITIES_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'list-cities', '--api-key', 'k', '--country', 'CN', '--format', 'json',
    ]);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(path).toBe('/hotel/cities');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    expect(body.country_code).toBe('CN');
  });

  it('missing --country throws PARAM_INVALID', async () => {
    const api = mockApiClient();
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([...BASE, 'list-cities', '--api-key', 'k']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// hotel-detail
// ============================================================

describe('hotel-redaug hotel-detail', () => {
  it('happy path POSTs /hotel/detail with hotel_id and with_images', async () => {
    const api = mockApiClient({ '/hotel/detail': HOTEL_DETAIL_RESP });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await program.parseAsync([
      ...BASE, 'hotel-detail', '--api-key', 'k', '--hotel-id', 'h1', '--format', 'json',
    ]);

    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, auth, body] = api.post.mock.calls[0] as [string, unknown, Record<string, any>];
    expect(path).toBe('/hotel/detail');
    expect(auth).toEqual({ type: 'api-key', key: 'k' });
    expect(body.hotel_id).toBe('h1');
    expect(body.with_images).toBe(true);
  });

  it('missing --hotel-id throws PARAM_INVALID', async () => {
    const api = mockApiClient();
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    await expect(
      program.parseAsync([...BASE, 'hotel-detail', '--api-key', 'k']),
    ).rejects.toMatchObject({ code: 'PARAM_INVALID' });
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ============================================================
// Error mapping: platform error code preserved
// ============================================================

describe('hotel-redaug error mapping', () => {
  it('platform error code preserved (e.g. NO_AVAILABILITY → exit 1)', async () => {
    const api = mockApiClient();
    api.post.mockResolvedValue({
      success: false,
      errorCode: 4301,
      errorMessage: 'No rooms available for this date',
      statusCode: 400,
      code: 'NO_AVAILABILITY',
    });
    const program = hotelProgram(api);
    captureStdout();
    captureStderr();

    let caught: any;
    try {
      await program.parseAsync([
        ...BASE, 'search', '--api-key', 'k',
        '--lat', '31.23', '--lng', '121.47',
        '--check-in', '2026-03-01', '--check-out', '2026-03-03',
      ]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('NO_AVAILABILITY');
  });
});
