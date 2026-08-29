# Ghana Regulatory Register — UNVERIFIED

> **Read `README.md` first.** Every entry below is a *candidate* identified from general background knowledge, not from an official source. Titles, numbers, current amendments, and applicability are all unconfirmed. This is not legal advice.

**Verification status: one question answered, the rest NONE.** Open question 7 (clinical-record retention) was answered on 2026-08-29 by the product owner citing Medical & Dental Council sources, and the product design was changed to match (decision D23). That answer has **not** been confirmed by a qualified lawyer, and six follow-on questions it raises remain open. Everything else below is unverified background, not legal advice.

---

## 1. Candidate instruments

| # | Candidate instrument | Why it may apply to Neem | Confidence that it exists | Status |
| --- | --- | --- | --- | --- |
| G1 | Data Protection Act, 2012 (Act 843) — Data Protection Commission | Patient personal and health data; controller registration; consent; retention; cross-border transfer | Moderate–high | UNVERIFIED |
| G2 | Health Professions Regulatory Bodies Act, 2013 (Act 857) — establishes the Medical & Dental Council and the Pharmacy Council | Doctor licensing; pharmacy and pharmacist regulation; scope of practice | Moderate | UNVERIFIED |
| G3 | Health Institutions and Facilities Act, 2011 (Act 829) — HeFRA | Whether a telemedicine service constitutes a regulated health facility requiring licensing | Moderate | UNVERIFIED |
| G4 | Electronic Transactions Act, 2008 (Act 772) | Legal effect of electronic records and electronic signatures — directly relevant to e-prescriptions | Moderate | UNVERIFIED |
| G5 | Cybersecurity Act, 2020 (Act 1038) — Cyber Security Authority | Critical information infrastructure designation; incident reporting | Moderate | UNVERIFIED |
| G6 | Payment Systems and Services Act, 2019 (Act 987) — Bank of Ghana | Payment aggregation and mobile money; whether Neem's flow needs its own licence or is covered by Paystack's | Moderate | UNVERIFIED |
| G12 | Public Health Act, 2012 (Act 851) | Medicines control; possible notifiable-disease reporting obligations | Moderate | UNVERIFIED |
| G8 | MDC telemedicine practice guidelines (if any) | Standards for remote consultation, remote prescribing, identity verification, record-keeping | Low — existence unknown | UNVERIFIED |
| G9 | Pharmacy Council dispensing rules for electronic prescriptions | Whether an e-prescription is dispensable, what it must contain, substitution rules | Low — existence unknown | UNVERIFIED |
| G10 | National Communications Authority / consumer protection rules on SMS and WhatsApp messaging | Consent for transactional and marketing messages | Low | UNVERIFIED |
| G11 | Advertising rules for healthcare services | Constraints on how Neem may be marketed to patients | Low | UNVERIFIED |

---

## 2. Open questions for legal counsel

**Licensing and practice**

1. Does operating a telemedicine platform require its own facility or service licence, and from which body?
2. Are there specific MDC requirements for remote consultation and remote prescribing — patient identity verification, consultation records, minimum standards?
3. May a doctor lawfully prescribe to a patient they have assessed only by audio? Only by video? Does the mode matter?
4. Is a pharmacy permitted to dispense against a purely electronic prescription, and what must that prescription contain?
5. Does the pharmacy substitution workflow (pharmacy proposes, doctor approves) satisfy Pharmacy Council rules on generic and therapeutic substitution?

**Data protection**

6. Must Neem register as a data controller? What is the process and timeline?
7. ~~What is the **minimum** legally required retention period for medical consultation records?~~ **ANSWERED 2026-08-29 by the product owner from MDC sources: a minimum does exist.** Deleting notes at completion breaches the record-keeping duty on registered practitioners under Act 857 and destroys evidence needed during the 3-year civil window for negligence. The design was changed accordingly — see decision D23 and `data-retention.md`. **Still unconfirmed by counsel, and tracked as G7a–G7f in `data-retention.md` §10:** the exact period within the stated 3–6 year range; whether paediatric records carry a longer rule; whether a sealed archive with no clinician access discharges the duty when continuity of care is declined; the lawful basis and required form of patient notice; the access/erasure mechanism; and an acceptable backup window.
8. Is there a **maximum** retention limit for the prescription data Neem does keep?
9. What consent is required, and how must it be captured, for a patient whose consultation is initiated by a pharmacy?
10. Is the temporary patient session (no account, deleted after) compatible with data-subject access and erasure rights? How does a patient exercise those rights against a record that no longer exists?
11. Do backups containing purged data create an ongoing processing obligation, and what backup window is defensible?
12. Are there cross-border transfer restrictions that affect using Paystack, Twilio, or any non-Ghanaian cloud provider?

**Electronic signatures and prescriptions**

13. Does a signature drawn on-screen during onboarding meet the legal standard for a valid electronic signature on a prescription?
14. Must an e-prescription be verifiable by an independent party, and does a QR verification page satisfy that?
15. Are there record-keeping obligations for issued prescriptions distinct from consultation records?

**Payments**

16. Does Neem's payment flow require its own Bank of Ghana authorisation, or is Paystack's licence sufficient?
17. What are the retention obligations for financial records, and do they conflict with data-minimisation obligations?

**Security**

18. Would Neem be designated critical information infrastructure? What incident-reporting obligations follow?
19. Are there mandated breach-notification timelines and recipients?

---

## 3. Engineering implications

| Regulatory outcome | Impact on the build |
| --- | --- |
| A **minimum clinical-record retention period exists** | **Architectural.** The completion purge would have to become a scheduled purge after the mandated period, with encrypted retention and strict access control in the interim. Flagged now precisely so it does not surface late |
| Data-controller registration required | Operational, not architectural |
| Cross-border transfer restricted | May force in-country hosting and/or a different payment or telecoms provider — the provider abstractions absorb this |
| Drawn signature insufficient | Would require a certificate-based signing integration; the `signatureId` indirection on prescriptions and referrals already isolates this |
| E-prescriptions not dispensable electronically | Printed prescription becomes the primary artefact — already supported |
| Specific prescription content mandated | Field additions to `prescriptions` / `prescription_items` and the PDF template |
| CII designation | Incident reporting and monitoring obligations; the audit log and structured logging already provide the substrate |

---

## 4. Standing rules for the build

1. The UI makes **no claim of regulatory approval, endorsement, or compliance** unless there is a document to support it. The existing "Approved by the Ghana Medical & Dental Council" footer is removed in Phase 1 (decision D10).
2. Where the law is unknown, the design takes the **more protective** option — delete rather than keep, minimise rather than collect, restrict rather than share.
3. Every retention period, consent string, and disclosure rule is **configurable**, so a confirmed requirement becomes a configuration change rather than a migration.
4. No feature ships that depends on an assumed regulatory permission.
