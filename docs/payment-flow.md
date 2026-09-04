# Payment and Financial Flow

**Status:** Proposed (Phase 0). Provider: Paystack. All money flows to Neem.

---

## 1. Money representation

Every amount is an **integer number of pesewas** with an explicit currency. `GH₵ 45.00` is `4500`. No float, no decimal arithmetic, no currency-formatting round-trips in the financial path (spec §38, §98). Formatting for display happens once, at the edge.

Percentages are **basis points**: 30.00% is `3000`.

Split arithmetic:

```
pharmacyShare = floor(net × pharmacyPctBp / 10000)
neemShare     = net − pharmacyShare          // remainder always lands with Neem
assert(pharmacyShare + neemShare === net)    // enforced in code and in a unit test
```

The remainder rule is deliberate and documented: it makes the split exact and deterministic rather than losing a pesewa to rounding.

---

## 2. Payment sequence

```
1. Pharmacy creates consultation                    → PENDING_PAYMENT
2. Server computes price from system_settings,
   applies any validated promotion, stores
   priceMinor / discountMinor / netMinor
3. Server calls PaymentProvider.initialize()        → PAYMENT_PROCESSING
   (MoMo prompt to the patient's number, or a payment link/QR)
4. Patient pays
5. Paystack POSTs the webhook
6. Server verifies the signature against the RAW body
7. Server independently calls PaymentProvider.verify(reference)
   ← this result, not the webhook body, is authoritative
8. In ONE transaction:
      payment.status  = SUCCESS
      consultation    → PAID → ACTIVATED
      revenue_allocations row created
      consultation_access_token issued
      audit entries written
9. QR rendered from the raw token (which is never stored)
10. Patient scans
```

**A consultation is never activated because a client said the payment succeeded** (spec §34). The frontend's "payment complete" callback only triggers a status poll; it grants nothing.

---

## 3. Idempotency

Four independent mechanisms, because duplicate money events are the single most damaging class of bug here (spec §68, §103):

1. `payment_webhook_events.providerEventId` is **UNIQUE**. A replayed webhook fails to insert, is logged, and is acknowledged `200` without re-processing.
2. `payments.providerReference` is **UNIQUE**. One provider transaction can produce at most one payment row.
3. `revenue_allocations.paymentId` is **UNIQUE**. Revenue cannot be counted twice for one payment.
4. `refunds.providerRefundRef` is **UNIQUE**, and a state guard prevents a second refund against the same payment.

Every one of these is a database constraint, not an application check, so concurrency cannot defeat it.

Webhooks are also validated for signature **before** the body is parsed, and an invalid signature returns `401` and raises an admin alert (`PAYMENT_ANOMALY`).

---

## 4. Failure and expiry

| Event                     | Behaviour                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Payment declined          | Patient retries inside the 5-minute window; the consultation stays `PAYMENT_FAILED` and is retryable                  |
| Window elapses            | `EXPIRED`; provider session abandoned; temporary payment data cleaned up                                              |
| Late webhook after expiry | Payment recorded, consultation **not** revived, admin alert raised for reconciliation or refund                       |
| Paystack unreachable      | Consultation stays `PENDING_PAYMENT`; the pharmacy sees an explicit provider-unavailable state, never a false success |
| Amount mismatch           | Rejected, admin alert. The expected amount is recomputed server-side and compared                                     |

---

## 5. Revenue split

Default (seeded, admin-configurable — never hard-coded):

```
Patient pays 100% ──▶ Neem
                       ├─ 30%  pharmacy share   (revenue.pharmacySharePctBp = 3000)
                       └─ 70%  Neem             (revenue.neemSharePctBp    = 7000)
```

Doctors are **not** paid from the split. They receive configured salary/contract compensation and separately pay a six-month membership fee (spec §26, §39).

`revenue_allocations` stores the percentage **in force at calculation time**, so a later admin change does not retroactively alter historical splits. Changing a revenue percentage requires UI confirmation, writes to `system_setting_history`, and is audited (spec §96).

---

## 6. Pharmacy payouts

Calculated automatically, paid manually during the MVP (spec §40). The admin sees amount due per pharmacy per period, marks a payout processed with a reference, and the row moves `PENDING → PAID → RECONCILED`. `PayoutProcessor` is an interface with a `ManualPayoutProcessor` implementation today, so automation is an added adapter rather than a rewrite.

---

## 7. Refunds

Patient requests, admin decides — never automatic (spec §41).

```
patient requests → REQUESTED → admin reviews
                                 ├─ APPROVED → PROCESSING → COMPLETED
                                 │             (provider refund + reversal
                                 │              of the revenue allocation,
                                 │              in one transaction)
                                 └─ REJECTED (reason recorded, consultation
                                              returns to its prior state)
```

Refunds reverse the revenue allocation rather than deleting it, so the ledger stays additive and auditable.

---

## 8. Doctor membership

Six-month recurring fee via Paystack, amount configurable by Admin. Tracked in `doctor_subscriptions`: period, amount, payment reference, status, renewal, grace period. On expiry the daily job moves the doctor `ACTIVE → SUSPENDED` unless an admin has overridden it, and notifies both parties in advance (spec §27).

---

## 9. Doctor payroll

The system **calculates** payroll from `doctor_service_hours` and the doctor's configured employment type, rate, and contracted hours. It **never transfers doctor salary** (spec §26). The part-time formula is undecided, so no formula is hard-coded — the fields exist and the calculation is driven by admin configuration.

---

## 10. Reconciliation

An hourly job compares local payment records against the provider and records drift: provider-success-without-local-record, local-success-without-provider-record, and amount mismatches. Discrepancies raise admin alerts and appear on a reconciliation screen. Nothing is auto-corrected — the record of truth for money is never silently rewritten.
