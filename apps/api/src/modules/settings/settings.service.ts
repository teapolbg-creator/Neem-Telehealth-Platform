import { getPrisma, type Db } from '../../db/prisma.ts';
import { errors } from '../../lib/errors.ts';
import { DEFAULT_SETTINGS, type SettingKey } from './settings.defaults.ts';

/**
 * System settings (spec §56).
 *
 * Business configuration lives in the database, never as a literal in source.
 * Reads are cached briefly because settings are consulted on nearly every
 * request path (pricing, queue weights, the 40-hour ceiling) but change rarely.
 */

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  value: unknown;
  loadedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Falls back to the seeded default, so a missing row cannot break a request. */
function fallbackFor(key: SettingKey): unknown {
  const definition = DEFAULT_SETTINGS.find((setting) => setting.key === key);
  if (!definition) {
    throw new Error(`Unknown setting key: ${key}`);
  }
  return definition.value;
}

export async function getSetting<T = unknown>(
  key: SettingKey,
  db: Db = getPrisma(),
): Promise<T> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.value as T;
  }

  const row = await db.systemSetting.findUnique({ where: { key } });
  const value = row ? (row.value as T) : (fallbackFor(key) as T);

  cache.set(key, { value, loadedAt: Date.now() });
  return value;
}

export async function getNumberSetting(key: SettingKey, db: Db = getPrisma()): Promise<number> {
  const value = await getSetting(key, db);
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Setting ${key} is not numeric: ${JSON.stringify(value)}`);
  }
  return parsed;
}

export async function getIntSetting(key: SettingKey, db: Db = getPrisma()): Promise<number> {
  const value = await getNumberSetting(key, db);
  if (!Number.isInteger(value)) {
    throw new Error(`Setting ${key} must be an integer, got ${value}`);
  }
  return value;
}

/**
 * Invalidates the cache. Called after an admin changes a setting so the new
 * value takes effect immediately rather than up to the TTL later — a price or
 * revenue-share change must not apply to some requests and not others.
 */
export function invalidateSettingsCache(key?: SettingKey): void {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

export async function listSettings(db: Db = getPrisma()) {
  return db.systemSetting.findMany({ orderBy: [{ category: 'asc' }, { key: 'asc' }] });
}

/**
 * Updates a setting, recording the previous value in append-only history and
 * requiring a reason for the ones flagged as sensitive (spec §96).
 */
export async function updateSetting(
  key: SettingKey,
  value: unknown,
  context: { adminId: string; reason?: string },
  db: Db = getPrisma(),
): Promise<void> {
  const existing = await db.systemSetting.findUnique({ where: { key } });
  if (!existing) {
    throw errors.notFound('That setting does not exist.');
  }

  if (existing.requiresConfirm && !context.reason) {
    throw errors.businessRule(
      'This setting affects pricing, revenue or clinical routing. Provide a reason for the change.',
    );
  }

  await db.systemSetting.update({
    where: { key },
    data: { value: value as never, updatedByAdminId: context.adminId },
  });

  await db.systemSettingHistory.create({
    data: {
      key,
      oldValue: existing.value as never,
      newValue: value as never,
      adminId: context.adminId,
      reason: context.reason ?? null,
    },
  });

  invalidateSettingsCache(key);
}
