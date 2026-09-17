import type { PrismaClient } from '@prisma/client';
import { getPrisma, isUniqueConstraintError, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';

/**
 * What a patient can book, and what it costs (v2).
 *
 * The counter prices every consultation from one setting, because there is
 * one thing to buy. V2 sells several — a general consultation, and a
 * weight-loss consultation with a doctor, a dietitian or a trainer — at prices
 * that move independently, so the price belongs to the service rather than to
 * a global setting.
 *
 * The consultation keeps its own copy of what was charged (`priceMinor`), so a
 * price changed here never rewrites what somebody already paid. Nothing in
 * this module decides who may deliver a service; the discipline recorded here
 * is what a later phase will match professionals against.
 */

export interface ServiceView {
  code: string;
  name: string;
  description: string | null;
  clinic: string;
  discipline: string;
  price: { amountMinor: number; currency: string };
  durationSeconds: number | null;
  isActive: boolean;
}

interface ServiceRow {
  code: string;
  name: string;
  description: string | null;
  clinic: string;
  discipline: string;
  priceMinor: number;
  currency: string;
  durationSeconds: number | null;
  isActive: boolean;
}

function toView(row: ServiceRow): ServiceView {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    clinic: row.clinic,
    discipline: row.discipline,
    price: { amountMinor: row.priceMinor, currency: row.currency },
    durationSeconds: row.durationSeconds,
    isActive: row.isActive,
  };
}

export async function listServices(
  options: { activeOnly?: boolean } = {},
  db: Db = getPrisma(),
): Promise<ServiceView[]> {
  const rows = await db.service.findMany({
    where: options.activeOnly ? { isActive: true } : {},
    orderBy: [{ clinic: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
  });

  return rows.map(toView);
}

/**
 * The service a booking names, refused when it is unknown or withdrawn.
 *
 * The row rather than the view, for callers inside the API that need its id
 * and its price in pesewas — a booking has to record both.
 */
export async function bookableServiceRow(code: string, db: Db = getPrisma()) {
  const row = await db.service.findUnique({ where: { code } });

  if (!row) throw errors.notFound('That service does not exist.');
  if (!row.isActive) {
    throw errors.businessRule('That service is not currently offered.');
  }

  return row;
}

/** The same rule, shaped for anything that shows a service to a patient. */
export async function getBookableService(code: string, db: Db = getPrisma()): Promise<ServiceView> {
  return toView(await bookableServiceRow(code, db));
}

/**
 * A clinic is a grouping, not a table (v2, plan phase 8).
 *
 * The weight-loss clinic is three separately bookable consultations that
 * happen to belong together — a doctor, a dietitian and a personal trainer,
 * each booked and paid for on its own. What makes it a clinic is that a
 * patient sees them as one offer, so the name and the sentence live here,
 * beside the enum, rather than in a table with one row per value and nothing
 * else in it.
 *
 * It becomes a table the day a clinic needs something of its own — an opening
 * time, a picture, a policy. Not before.
 */
const CLINICS: Record<string, { name: string; description: string }> = {
  GENERAL: {
    name: 'General practice',
    description: 'A licensed Ghanaian doctor, for whatever you need one for.',
  },
  WEIGHT_LOSS: {
    name: 'Weight-loss clinic',
    description:
      'A doctor, a dietitian and a personal trainer. Book any of them, in any order, as often as you like.',
  },
};

export interface ClinicView {
  code: string;
  name: string;
  description: string;
  /** The cheapest way into this clinic, for a card that shows one figure. */
  fromPrice: { amountMinor: number; currency: string } | null;
  services: ServiceView[];
}

/**
 * What a patient is offered, grouped the way they are asked to think about it.
 *
 * A clinic with no bookable service is not shown at all. An empty clinic is
 * not an offer, and a card a patient can tap into and find nothing is worse
 * than no card.
 */
export async function listClinics(db: Db = getPrisma()): Promise<ClinicView[]> {
  const services = await listServices({ activeOnly: true }, db);
  const order = Object.keys(CLINICS);

  const grouped = new Map<string, ServiceView[]>();
  for (const service of services) {
    grouped.set(service.clinic, [...(grouped.get(service.clinic) ?? []), service]);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([code, offered]) => ({
      code,
      name: CLINICS[code]?.name ?? code,
      description: CLINICS[code]?.description ?? '',
      fromPrice: offered.reduce<ClinicView['fromPrice']>(
        (cheapest, service) =>
          !cheapest || service.price.amountMinor < cheapest.amountMinor ? service.price : cheapest,
        null,
      ),
      services: offered,
    }));
}

export interface ServiceInput {
  code: string;
  name: string;
  description?: string;
  clinic: 'GENERAL' | 'WEIGHT_LOSS';
  discipline: 'DOCTOR' | 'DIETITIAN' | 'TRAINER';
  priceMinor: number;
  currency?: string;
  durationSeconds?: number;
  sortOrder?: number;
}

export async function createService(
  input: ServiceInput,
  context: { adminId: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
): Promise<ServiceView> {
  try {
    const row = await db.service.create({
      data: {
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        clinic: input.clinic,
        discipline: input.discipline,
        priceMinor: input.priceMinor,
        currency: input.currency ?? 'GHS',
        durationSeconds: input.durationSeconds ?? null,
        sortOrder: input.sortOrder ?? 0,
      },
    });

    await recordAudit(
      {
        action: AUDIT_ACTIONS.SERVICE_CREATED,
        actorType: 'ADMIN',
        actorId: context.adminId,
        entityType: 'service',
        entityId: row.id,
        correlationId: context.correlationId,
        metadata: { code: row.code, priceMinor: row.priceMinor, currency: row.currency },
      },
      db,
    );

    return toView(row);
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw errors.conflict('A service with that code already exists.');
    }
    throw error;
  }
}

export interface ServicePatch {
  name?: string;
  description?: string | null;
  priceMinor?: number;
  durationSeconds?: number | null;
  isActive?: boolean;
  sortOrder?: number;
}

/**
 * A price change is money, so it is audited with what it was and what it became.
 * Consultations already priced keep their own snapshot and are untouched.
 */
export async function updateService(
  code: string,
  patch: ServicePatch,
  context: { adminId: string; correlationId?: string },
  db: PrismaClient = getPrisma(),
): Promise<ServiceView> {
  const existing = await db.service.findUnique({ where: { code } });
  if (!existing) throw errors.notFound('That service does not exist.');

  const row = await db.service.update({ where: { code }, data: patch });

  await recordAudit(
    {
      action: AUDIT_ACTIONS.SERVICE_UPDATED,
      actorType: 'ADMIN',
      actorId: context.adminId,
      entityType: 'service',
      entityId: row.id,
      correlationId: context.correlationId,
      metadata: {
        code: row.code,
        priceMinorBefore: existing.priceMinor,
        priceMinorAfter: row.priceMinor,
        isActiveBefore: existing.isActive,
        isActiveAfter: row.isActive,
      },
    },
    db,
  );

  return toView(row);
}
