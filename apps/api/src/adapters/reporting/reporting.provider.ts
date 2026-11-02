import type { ReportIndicator } from '@neem/contracts';

/**
 * Where an approved national reporting system would connect (slice 5d, D94).
 *
 * THERE IS NO INTEGRATION. Nothing calls this and nothing leaves Neem. It exists
 * so that DHIMS2, once Ghana Health Service approves an interface and supplies its
 * data elements, is one adapter to write rather than a change to the reports.
 * Neem must not claim otherwise (brief §E).
 */
export interface ReportingProvider {
  readonly name: string;
  readonly configured: boolean;
  /** One facility's figures for one period. */
  submit(input: {
    facilityCode: string;
    from: string;
    to: string;
    indicators: ReportIndicator[];
  }): Promise<{ accepted: boolean; reference: string | null }>;
}

export class NoReportingProvider implements ReportingProvider {
  readonly name = 'none';
  readonly configured = false;

  async submit(): Promise<{ accepted: boolean; reference: string | null }> {
    return { accepted: false, reference: null };
  }
}

export function getReportingProvider(): ReportingProvider {
  return new NoReportingProvider();
}
