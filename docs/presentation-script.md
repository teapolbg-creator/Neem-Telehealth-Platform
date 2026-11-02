# Presenting Neem V2

A walkthrough of the CHPS model on a local build, about 20 minutes. Use **V1** to show
a real video call, because this build's calls are simulated.

## What is true, and what to say

Keep to this. It is what the build can back up.

| You can say                                                      | Do not say                                        |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| "This is a working build running on this laptop."                | "This is live" or "this is in use at a compound"  |
| "The compounds, patients and figures here are made up."          | Anything implying these are real results          |
| "Video runs on a service we connect at deployment. V1 shows it." | "This call is connected"                          |
| "Reports are designed so DHIMS2 can be added once approved."     | "It integrates with DHIMS2"                       |
| "Flags come only from a protocol you approve, and none are in."  | "It triages patients" or "it detects emergencies" |
| "We would need to complete data protection review."              | "It is approved by GHS, the MDC or the DPC"       |

The CHO always decides the triage category. Neem never diagnoses, and it does not
replace anyone's clinical responsibility.

## Before you go

**The day before, on the presentation laptop:**

```bash
npm run db:reset
```

This **wipes the local database** and rebuilds it with clean demo data. Do it once, so
no test facilities appear on screen. It refuses to run against production. Then:

```bash
npm run demo
```

Wait for the box with the two addresses. **This works with no internet once it has run
once**, so run it before you travel, then try it with Wi-Fi off.

**Open these, each in its own browser profile or a private window**, because each
signed-in role needs its own session:

| Window        | Address                            | Sign in as                |
| ------------- | ---------------------------------- | ------------------------- |
| 1. CHO        | <http://localhost:8080/auth/login> | `cho@chps.demo`           |
| 2. Doctor     | <http://localhost:8080/auth/login> | `ama@doctor.demo`         |
| 3. Station    | <http://localhost:8080/station>    | Nothing, see step 3 below |
| 4. District   | <http://localhost:8080/auth/login> | `district@officer.demo`   |
| 5. Operations | <http://localhost:8080/auth/login> | `operations@neem.demo`    |

The password is `NeemDemo!2026`. **Operations needs an authenticator app** the first
time, so enrol it the day before and stay signed in.

**Start `npm run demo` again on the day.** Each run puts the demo doctors on duty for that day, at any hour, without changing the data.

## The story

"A woman walks into a CHPS compound. She has no smartphone and no appointment."

### 1. Registering her (CHO window)

Show **Today**: the board, the counts, and the bell. Then **Register walk-in**.

- Point out how little is required: no phone or ID, and an estimated age is fine.
- Read out the consent: it is recorded with who gave it.
- Register her. She now has a card number, and her record has begun.

### 2. Vital signs and triage

Enter a few readings and choose **Yellow**.

- "The category is the CHO's judgement. Neem does not calculate it."
- If asked about automatic emergency flags: they come only from an approved protocol,
  and the table is empty until you approve one. Show **Triage protocol** as the super
  administrator only if it comes up.

### 3. Pairing the station

On the Today page, **Add station**, name it, and type the code into the station window.
It shows the welcome screen.

"A tablet at the compound. No app, no account, and it can show nothing but this."

### 4. Asking for a doctor

On her record: language **English**, priority, **Request a doctor**, then **Send to
station**.

- The station greets her by first name, and no further.
- The CHO's screen says "Waiting for a doctor", and it means it.

### 5. The doctor (Doctor window)

Open **Queue** and click **I'm available**. The offer appears with her age, complaint,
readings and priority, and a 90-second clock.

- A doctor can accept or decline. A decline goes straight to another doctor.
- **Accept.** The doctor now sees the CHO's assessment and earlier visits.

The station joins by itself. **It shows "Simulated connection"**, and this is the moment
to say so: "Video is connected at deployment. V1 shows a real call."

### 6. The record and the referral

Write an assessment and a plan, tick an outcome, and **Complete consultation**.

- The CHO's bell rings and leads to her record, with the doctor's advice on it.
- The station thanks her, then clears itself. **Show this**: nothing of her is left for
  the next person.
- On her record, **Refer the patient** to the demo hospital. The status says "Sent, not yet confirmed"
  until someone records otherwise: Neem never assumes a patient arrived.

### 7. An emergency (brief)

Register someone, and choose **Red**. The screen says to follow the emergency protocol
and offers no doctor request. "An emergency never waits in a queue."

### 8. When the connection drops (brief)

If you can, turn off Wi-Fi with the CHO's window open at the registration form. A bar
says there is no connection, and the form saves to the device, encrypted. Turn Wi-Fi
back on and it sends itself.

This needs the app on another device to be convincing, and is safe to skip: on one
laptop the server is local, so turning off Wi-Fi does not actually cut the connection.
Stop here and describe it if so.

### 9. Oversight (District and Operations windows)

- **District:** choose **Last month**, because the current month may be nearly empty. The
  officer sees counts by compound, and compares them. Names appear nowhere, and nothing
  can be changed. Show **Download CSV**.
- **Operations:** **CHPS** shows every compound live, and **Monitoring** shows stations,
  devices and security events.

## If something goes wrong

| What you see                       | What to do                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| "No Neem doctor is on duty"        | The date has changed since it started: stop it, and run `npm run demo` again |
| No offer reaches the doctor        | Click **I'm available** in the Doctor window, and keep it open               |
| The station does not join          | Check it was sent to the station, and give it a few seconds                  |
| A window is signed out             | Sign in again. Sessions expire when left idle                                |
| "Failed to fetch" or nothing loads | Check `npm run demo` is still running                                        |
| Docker error on starting           | Start Docker Desktop, wait for it, and run it again                          |
