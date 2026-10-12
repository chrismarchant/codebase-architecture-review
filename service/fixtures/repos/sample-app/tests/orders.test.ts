import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { AppError } from '../src/errors.js';
import { CreateOrderBody } from '../src/server/routes/orders.js';
import { priceItems } from '../src/services/orderService.js';

describe('priceItems', () => {
  it('prices each line from the server-side catalogue', () => {
    const lines = priceItems([
      { sku: 'SKU-PRO', quantity: 2 },
      { sku: 'SKU-SUPPORT', quantity: 1 },
    ]);
    expect(lines).toEqual([
      { sku: 'SKU-PRO', name: 'Pro plan seat', quantity: 2, unitCents: 4900 },
      { sku: 'SKU-SUPPORT', name: 'Priority support add-on', quantity: 1, unitCents: 900 },
    ]);
  });

  it('rejects an unknown sku with a 422 AppError', () => {
    let caught: unknown;
    try {
      priceItems([{ sku: 'SKU-NOPE', quantity: 1 }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(422);
    expect((caught as AppError).code).toBe('unknown_sku');
  });
});

describe('CreateOrderBody', () => {
  it('accepts a well-formed body', () => {
    const parsed = CreateOrderBody.parse({ currency: 'GBP', items: [{ sku: 'SKU-BASIC', quantity: 3 }] });
    expect(parsed.items).toHaveLength(1);
  });

  it('rejects an empty item list', () => {
    expect(() => CreateOrderBody.parse({ currency: 'GBP', items: [] })).toThrow(ZodError);
  });

  it('rejects a quantity above 100', () => {
    expect(() => CreateOrderBody.parse({ currency: 'GBP', items: [{ sku: 'SKU-BASIC', quantity: 101 }] })).toThrow(
      ZodError,
    );
  });

  it('rejects an unsupported currency', () => {
    expect(() => CreateOrderBody.parse({ currency: 'JPY', items: [{ sku: 'SKU-BASIC', quantity: 1 }] })).toThrow(
      ZodError,
    );
  });
});
