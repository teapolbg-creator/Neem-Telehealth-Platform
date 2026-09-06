# Venture brief — how Neem operates, for counsel

**Prepared 2026-09-06.** Shared with counsel as
<https://claude.ai/code/artifact/c808ec91-e663-4f5f-95bc-1a2b19dc8e1c>
(the published version is the one they read; this file is the source of record).

---

## What this document is for

Counsel has been asked nineteen questions — five on retention and patient data
are instructed in full in [`counsel-brief-g7.md`](counsel-brief-g7.md), and the
rest are listed in [`ghana-regulatory-register.md`](ghana-regulatory-register.md).

Several of those questions cannot be answered without knowing how the system
actually behaves: whether a doctor sees a patient's history (they do not, and
cannot), what a pharmacy may do to a prescription (propose, never alter), what
reaches a third party (a generic label, never a name). This brief supplies that
context in one place, in terms a non-technical reader can act on.

**It states assumptions so they can be contradicted.** Where the design rests on
a belief about Ghanaian law that has not been confirmed, the brief says so rather
than presenting the design as settled.

## What it covers

| §   | Subject                                                                            |
| --- | ---------------------------------------------------------------------------------- |
| 1   | What Neem is — and that it is episodic, not longitudinal care                      |
| 2   | Commercial model: GH₵40 fee, 30/70 split, doctor membership                        |
| 3   | The three parties, and what each is prevented from seeing                          |
| 4   | The patient journey, and the consultation reference                                |
| 5   | The doctor: credentials, shifts, the 90-second offer, no decline, no visible score |
| 6   | The pharmacy: onboarding, vitals, dispensing, substitution                         |
| 7   | Prescriptions, referrals, and the public verification page                         |
| 8   | Data — destroyed at completion, sealed for the retention period, or permanent      |
| 9   | Structural controls: no recording, no history, sealed records, four-eyes retrieval |
| 10  | Third parties, and the cross-border question that blocks the hosting decision      |
| 11  | The questions, grouped, with what turns on each                                    |
| 12  | Terms used                                                                         |

## Two things it deliberately does not do

**It does not claim regulatory approval**, anywhere, for anything.

**It does not hide the weak points.** Three are called out on the face of the
document: that a name search against the prescriptions table is technically
possible for anyone with direct database access even though no product surface
offers it; that the video provider's own dashboard could enable recording
outside Neem's control; and that the lawful basis and patient notice are not yet
written because we do not know what they must say.

## Keeping it accurate

The brief describes the system as built on 2026-09-06. Material changes since
then — a provider swapped, a mode enabled, a retention period settled — make it
stale, and a stale brief to counsel is worse than none. Anything that changes
§8, §9 or §10 should be treated as requiring a reissue.
