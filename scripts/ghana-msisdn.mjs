/**
 * A Ghanaian mobile number in the form an SMS gateway expects.
 *
 * The operational scripts are plain `.mjs` and deliberately do not import the
 * application's TypeScript — they must run with no build step. This is
 * therefore a second copy of
 * `apps/api/src/adapters/notification/ghana-msisdn.ts`, and a copy that drifts
 * is worse than no copy: a check would report a number as sendable that the
 * adapter then refuses, or the reverse.
 *
 * So `sms-msisdn-agreement.test.ts` compares the two case by case. Change one
 * and the test names the other.
 */
export function toGhanaMsisdn(raw) {
  const digits = String(raw).replace(/[\s()+-]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`;
  if (/^233\d{9}$/.test(digits)) return digits;
  if (/^[1-9]\d{8}$/.test(digits)) return `233${digits}`;
  return null;
}
