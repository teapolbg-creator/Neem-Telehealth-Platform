# Smart Consultation Queue Engine

**Status:** Proposed (Phase 0).

The business document originally described "the first available doctor to accept gets the patient" and then argued against it in its own strategic recommendation; the answers document confirms the smart queue. **First-to-click is not implemented.**

---

## 1. Eligibility — a hard gate, evaluated before any scoring

A doctor is eligible only if **all** hold:

1. `doctor.status = ACTIVE`
2. Subscription is `ACTIVE` or within a configured grace period
3. MDC licence not expired (`mdcExpiresAt > now`)
4. Currently on a confirmed shift **and** present (recent heartbeat)
5. **Speaks the patient's selected language** (`doctor_languages`)
6. Current concurrent load below the configured maximum
7. Not already offered this consultation and not the doctor who just missed it

Language is a filter, never a weight. A doctor who does not speak the selected language cannot be assigned at any score (spec §29).

---

## 2. Scoring

Eligible doctors are ranked by a weighted sum of six normalised sub-scores, each in `[0,1]`, with weights read from `system_settings` and configurable by Admin (spec §28).

| Factor | Direction | Default weight | Computed from |
| --- | --- | --- | --- |
| Language proficiency | higher better | 0.30 | Primary vs secondary language for that doctor |
| Availability headroom | higher better | 0.20 | `1 − (currentLoad / maxLoad)` |
| Workload balance | lower load better | 0.20 | Consultations served this shift vs the shift median |
| Response time | faster better | 0.15 | Rolling median offer→accept latency |
| Recent consultation count | fewer better | 0.10 | Completed in the trailing 24h, for fair distribution |
| Quality score | higher better | 0.05 | `doctor_quality_scores.score` |

```
total = Σ (weightᵢ × subScoreᵢ)      weights sum to 1.0
```

Ties break on longest-idle, then lowest 24h count, then random — so a tie never systematically favours the same doctor. Every offer stores its `score` and full `scoreBreakdown` JSON on `consultation_assignments`, which makes fairness auditable and makes weight changes measurable.

The scoring function is **pure** — `(candidates, settings, clock) → ranked list` — with no I/O, so it is unit-testable exactly as spec §80 requires.

---

## 3. Offer cycle

```
enqueue
   │
   ├─▶ eligible = filter(all doctors)
   │        └─ empty? → stay queued, alert Admin, retry on the next presence change
   │
   ├─▶ ranked = score(eligible); pick top
   ├─▶ create assignment { respondByAt = now + 90s }   ← configurable
   ├─▶ notify doctor: socket + browser notification + sound + fallback channel
   │
   ├─ accepted within window  → ASSIGNED → DOCTOR_ACCEPTED
   └─ window elapses          → record MISSED_RESPONSE
                              → exclude this doctor for this consultation
                              → REASSIGNING → re-rank → next offer
```

The response window is enforced by the server, not the client. A `enforce-response-window` job sweeps every 5 seconds; the doctor's countdown UI is presentation only.

There is no decline endpoint (spec §30).

---

## 4. Escalation

| Attempts | Action |
| --- | --- |
| 1–2 | Silent reassignment |
| 3 | Admin alert: repeated non-response on one consultation |
| Any, no eligible doctor | Admin alert `NO_LANGUAGE_MATCH` with language, wait time, pharmacy |
| Wait exceeds a configured threshold | Admin alert `QUEUE_DELAY`; the patient is offered the option to cancel and request a refund |

Admin can intervene: manually assign an eligible doctor, activate an off-shift doctor, or approve a refund. Manual assignment is audited and still cannot bypass the language requirement.

The patient sees waiting status and elapsed time only — never queue position mechanics, doctor scores, or doctor performance data (spec §72).

---

## 5. Quality score

Computed hourly from `doctor_performance_events` over a rolling window. Inputs and default weights, all admin-configurable:

| Input | Weight | Effect |
| --- | --- | --- |
| Mean patient rating | 0.30 | ↑ |
| Complaint rate | 0.20 | ↓ |
| Median response time | 0.15 | ↑ when faster |
| Missed-response rate | 0.15 | ↓ |
| Completion rate | 0.10 | ↑ |
| Clinical/admin audit outcomes | 0.05 | ↑/↓ |
| Prescription issues (revocations, rejected substitutions) | 0.05 | ↓ |

New doctors start at the cohort median rather than zero, so the engine does not starve them of work before they have a record.

**Doctors never see their score or their ratings** (spec §24, §52). The API has no route that returns either to a doctor principal, and an authorization test asserts it.
