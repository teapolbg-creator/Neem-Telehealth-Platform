import { describe, expect, it } from 'vitest';
import {
  applyBasisPoints,
  applyDiscount,
  computeDiscount,
  formatMoney,
  money,
  parseMajorUnits,
  splitRevenue,
} from '../../src/lib/money.ts';

/**
 * Money is the part of the system where a rounding bug becomes a financial
 * discrepancy, so the invariants are tested directly rather than through the
 * payment flow (spec §80, §103).
 */

describe('money construction', () => {
  it('rejects non-integer amounts, which is how float bugs enter a ledger', () => {
    expect(() => money(45.5)).toThrow(/integer minor units/);
    expect(() => money(0.1 + 0.2)).toThrow();
  });

  it('accepts zero and negative integers (refunds and reversals)', () => {
    expect(money(0).amountMinor).toBe(0);
    expect(money(-4000).amountMinor).toBe(-4000);
  });
});

describe('applyBasisPoints', () => {
  it('computes exact percentages of whole amounts', () => {
    expect(applyBasisPoints(4000, 3000)).toBe(1200); // 30% of GH₵40.00
    expect(applyBasisPoints(4000, 7000)).toBe(2800);
    expect(applyBasisPoints(4000, 10_000)).toBe(4000);
    expect(applyBasisPoints(4000, 0)).toBe(0);
  });

  it('rounds down, pairing with the split remainder rule', () => {
    // 30% of 3333 pesewas is 999.9 — floored to 999.
    expect(applyBasisPoints(3333, 3000)).toBe(999);
  });

  it('rejects out-of-range basis points', () => {
    expect(() => applyBasisPoints(4000, 10_001)).toThrow();
    expect(() => applyBasisPoints(4000, -1)).toThrow();
    expect(() => applyBasisPoints(4000, 30.5)).toThrow();
  });
});

describe('splitRevenue', () => {
  it('applies the seeded 30/70 default', () => {
    const split = splitRevenue(4000, 3000);
    expect(split.pharmacyShareMinor).toBe(1200);
    expect(split.neemShareMinor).toBe(2800);
  });

  it('always reconstitutes the whole — no pesewa is created or lost', () => {
    // Every amount from 1 to 10,000 pesewas, at several rates.
    for (const rate of [0, 1, 2500, 3000, 3333, 5000, 7777, 10_000]) {
      for (let amount = 1; amount <= 10_000; amount += 7) {
        const split = splitRevenue(amount, rate);
        expect(split.pharmacyShareMinor + split.neemShareMinor).toBe(amount);
        expect(Number.isInteger(split.pharmacyShareMinor)).toBe(true);
        expect(Number.isInteger(split.neemShareMinor)).toBe(true);
        expect(split.pharmacyShareMinor).toBeGreaterThanOrEqual(0);
        expect(split.neemShareMinor).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('gives the rounding remainder to Neem, deterministically', () => {
    // 30% of 3333 = 999.9. Pharmacy floors to 999; Neem takes 2334, not 2333.
    const split = splitRevenue(3333, 3000);
    expect(split.pharmacyShareMinor).toBe(999);
    expect(split.neemShareMinor).toBe(2334);
  });

  it('records the rate in force so historical splits stay reproducible', () => {
    expect(splitRevenue(4000, 2500).pharmacySharePctBp).toBe(2500);
  });

  it('refuses to split a negative amount', () => {
    expect(() => splitRevenue(-100, 3000)).toThrow(/negative/);
  });

  it('handles a zero-value consultation without producing phantom revenue', () => {
    const split = splitRevenue(0, 3000);
    expect(split.pharmacyShareMinor).toBe(0);
    expect(split.neemShareMinor).toBe(0);
  });
});

describe('discounts', () => {
  it('computes percentage and fixed discounts', () => {
    expect(computeDiscount(4000, { type: 'PERCENT', valueBp: 1000 })).toBe(400);
    expect(computeDiscount(4000, { type: 'FIXED', valueMinor: 500 })).toBe(500);
  });

  it('clamps a discount to the price so a promotion can never become a payout', () => {
    expect(computeDiscount(4000, { type: 'FIXED', valueMinor: 99_999 })).toBe(4000);
    expect(computeDiscount(4000, { type: 'PERCENT', valueBp: 10_000 })).toBe(4000);
  });

  it('treats a negative fixed discount as zero rather than an increase', () => {
    expect(computeDiscount(4000, { type: 'FIXED', valueMinor: -1000 })).toBe(0);
  });

  it('never produces a negative net', () => {
    const discount = computeDiscount(4000, { type: 'FIXED', valueMinor: 10_000 });
    expect(applyDiscount(4000, discount)).toBe(0);
  });
});

describe('parsing and formatting', () => {
  it('parses operator input in major units', () => {
    expect(parseMajorUnits('45')).toBe(4500);
    expect(parseMajorUnits('45.00')).toBe(4500);
    expect(parseMajorUnits('45.5')).toBe(4550);
    expect(parseMajorUnits('1,250.75')).toBe(125_075);
  });

  it('rejects malformed amounts instead of coercing them', () => {
    expect(() => parseMajorUnits('45.123')).toThrow();
    expect(() => parseMajorUnits('abc')).toThrow();
    expect(() => parseMajorUnits('')).toThrow();
  });

  it('formats for display only', () => {
    // Assert the digits rather than the currency symbol, which varies by ICU build.
    expect(formatMoney(money(4000))).toContain('40.00');
  });
});
