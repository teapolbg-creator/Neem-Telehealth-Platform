import type { PrismaClient } from '@prisma/client';
import { getPrisma } from '../../db/prisma.ts';
import { getLogger } from '../../lib/logger.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';
import { getPaymentProvider } from '../../adapters/payment/index.ts';

/**
 * Reconciliation (docs/payment-flow.md §10).
 *
 * Compares what Neem believes about recent payments against what the provider
 * says, and records every disagreement.
 *
 * **Nothing is corrected automatically.** That is the whole point: the record
 * of truth for money is never silently rewritten, because a bug that quietly
 * "fixes" a discrepancy destroys the evidence of what actually happened. Each
 * finding is an audited anomaly for a person to work through.
 *
 * A missing webhook is the ordinary case this catches — the provider took the
 * money, the webhook never arrived, and the consultation sits unactivated with
 * a patient who has paid.
 */

export type DriftKind =
  /** Provider says paid; we do not. Someone paid and got nothing. */
  | 'PROVIDER_SUCCESS_LOCAL_PENDING'
  /** We say paid; the provider does not. The more alarming direction. */
  | 'LOCAL_SUCCESS_PROVIDER_NOT'
  /** Both say paid, for different amounts. */
  | 'AMOUNT_MISMATCH'
  /** The provider could not be asked. Not drift; recorded so a silent run is distinguishable from a clean one. */
  | 'PROVIDER_UNREACHABLE';

export interface ReconciliationFinding {
  paymentId: string;
  providerReference: string;
  kind: DriftKind;
  localStatus: string;
  providerStatus?: string;
  localAmountMinor: number;
  providerAmountMinor?: number;
}

export interface ReconciliationResult {
  checked: number;
  findings: ReconciliationFinding[];
}

/**
 * How far back to look.
 *
 * Long enough to catch a webhook that never arrived and a provider that was
 * briefly unreachable; short enough that the job stays small. Payments older
 * than this have either settled or been expired by the payment-window sweep.
 */
const LOOKBACK_HOURS = 48;

export async function reconcilePayments(
  db: PrismaClient = getPrisma(),
  clock: Clock = systemClock,
): Promise<ReconciliationResult> {
  const since = new Date(clock.now().getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);

  const payments = await db.payment.findMany({
    where: {
      createdAt: { gte: since },
      // SUCCESS is included deliberately. A payment we think succeeded that
      // the provider has since reversed is the discrepancy that matters most,
      // and only checking the unsettled ones would never find it.
      status: { in: ['PENDING', 'PROCESSING', 'SUCCESS'] },
    },
    select: {
      id: true,
      providerReference: true,
      status: true,
      amountMinor: true,
    },
    take: 500,
  });

  const provider = getPaymentProvider();
  const findings: ReconciliationFinding[] = [];

  for (const payment of payments) {
    let verified;
    try {
      verified = await provider.verify(payment.providerReference);
    } catch (error) {
      findings.push({
        paymentId: payment.id,
        providerReference: payment.providerReference,
        kind: 'PROVIDER_UNREACHABLE',
        localStatus: payment.status,
        localAmountMinor: payment.amountMinor,
      });
      getLogger().warn(
        { err: error, providerReference: payment.providerReference },
        'reconciliation could not reach the payment provider',
      );
      continue;
    }

    const localSuccess = payment.status === 'SUCCESS';
    const providerSuccess = verified.status === 'SUCCESS';

    let kind: DriftKind | undefined;
    if (providerSuccess && !localSuccess) kind = 'PROVIDER_SUCCESS_LOCAL_PENDING';
    else if (localSuccess && !providerSuccess) kind = 'LOCAL_SUCCESS_PROVIDER_NOT';
    else if (localSuccess && providerSuccess && verified.amountMinor !== payment.amountMinor) {
      kind = 'AMOUNT_MISMATCH';
    }

    if (!kind) continue;

    findings.push({
      paymentId: payment.id,
      providerReference: payment.providerReference,
      kind,
      localStatus: payment.status,
      providerStatus: verified.status,
      localAmountMinor: payment.amountMinor,
      providerAmountMinor: verified.amountMinor,
    });
  }

  for (const finding of findings) {
    await recordAudit(
      {
        action: AUDIT_ACTIONS.PAYMENT_ANOMALY,
        actorType: 'SYSTEM',
        outcome: 'FAILURE',
        entityType: 'payment',
        entityId: finding.paymentId,
        metadata: {
          source: 'reconciliation',
          kind: finding.kind,
          localStatus: finding.localStatus,
          providerStatus: finding.providerStatus,
          localAmountMinor: finding.localAmountMinor,
          providerAmountMinor: finding.providerAmountMinor,
        },
      },
      db,
    );
  }

  return { checked: payments.length, findings };
}
