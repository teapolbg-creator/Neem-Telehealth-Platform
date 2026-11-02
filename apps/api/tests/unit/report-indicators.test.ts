import { describe, expect, it } from 'vitest';
import { reportIndicators, type ReportTotals } from '@neem/contracts';
import { getReportingProvider } from '../../src/adapters/reporting/reporting.provider.ts';

describe('reporting (D94)', () => {
  it("names a report's figures with ids of its own", () => {
    const totals = {
      attendance: { visits: 7, newPatients: 3, patientsSeen: 6, emergencies: 1 },
      consultations: {
        requested: 5,
        completed: 4,
        noDoctorAvailable: 1,
        waitMinutes: { median: null },
      },
      referrals: { issued: 2 },
      followUps: { due: 3, done: 2, missed: 1 },
    } as unknown as ReportTotals;

    const indicators = reportIndicators(totals);
    const value = (id: string) => indicators.find((entry) => entry.id === id)?.value;
    expect(value('neem.visits')).toBe(7);
    expect(value('neem.consultations.completed')).toBe(4);
    // Unknown is not zero.
    expect(value('neem.consultations.wait-median')).toBeNull();
    expect(new Set(indicators.map((entry) => entry.id)).size).toBe(indicators.length);
  });

  it('connects to nothing: no integration exists, and none is implied', async () => {
    const provider = getReportingProvider();
    expect(provider.configured).toBe(false);
    expect(
      await provider.submit({
        facilityCode: 'X',
        from: '2026-11-01',
        to: '2026-11-30',
        indicators: [],
      }),
    ).toEqual({ accepted: false, reference: null });
  });
});
