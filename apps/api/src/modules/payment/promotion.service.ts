import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';

/**
 * Promotions (spec §42).
 *
 * Validation already lives where it must — inside consultation creation, on
 * the server, where a client cannot supply a discount amount. This module is
 * the other half: creating and withdrawing the codes that validation checks
 * against. Until it existed, `PROMOTION_MANAGE` was a permission with no route
 * and the only way to run a campaign was to write rows by hand.
 *
 * **A promotion is never deleted.** Withdrawing one deactivates it, because
 * consultations already reference it and the discount they received has to
 * remain explainable.
 */

export interface CreatePromotionInput {
  code: string;
  type: 'PERCENT' | 'FIXED';
  valueBp?: number;
  valueMinor?: number;
  startsAt: Date;
  endsAt: Date;
  maxUses?: number;
  pharmacyPublicId?: string;
  campaign?: string;
  minAmountMinor?: number;
}

export async function createPromotion(
  input: CreatePromotionInput,
  adminId: string,
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<{ code: string }> {
  if (input.endsAt <= input.startsAt) {
    throw errors.businessRule('The promotion ends before it starts.');
  }
  if (input.endsAt <= clock.now()) {
    throw errors.businessRule('That promotion would already have ended.');
  }

  /**
   * The value has to match the type.
   *
   * A PERCENT promotion carrying only `valueMinor` would validate, be stored,
   * and then discount nothing — `computeDiscount` reads the field its type
   * names. Refusing here means a campaign cannot be launched broken.
   */
  if (input.type === 'PERCENT') {
    if (input.valueBp === undefined) {
      throw errors.businessRule('A percentage promotion needs a percentage.');
    }
    if (input.valueBp <= 0 || input.valueBp > 10_000) {
      throw errors.businessRule('A percentage promotion must be between 0 and 100 per cent.');
    }
  } else {
    if (input.valueMinor === undefined) {
      throw errors.businessRule('A fixed promotion needs an amount.');
    }
    if (input.valueMinor <= 0) {
      throw errors.businessRule('A fixed promotion must be worth something.');
    }
  }

  let pharmacyId: string | null = null;
  if (input.pharmacyPublicId) {
    const pharmacy = await db.pharmacy.findUnique({
      where: { publicId: input.pharmacyPublicId },
      select: { id: true },
    });
    if (!pharmacy) throw errors.notFound('Pharmacy not found.');
    pharmacyId = pharmacy.id;
  }

  const code = input.code.trim().toUpperCase();

  try {
    await db.promotion.create({
      data: {
        code,
        type: input.type,
        valueBp: input.type === 'PERCENT' ? input.valueBp : null,
        valueMinor: input.type === 'FIXED' ? input.valueMinor : null,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        maxUses: input.maxUses ?? null,
        pharmacyId,
        campaign: input.campaign ?? null,
        minAmountMinor: input.minAmountMinor ?? 0,
        isActive: true,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw errors.conflict('A promotion with that code already exists.');
    }
    throw error;
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PROMOTION_CREATED,
      actorType: 'ADMIN',
      actorId: adminId,
      entityType: 'promotion',
      metadata: {
        code,
        type: input.type,
        valueBp: input.valueBp ?? null,
        valueMinor: input.valueMinor ?? null,
        endsAt: input.endsAt.toISOString(),
        scoped: Boolean(pharmacyId),
      },
    },
    db,
  );

  return { code };
}

/**
 * Withdraws a promotion.
 *
 * Deactivates rather than deletes: consultations reference it, and a discount
 * already given has to stay explainable. Redemptions already made are
 * untouched — withdrawing a code stops it being used again, and does not
 * retrospectively charge anyone the difference.
 */
export async function deactivatePromotion(
  code: string,
  adminId: string,
  db: Db = getPrisma(),
): Promise<{ code: string; isActive: boolean }> {
  const promotion = await db.promotion.findUnique({ where: { code } });
  if (!promotion) throw errors.notFound('Promotion not found.');

  if (!promotion.isActive) {
    return { code: promotion.code, isActive: false };
  }

  await db.promotion.update({ where: { id: promotion.id }, data: { isActive: false } });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.PROMOTION_DEACTIVATED,
      actorType: 'ADMIN',
      actorId: adminId,
      entityType: 'promotion',
      entityId: promotion.id,
      metadata: { code: promotion.code, usedCount: promotion.usedCount },
    },
    db,
  );

  return { code: promotion.code, isActive: false };
}

export interface PromotionListItem {
  code: string;
  type: string;
  valueBp: number | null;
  valueMinor: number | null;
  startsAt: string;
  endsAt: string;
  maxUses: number | null;
  usedCount: number;
  minAmountMinor: number;
  campaign: string | null;
  pharmacyName: string | null;
  isActive: boolean;
  /** True when active, within its window, and not exhausted. */
  redeemable: boolean;
  /** What has actually been given away under this code, in pesewas. */
  discountedMinor: number;
}

export async function listPromotions(
  filter: { activeOnly?: boolean; limit?: number },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<PromotionListItem[]> {
  const promotions = await db.promotion.findMany({
    where: filter.activeOnly ? { isActive: true } : {},
    include: {
      pharmacy: { select: { name: true } },
      redemptions: { select: { discountMinor: true } },
    },
    orderBy: [{ isActive: 'desc' }, { endsAt: 'desc' }],
    take: filter.limit ?? 100,
  });

  const now = clock.now();

  return promotions.map((promotion) => ({
    code: promotion.code,
    type: promotion.type,
    valueBp: promotion.valueBp,
    valueMinor: promotion.valueMinor,
    startsAt: promotion.startsAt.toISOString(),
    endsAt: promotion.endsAt.toISOString(),
    maxUses: promotion.maxUses,
    usedCount: promotion.usedCount,
    minAmountMinor: promotion.minAmountMinor,
    campaign: promotion.campaign,
    pharmacyName: promotion.pharmacy?.name ?? null,
    isActive: promotion.isActive,
    redeemable:
      promotion.isActive &&
      promotion.startsAt <= now &&
      promotion.endsAt >= now &&
      (promotion.maxUses === null || promotion.usedCount < promotion.maxUses),
    // What the campaign has cost, which is the number an administrator
    // actually needs and cannot get from `usedCount` alone.
    discountedMinor: promotion.redemptions.reduce((sum, row) => sum + row.discountMinor, 0),
  }));
}
