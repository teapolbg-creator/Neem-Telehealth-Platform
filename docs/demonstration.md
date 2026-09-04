# Demonstration script

A walkthrough of the full business cycle — pharmacy → patient → doctor → prescription → admin — on a freshly seeded machine. About 15 minutes.

Everything below is real: real payments through the mock provider, a real queue, a real clinical record sealed at completion. Nothing on any screen is a placeholder.

---

## Before you start

```bash
npm run setup     # install, containers, migrate, seed
npm run dev
```

**If you have run the tests on this machine, reset first.**

```bash
npm run db:reset
```

The end-to-end suite creates real doctors, real consultations and real shifts, because that is the only honest way to test them. It leaves them behind: after one run the admin directory holds twenty-five doctors called "Dr. Media 3e1b8849g", and night cover — which ships off — has been switched on. None of that is broken, and all of it makes a demonstration look like a test harness.

| | |
| --- | --- |
| Web | <http://localhost:8080> |
| Mail | <http://localhost:8025> |

The seed prints the demo accounts and what it created. Every row it makes carries `isDemo: true`.

**Two browser windows, one of them narrow.** The patient's portal is phone-first and the pharmacy's is not, so the demonstration is much clearer with a second window sized like a phone (or a device-emulation tab). The patient is a different person on a different device, and the software treats them that way.

**Mock providers are on.** No money moves, no SMS is sent, no video connects. Every screen that could imply otherwise says so — that is deliberate, and it is worth pointing at rather than apologising for.

---

## 1. The counter — a consultation and a payment

Sign in as **`akosua@pharmacy.demo`** / `NeemDemo!2026`.

The dashboard opens on real figures: consultations in progress, prescriptions waiting at the counter, and the pharmacy's own share awaiting payout. **This pharmacy sees only its own** — there is a second pharmacy in the seed, and nothing of its data appears here.

1. **New consultation**. No patient details are asked for. The pharmacy never types the patient's name; that happens on the patient's own phone (spec §10).
2. **Request payment**, then **Simulate successful payment**. The mock-provider notice is on screen throughout: no money has moved, and the product says so.
3. The consultation opens only once the **server** has confirmed the payment with the provider. Nothing the browser observed is trusted (spec §34).

> **Worth saying out loud:** the price came from `system_settings`, not from a constant in the code. An administrator can change it later in this demonstration and the next consultation will cost the new amount.

---

## 2. The patient's phone — a QR code and consent

The screen now shows a QR code. **Copy the link** and open it in the phone-sized window.

1. **Details**: name, age, sex, phone. This is the first time the patient's identity exists anywhere.
2. **Language**. The patient will only be matched with a doctor who speaks it.
3. **How would you like to consult** — audio, video, or *Call Me*.
4. They land in the waiting room.

Three things to point at:

- **The code works once.** Reload the link: it is refused, with the same message an unknown code gets. A photographed QR cannot be replayed (D6).
- **The URL carries no patient data** — no name, no consultation id, no price. Just a token (spec §60).
- **Reissuing invalidates the old code**, which is also the "patient lost their phone" path.

---

## 3. The doctor — an offer that cannot be declined

Sign in as **`ama@doctor.demo`** in the first window.

1. **Go online.** A doctor is only offered consultations during a confirmed shift.
2. The offer arrives with a **90-second countdown**.
3. There is **one button: Accept.** There is no decline, anywhere, because spec §30 says a doctor may not reject an assigned consultation. Look for the button; its absence is the feature.

> If no offer arrives, the doctor has no shift today. Put them on one at **Admin → Scheduling** — which is also the screen that demonstrates the 40-hour rule in step 6.

Accepting opens the **clinical workspace**: the patient's details, any vitals the pharmacy recorded, and space for notes, diagnosis and treatment.

**A doctor never sees a rating or a quality score, here or anywhere.** The routes behind this screen do not return them to a doctor (spec §24, §52).

---

## 4. The prescription

In the workspace, write a prescription and issue it.

1. It is **signed** with the doctor's stored signature — a prescription cannot be issued unsigned.
2. Choose an outcome and **complete the consultation**.

Now switch to the pharmacy window: **Prescriptions**. It is there, immediately.

- **Open the PDF.** It carries the patient by value, not by reference, so it survives the sealing of the clinical record.
- **The verification code is on the PDF and nowhere else** — a QR top-right, and a printed `Verify at http://localhost:8080/verify/rx/<code>` along the footer. That is deliberate: the code belongs to whoever is holding the paper, not to anyone with a login. Read it off the document, exactly as a pharmacist in another town would.
- **Open that URL in a private window.** No sign-in. It confirms the prescription is genuine, who issued it and when, and **does not say what it is for**. A verification page that disclosed the medication would be a medical record with no access control.

Then **propose a substitution** as the pharmacy. It goes to the doctor for a decision and **blocks dispensing until answered**. A pharmacy cannot alter a doctor's prescription; it can only ask.

---

## 5. What happens to the record

The moment the doctor completed, the clinical record was **sealed**.

- The doctor cannot reopen it. Try: the workspace refuses.
- The pharmacy never could.
- An administrator cannot browse to it — there is no consultation list in the admin console, deliberately (D24).

**The patient's copy of the truth is the consultation reference** on their completion screen, in the format `NEEM-XXXX-XXXX-XXXX`. It is the only route back to their own record, because Neem keeps no patient profile: nothing can be found by name or phone number.

Then have the patient tap **Finish and clear this phone**. It asks about the reference first, because that is what they lose. Afterwards the session is dead on the server, not merely cleared from the browser — a handset going back over a counter should not carry a live session (D34).

> **This is the part that changed most during the build.** The original design deleted the clinical record at completion. Counsel established that was not lawful, so D23 replaced deletion with sealing and a retention period. The retention job that will destroy this record already exists — it was created at the moment of completion.

---

## 6. Administration

Sign in as **`admin@neem.demo`**. It will require **TOTP enrolment on first sign-in**, and this cannot be skipped: an administrator without a second factor cannot get a usable session. Scan the QR with any authenticator, save the recovery codes.

Worth showing, in this order:

| Screen | What it demonstrates |
| --- | --- |
| **Overview** | Real figures over 30 days, and a demo-mode banner naming which providers are mocked |
| **Live queue** | Waiting consultations and manual reallocation |
| **Scheduling** | **Turn on** the Night shift — it ships off, because 24-hour operation is a business decision rather than a default. Then assign the same doctor **four night shifts in one week**: the fourth is refused, because 40 hours is a fatigue rule the API enforces whatever this screen shows. Search by name or MDC number; the directory is paged |
| **Refunds** | A request from the seed, awaiting a decision. Money is reversed, never deleted |
| **Quality** | Doctor scores with the breakdown behind each — admin-only, never shown to a doctor |
| **Notifications** | Reword any message. **Try typing a dose or a diagnosis into one** — it is refused when you save it, not when it is sent (spec §60) |
| **Settings** | Change the consultation price. A sensitive setting requires a written reason, and the previous value is kept |
| **Audit** | Everything above, appended. Read-only: there is no edit and no delete route behind this screen |
| **Archive** | Retrieval of a sealed consultation — needs the reference, a stated purpose, and **a second administrator**. Self-authorisation is refused |

> **The archive is the one to linger on.** It is the narrow door counsel required: no search, no patient lookup, no list. Retrieval takes exactly one known reference and is itself logged as a disclosure.

---

## If you have five minutes, not fifteen

1. Pharmacy: new consultation → pay → QR.
2. Phone: details, language, video → waiting room.
3. Doctor: accept → prescribe → complete.
4. Pharmacy: the prescription is already there; open the public verification page.
5. Admin → Audit: every step you just took, in order.

---

## Things that will look like bugs and are not

| What you see | Why |
| --- | --- |
| "No money has moved" on the payment screen | Mock provider. The product refuses to imply a payment it cannot verify |
| The video pane says media is simulated | The Twilio adapter is not implemented; selecting it throws at boot rather than silently mocking |
| The doctor's queue is empty | They have no confirmed shift today. Admin → Scheduling |
| A completed consultation shows no clinical notes | Correct. It is sealed — that is the whole design (D23) |
| The admin cannot retrieve an archived record alone | Correct. It needs a second administrator (D27) |
| Analytics shows no diagnosis or medication data | There is deliberately no such route, in aggregate or otherwise (spec §13) |

---

## Resetting between demonstrations

```bash
npm run db:reset          # drop, migrate, re-seed
npm run db:reset-2fa      # clear the demo admin's TOTP so enrolment can be shown again
```

`db:reset` destroys the local database. It refuses to run against production, and the seed refuses independently.
