import type { TriageProtocolRule } from '@prisma/client';
import {
  protocolFlags,
  type ProtocolFlag,
  type ProtocolComparison,
  type ProtocolReading,
  type TriageRule,
  type TriageRuleAdmin,
  type TriageRuleCreate,
  type VitalSigns,
} from '@neem/contracts';
import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit.service.ts';

/**
 * The approved triage protocol (slice 5c, brief §A3, D93).
 *
 * Empty until someone qualified has approved rules and the super administrator
 * has entered them. Flags inform the CHO's judgement and never replace it.
 */

function toRule(row: TriageProtocolRule): TriageRule {
  return {
    id: row.id,
    reading: row.reading as ProtocolReading,
    comparison: row.comparison as ProtocolComparison,
    threshold: row.threshold,
    suggestedCategory: row.suggestedCategory,
    message: row.message,
    source: row.source,
  };
}

export async function activeRules(db: Db = getPrisma()): Promise<TriageRule[]> {
  const rows = await db.triageProtocolRule.findMany({
    where: { retiredAt: null },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toRule);
}

export async function flagsFor(vitals: VitalSigns, db: Db = getPrisma()): Promise<ProtocolFlag[]> {
  return protocolFlags(await activeRules(db), vitals);
}

export async function listRules(db: Db = getPrisma()): Promise<TriageRuleAdmin[]> {
  const rows = await db.triageProtocolRule.findMany({
    orderBy: [{ retiredAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
  });
  return rows.map((row) => ({
    ...toRule(row),
    approvedBy: row.approvedBy,
    createdAt: row.createdAt.toISOString(),
    retiredAt: row.retiredAt?.toISOString() ?? null,
  }));
}

export async function addRule(
  input: TriageRuleCreate,
  actor: { userId: string; correlationId?: string },
  db: Db = getPrisma(),
): Promise<void> {
  const rule = await db.triageProtocolRule.create({
    data: {
      reading: input.reading,
      comparison: input.comparison,
      threshold: input.threshold,
      suggestedCategory: input.suggestedCategory ?? null,
      message: input.message,
      source: input.source,
      approvedBy: input.approvedBy,
      createdByUserId: actor.userId,
    },
  });
  await recordAudit(
    {
      action: AUDIT_ACTIONS.TRIAGE_RULE_ADDED,
      actorType: 'ADMIN',
      actorId: actor.userId,
      entityType: 'triage_protocol_rule',
      entityId: rule.id,
      correlationId: actor.correlationId,
      metadata: {
        reading: input.reading,
        comparison: input.comparison,
        threshold: input.threshold,
        source: input.source,
        approvedBy: input.approvedBy,
      },
    },
    db,
  );
}

export async function retireRule(
  id: string,
  actor: { userId: string; correlationId?: string },
  db: Db = getPrisma(),
  clock: Clock = systemClock,
): Promise<void> {
  const { count } = await db.triageProtocolRule.updateMany({
    where: { id, retiredAt: null },
    data: { retiredAt: clock.now(), retiredByUserId: actor.userId },
  });
  if (count === 0) throw errors.notFound('That rule is not in use.');
  await recordAudit(
    {
      action: AUDIT_ACTIONS.TRIAGE_RULE_RETIRED,
      actorType: 'ADMIN',
      actorId: actor.userId,
      entityType: 'triage_protocol_rule',
      entityId: id,
      correlationId: actor.correlationId,
      metadata: {},
    },
    db,
  );
}
