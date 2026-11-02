import type { ReportTotals } from './report.ts';

/**
 * A report's figures as named indicators (slice 5d, D94).
 *
 * The ids are Neem's own and are not DHIMS2 data elements. An approved integration
 * maps them to whatever the national system defines, and the definitions stay here
 * rather than inside the reports, so neither has to change for the other.
 */
export interface ReportIndicator {
  id: string;
  label: string;
  value: number | null;
}

export function reportIndicators(totals: ReportTotals): ReportIndicator[] {
  const { attendance, consultations, referrals, followUps } = totals;
  return [
    { id: 'neem.visits', label: 'Visits', value: attendance.visits },
    { id: 'neem.patients.new', label: 'New patients registered', value: attendance.newPatients },
    { id: 'neem.patients.seen', label: 'Patients seen', value: attendance.patientsSeen },
    { id: 'neem.emergencies', label: 'Emergencies', value: attendance.emergencies },
    {
      id: 'neem.consultations.requested',
      label: 'Consultations requested',
      value: consultations.requested,
    },
    {
      id: 'neem.consultations.completed',
      label: 'Consultations completed',
      value: consultations.completed,
    },
    {
      id: 'neem.consultations.no-doctor',
      label: 'No doctor available',
      value: consultations.noDoctorAvailable,
    },
    {
      id: 'neem.consultations.wait-median',
      label: 'Median wait for a doctor (minutes)',
      value: consultations.waitMinutes.median,
    },
    { id: 'neem.referrals.issued', label: 'Referrals issued', value: referrals.issued },
    { id: 'neem.follow-ups.due', label: 'Follow-ups due', value: followUps.due },
    { id: 'neem.follow-ups.done', label: 'Follow-ups done', value: followUps.done },
    { id: 'neem.follow-ups.missed', label: 'Follow-ups missed', value: followUps.missed },
  ];
}
