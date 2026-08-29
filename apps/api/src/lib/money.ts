/**
 * Money.
 *
 * Every amount in Neem is an integer number of minor units (pesewas for GHS)
 * with an explicit currency. There is no float anywhere in the financial path
 * (spec §38, §98). Percentages are basis points: 3000 = 30.00%.
 *
 * Formatting happens once, at the presentation edge — never as an intermediate
 * step in a calculation.
 */

export const BASIS_POINTS = 10_000;
export const DEFAULT_CURRENCY = 'GHS';

export interface Money {
  amountMinor: number;
  currency: string;
}

export function money(amountMinor: number, currency = DEFAULT_CURRENCY): Money {
  assertValidAmount(amountMinor);
  return { amountMinor, currency };
}

export function assertValidAmount(amountMinor: number): void {
  if (!Number.isInteger(amountMinor)) {
    throw new Error(`Monetary amounts must be integer minor units, received ${amountMinor}`);
  }
  if (!Number.isSafeInteger(amountMinor)) {
    throw new Error('Monetary amount is outside the safe integer range');
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot combine ${a.currency} with ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

/**
 * Applies a basis-point rate, rounding down.
 *
 * Rounding down is deliberate and paired with `splitRevenue`'s remainder rule
 * so that the parts of a split always sum exactly to the whole.
 */
export function applyBasisPoints(amountMinor: number, basisPoints: number): number {
  assertValidAmount(amountMinor);
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > BASIS_POINTS) {
    throw new Error(`Basis points must be an integer between 0 and ${BASIS_POINTS}`);
  }
  return Math.floor((amountMinor * basisPoints) / BASIS_POINTS);
}

export interface RevenueSplit {
  netMinor: number;
  pharmacyShareMinor: number;
  neemShareMinor: number;
  pharmacySharePctBp: number;
  currency: string;
}

/**
 * Splits consultation revenue between the pharmacy and Neem.
 *
 * The pharmacy share is floored and Neem takes the remainder, so the two parts
 * always sum to exactly `netMinor` — no pesewa is created or lost to rounding.
 * Doctors are NOT paid from this split; they receive configured salary or
 * contract compensation separately (spec §26, §39).
 *
 * The rate is passed in rather than read from settings here, so callers must
 * record which rate was in force — historical splits stay reproducible after
 * an admin changes the configuration.
 */
export function splitRevenue(
  netMinor: number,
  pharmacySharePctBp: number,
  currency = DEFAULT_CURRENCY,
): RevenueSplit {
  assertValidAmount(netMinor);
  if (netMinor < 0) {
    throw new Error('Cannot split a negative amount');
  }

  const pharmacyShareMinor = applyBasisPoints(netMinor, pharmacySharePctBp);
  const neemShareMinor = netMinor - pharmacyShareMinor;

  // Invariant, not a comment: the parts must reconstitute the whole.
  if (pharmacyShareMinor + neemShareMinor !== netMinor) {
    throw new Error('Revenue split failed its own invariant');
  }

  return { netMinor, pharmacyShareMinor, neemShareMinor, pharmacySharePctBp, currency };
}

export type DiscountRule =
  | { type: 'PERCENT'; valueBp: number }
  | { type: 'FIXED'; valueMinor: number };

/**
 * Computes a discount, clamped so the net can never go below zero and a
 * discount can never become a payout (spec §42).
 */
export function computeDiscount(priceMinor: number, rule: DiscountRule): number {
  assertValidAmount(priceMinor);
  if (priceMinor < 0) throw new Error('Price cannot be negative');

  const raw =
    rule.type === 'PERCENT'
      ? applyBasisPoints(priceMinor, rule.valueBp)
      : Math.max(0, Math.trunc(rule.valueMinor));

  return Math.min(raw, priceMinor);
}

export function applyDiscount(priceMinor: number, discountMinor: number): number {
  assertValidAmount(priceMinor);
  assertValidAmount(discountMinor);
  const net = priceMinor - discountMinor;
  if (net < 0) throw new Error('Discount exceeds price — this should have been clamped');
  return net;
}

/** Presentation only. Never feed the result back into a calculation. */
export function formatMoney(value: Money, locale = 'en-GH'): string {
  const major = value.amountMinor / 100;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: 2,
  }).format(major);
}

/** Parses major units from operator input (e.g. an admin typing "45.00"). */
export function parseMajorUnits(input: string): number {
  const trimmed = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(`"${input}" is not a valid amount`);
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
