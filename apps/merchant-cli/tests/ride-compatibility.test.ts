/**
 * Merchant_Cli compatibility smoke tests (Task 7.3).
 *
 * Verifies that the CLI commands still call the expected paths relative to
 * `/api/admin/v1` and that the contract snapshot response shapes from the
 * migrated platform backend are parsed by the CLI without TypeScript type
 * errors or runtime failures.
 *
 * These are smoke tests — they verify paths and field parsing, not full
 * business logic. The contract responses are taken from the platform's
 * ride_contract_snapshot.json (the migration oracle).
 *
 * Validates: Requirements 1.1, 2.2, 13.7
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { ApiClient } from '@agenzo/cli-core';

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
// Contract snapshot responses (from ride_contract_snapshot.json)
// These represent the exact shapes returned by the migrated platform backend.
// ============================================================

const CONTRACT_QUOTE_RESPONSE = {
  vehicle_classes: [
    {
      vehicle_class: 'Sedan',
      price: { amount: 42.5, currency: 'USD', quote_id: 'qte_abc123' },
      passenger_capacity: 4,
      luggage_capacity: 2,
    },
  ],
  meet_and_greet: { available: true, price: { amount: 10.0, currency: 'USD' } },
  is_airport_transfer: true,
  airport_direction: 'dropoff',
};

const CONTRACT_BOOK_RESPONSE = {
  ride_id: 'EL-1',
  order_id: 'rio_01JAKZ0000000000000000',
  status: 'INIT',
  is_scheduled: false,
  order_type: 'realtime',
  price: { amount: 42.5, currency: 'USD', quote_id: 'qte_abc123' },
  payment_status: 'ON_ACCOUNT',
  billing_entry_id: 'ble_01JAKZ0000000000000001',
};

const CONTRACT_STATUS_RESPONSE_LIVE = {
  ride_id: 'EL-1',
  status: 'Accepted',
  from_location: { lat: 37.7937, lng: -122.3956, name: '1 Market St' },
  to_location: { lat: 37.6213, lng: -122.379, name: 'SFO Airport' },
  pickup_time: 'now',
  vehicle_class: 'Sedan',
  price: { amount: 42.5, currency: 'USD', quote_id: 'qte_abc123' },
  driver: { name: 'John Driver', phone_number: '+14155559999' },
  vehicle: { make: 'Toyota', model: 'Camry', color: 'White', license_plate: 'ABC123' },
};

const CONTRACT_STATUS_RESPONSE_CACHE = {
  ride_id: 'EL-1',
  status: 'Accepted',
  source: 'local_cache',
  is_scheduled: false,
  price: { amount: 42.5, currency: 'USD', quote_id: 'qte_abc123' },
  final_amount: 42.5,
  final_settlement_status: 'pending',
  vehicle_class: 'Sedan',
  pickup_time: 'now',
  from_location: { lat: 37.7937, lng: -122.3956, name: '1 Market St' },
  to_location: { lat: 37.6213, lng: -122.379, name: 'SFO Airport' },
  driver: null,
  vehicle: null,
  created_at: '2026-06-11T00:00:00+00:00',
};

const CONTRACT_CANCEL_RESPONSE = {
  ride_id: 'EL-1',
  ride_stat: 'Cancelled',
  cancellation: {
    cancellation_fee: 5.0,
    reversal_amount: 37.5,
    currency: 'USD',
  },
  refund_amount: 37.5,
};

const CONTRACT_LIST_ORDERS_RESPONSE = {
  orders: [
    {
      order_id: 'rio_01JAKZ0000000000000000',
      ride_id: 'EL-1',
      status: 'Pending',
      vehicle_class: 'Sedan',
      is_scheduled: false,
      scheduled_at: '',
      price_amount: 42.5,
      final_amount: 42.5,
      price_currency: 'USD',
      payment_status: 'ON_ACCOUNT',
      final_settlement_status: 'pending',
      cancellation_fee: null,
      provider: 'elife',
      created_at: '2026-06-11T00:00:00+00:00',
      updated_at: '2026-06-11T00:00:00+00:00',
    },
  ],
  total: 1,
  page: 1,
  page_size: 20,
};

// ============================================================
// Program builder
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
// Compatibility smoke tests: path verification + response parsing
// ============================================================

describe('Merchant_Cli ride compatibility smoke tests', () => {
  describe('POST /ride/quote — path and response parsing', () => {
    it('calls /ride/quote and parses contract snapshot response without error', async () => {
      const api = mockApiClient({ '/ride/quote': CONTRACT_QUOTE_RESPONSE });
      const program = rideProgram(api);
      const out = captureStdout();
      captureStderr();

      await program.parseAsync([
        ...BASE, 'quote', '--api-key', 'test-key',
        '--pickup-lat', '37.7937', '--pickup-lng', '-122.3956', '--pickup-name', '1 Market St',
        '--dropoff-lat', '37.6213', '--dropoff-lng', '-122.379', '--dropoff-name', 'SFO Airport',
        '--pickup-time', 'now', '--format', 'json',
      ]);

      // Path verification
      expect(api.post).toHaveBeenCalledTimes(1);
      const [path] = api.post.mock.calls[0] as [string, ...unknown[]];
      expect(path).toBe('/ride/quote');

      // Response field parsing verification
      const payload = parseJsonOutput(out.text()) as Record<string, any>;
      expect(payload.vehicle_classes).toHaveLength(1);
      expect(payload.vehicle_classes[0].vehicle_class).toBe('Sedan');
      expect(payload.vehicle_classes[0].price.amount).toBe(42.5);
      expect(payload.vehicle_classes[0].price.currency).toBe('USD');
      expect(payload.vehicle_classes[0].price.quote_id).toBe('qte_abc123');
      expect(payload.vehicle_classes[0].passenger_capacity).toBe(4);
      expect(payload.vehicle_classes[0].luggage_capacity).toBe(2);
      expect(payload.meet_and_greet.available).toBe(true);
      expect(payload.meet_and_greet.price.amount).toBe(10.0);
      expect(payload.is_airport_transfer).toBe(true);
      expect(payload.airport_direction).toBe('dropoff');
    });
  });

  describe('POST /ride/book — path and response parsing', () => {
    it('calls /ride/book and parses contract snapshot response without error', async () => {
      const api = mockApiClient({ '/ride/book': CONTRACT_BOOK_RESPONSE });
      const program = rideProgram(api);
      const out = captureStdout();
      captureStderr();

      await program.parseAsync([
        ...BASE, 'book', '--api-key', 'test-key', '--yes',
        '--quote-id', 'qte_abc123', '--vehicle-class', 'Sedan', '--price-amount', '42.50',
        '--passenger-name', 'Alice', '--passenger-phone', '+14155551234',
        '--idempotency-key', 'compat-test-1', '--format', 'json',
      ]);

      // Path verification
      expect(api.post).toHaveBeenCalledTimes(1);
      const [path] = api.post.mock.calls[0] as [string, ...unknown[]];
      expect(path).toBe('/ride/book');

      // Response field parsing verification
      const payload = parseJsonOutput(out.text()) as Record<string, any>;
      expect(payload.ride_id).toBe('EL-1');
      expect(payload.order_id).toBe('rio_01JAKZ0000000000000000');
      expect(payload.status).toBe('INIT');
      expect(payload.is_scheduled).toBe(false);
      expect(payload.order_type).toBe('realtime');
      expect(payload.price.amount).toBe(42.5);
      expect(payload.price.currency).toBe('USD');
      expect(payload.price.quote_id).toBe('qte_abc123');
      expect(payload.payment_status).toBe('ON_ACCOUNT');
      expect(payload.billing_entry_id).toBe('ble_01JAKZ0000000000000001');
    });

    it('sends Idempotency-Key header (not in body) per contract', async () => {
      const api = mockApiClient({ '/ride/book': CONTRACT_BOOK_RESPONSE });
      const program = rideProgram(api);
      captureStdout();
      captureStderr();

      await program.parseAsync([
        ...BASE, 'book', '--api-key', 'test-key', '--yes',
        '--quote-id', 'qte_abc123', '--vehicle-class', 'Sedan', '--price-amount', '42.50',
        '--passenger-name', 'Alice', '--passenger-phone', '+14155551234',
        '--idempotency-key', 'idem-key-123',
      ]);

      const [, , body, headers] = api.post.mock.calls[0] as [string, unknown, Record<string, any>, Record<string, string>];
      expect(headers).toEqual({ 'Idempotency-Key': 'idem-key-123' });
      expect(body).not.toHaveProperty('idempotency_key');
      expect(body).not.toHaveProperty('Idempotency-Key');
    });
  });

  describe('GET /ride/{id}/status — path and response parsing', () => {
    it('calls /ride/{id}/status and parses live status contract response', async () => {
      const api = mockApiClient({ '/ride/EL-1/status': CONTRACT_STATUS_RESPONSE_LIVE });
      const program = rideProgram(api);
      const out = captureStdout();
      captureStderr();

      await program.parseAsync([
        ...BASE, 'get', '--api-key', 'test-key', '--order-id', 'EL-1', '--format', 'json',
      ]);

      // Path verification
      expect(api.get).toHaveBeenCalledTimes(1);
      const [path] = api.get.mock.calls[0] as [string, ...unknown[]];
      expect(path).toBe('/ride/EL-1/status');

      // Response field parsing verification (live status)
      const payload = parseJsonOutput(out.text()) as Record<string, any>;
      expect(payload.ride_id).toBe('EL-1');
      expect(payload.status).toBe('Accepted');
      expect(payload.from_location.lat).toBe(37.7937);
      expect(payload.from_location.lng).toBe(-122.3956);
      expect(payload.from_location.name).toBe('1 Market St');
      expect(payload.to_location.lat).toBe(37.6213);
      expect(payload.to_location.name).toBe('SFO Airport');
      expect(payload.pickup_time).toBe('now');
      expect(payload.vehicle_class).toBe('Sedan');
      expect(payload.price.amount).toBe(42.5);
      expect(payload.driver.name).toBe('John Driver');
      expect(payload.driver.phone_number).toBe('+14155559999');
      expect(payload.vehicle.make).toBe('Toyota');
      expect(payload.vehicle.license_plate).toBe('ABC123');
    });

    it('parses local_cache fallback response with source marker and settlement fields', async () => {
      const api = mockApiClient({ '/ride/EL-1/status': CONTRACT_STATUS_RESPONSE_CACHE });
      const program = rideProgram(api);
      const out = captureStdout();
      captureStderr();

      await program.parseAsync([
        ...BASE, 'get', '--api-key', 'test-key', '--order-id', 'EL-1', '--format', 'json',
      ]);

      const payload = parseJsonOutput(out.text()) as Record<string, any>;
      expect(payload.ride_id).toBe('EL-1');
      expect(payload.source).toBe('local_cache');
      expect(payload.is_scheduled).toBe(false);
      expect(payload.final_amount).toBe(42.5);
      expect(payload.final_settlement_status).toBe('pending');
      expect(payload.driver).toBeNull();
      expect(payload.vehicle).toBeNull();
      expect(payload.created_at).toBe('2026-06-11T00:00:00+00:00');
    });

    it('uses from_location/to_location (NOT from/to) per v3 contract', async () => {
      const api = mockApiClient({ '/ride/EL-1/status': CONTRACT_STATUS_RESPONSE_LIVE });
      const program = rideProgram(api);
      const out = captureStdout();
      captureStderr();

      await program.parseAsync([
        ...BASE, 'get', '--api-key', 'test-key', '--order-id', 'EL-1', '--format', 'json',
      ]);

      const payload = parseJsonOutput(out.text()) as Record<string, any>;
      expect(payload).toHaveProperty('from_location');
      expect(payload).toHaveProperty('to_location');
      expect(payload).not.toHaveProperty('from');
      expect(payload).not.toHaveProperty('to');
    });
  });

  describe('POST /ride/{id}/cancel — path and response parsing', () => {
    it('calls /ride/{id}/cancel and parses contract snapshot response', async () => {
      const api = mockApiClient({ '/ride/EL-1/cancel': CONTRACT_CANCEL_RESPONSE });
      const program = rideProgram(api);
      const out = captureStdout();
      captureStderr();

      await program.parseAsync([
        ...BASE, 'cancel', '--api-key', 'test-key', '--yes',
        '--order-id', 'EL-1', '--idempotency-key', 'cancel-compat-1', '--format', 'json',
      ]);

      // Path verification
      expect(api.post).toHaveBeenCalledTimes(1);
      const [path] = api.post.mock.calls[0] as [string, ...unknown[]];
      expect(path).toBe('/ride/EL-1/cancel');

      // Response field parsing verification
      const payload = parseJsonOutput(out.text()) as Record<string, any>;
      expect(payload.ride_id).toBe('EL-1');
      expect(payload.ride_stat).toBe('Cancelled');
      expect(payload.cancellation.cancellation_fee).toBe(5.0);
      expect(payload.cancellation.reversal_amount).toBe(37.5);
      expect(payload.cancellation.currency).toBe('USD');
      expect(payload.refund_amount).toBe(37.5);
    });

    it('sends Idempotency-Key header with no body per contract', async () => {
      const api = mockApiClient({ '/ride/EL-1/cancel': CONTRACT_CANCEL_RESPONSE });
      const program = rideProgram(api);
      captureStdout();
      captureStderr();

      await program.parseAsync([
        ...BASE, 'cancel', '--api-key', 'test-key', '--yes',
        '--order-id', 'EL-1', '--idempotency-key', 'cancel-key-xyz',
      ]);

      const [, , body, headers] = api.post.mock.calls[0] as [string, unknown, unknown, Record<string, string>];
      expect(body).toBeUndefined();
      expect(headers).toEqual({ 'Idempotency-Key': 'cancel-key-xyz' });
    });
  });

  describe('GET /ride/orders — path and response parsing', () => {
    it('calls /ride/orders and parses contract snapshot response', async () => {
      const api = mockApiClient({ '/ride/orders': CONTRACT_LIST_ORDERS_RESPONSE });
      const program = rideProgram(api);
      const out = captureStdout();
      captureStderr();

      await program.parseAsync([
        ...BASE, 'list-orders', '--api-key', 'test-key', '--format', 'json',
      ]);

      // Path verification
      expect(api.get).toHaveBeenCalledTimes(1);
      const [path] = api.get.mock.calls[0] as [string, ...unknown[]];
      expect(path).toBe('/ride/orders');

      // Response field parsing verification
      const payload = parseJsonOutput(out.text()) as Record<string, any>;
      expect(payload.orders).toHaveLength(1);
      const order = payload.orders[0];
      expect(order.order_id).toBe('rio_01JAKZ0000000000000000');
      expect(order.ride_id).toBe('EL-1');
      expect(order.status).toBe('Pending');
      expect(order.vehicle_class).toBe('Sedan');
      expect(order.is_scheduled).toBe(false);
      expect(order.scheduled_at).toBe('');
      expect(order.price_amount).toBe(42.5);
      expect(order.final_amount).toBe(42.5);
      expect(order.price_currency).toBe('USD');
      expect(order.payment_status).toBe('ON_ACCOUNT');
      expect(order.final_settlement_status).toBe('pending');
      expect(order.cancellation_fee).toBeNull();
      expect(order.provider).toBe('elife');
      expect(order.created_at).toBe('2026-06-11T00:00:00+00:00');
      expect(order.updated_at).toBe('2026-06-11T00:00:00+00:00');
      expect(payload.total).toBe(1);
      expect(payload.page).toBe(1);
      expect(payload.page_size).toBe(20);
    });

    it('forwards order_type query param for compatibility', async () => {
      const api = mockApiClient({ '/ride/orders': CONTRACT_LIST_ORDERS_RESPONSE });
      const program = rideProgram(api);
      captureStdout();
      captureStderr();

      await program.parseAsync([
        ...BASE, 'list-orders', '--api-key', 'test-key',
        '--order-type', 'airport', '--status', 'Pending',
      ]);

      const params = api.get.mock.calls[0][2] as Record<string, string>;
      expect(params.order_type).toBe('airport');
      expect(params.status).toBe('Pending');
    });
  });

  describe('decimal monetary amounts are preserved (not converted to cents)', () => {
    it('quote price.amount stays decimal', async () => {
      const api = mockApiClient({ '/ride/quote': CONTRACT_QUOTE_RESPONSE });
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
      // 42.5 USD, not 4250 cents
      expect(payload.vehicle_classes[0].price.amount).toBe(42.5);
      expect(payload.meet_and_greet.price.amount).toBe(10.0);
    });

    it('list-orders price_amount stays decimal', async () => {
      const api = mockApiClient({ '/ride/orders': CONTRACT_LIST_ORDERS_RESPONSE });
      const program = rideProgram(api);
      const out = captureStdout();
      captureStderr();

      await program.parseAsync([
        ...BASE, 'list-orders', '--api-key', 'k', '--format', 'json',
      ]);

      const payload = parseJsonOutput(out.text()) as Record<string, any>;
      // 42.5 USD, not 4250 cents
      expect(payload.orders[0].price_amount).toBe(42.5);
      expect(payload.orders[0].final_amount).toBe(42.5);
    });
  });
});
