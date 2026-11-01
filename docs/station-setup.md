# Setting up a consultation station

A consultation station is the tablet, touchscreen or screen at a CHPS compound
that patients speak to the doctor on (slice 1d, D77). It is an ordinary web
browser showing one page, `/station`, locked so a patient cannot leave it.

## What it needs

- A device with a front camera, a microphone and speakers loud enough for an
  older patient, and a recent Chrome or Edge.
- Mains power or a charger left connected. The page keeps the screen awake
  where the browser allows it.
- An internet connection. Video needs a steady connection; when it cannot
  hold one, the CHO can request an audio-only consultation instead.

## Pairing

1. On the CHO's own device, open Neem, go to **Today**, and under
   **Consultation stations** choose **Add station**. Give it a name staff will
   recognise, such as "Consulting room tablet". A pairing code appears.
2. On the station, open `https://app.neemtelehealth.com/station` and type the
   code. It works once and lasts 15 minutes.
3. Allow the camera and microphone when the browser asks. If the prompt was
   dismissed, allow them in the browser's site settings.

The station stays paired for 180 days, or until its browser data is cleared.
To pair it again, choose **Pair again** beside it; the old pairing stops at
once. A lost or stolen device is stopped with **Revoke**.

## Locking the screen

Lock the device to the browser so a patient cannot open anything else. Use
whichever the device offers:

- **Android:** turn on _App pinning_ (Settings › Security), open Chrome on the
  station page, and pin it. Unpinning needs the device PIN.
- **ChromeOS:** a managed device can run the page as a single-app kiosk.
- **Windows:** _Assigned access_ runs Edge in kiosk mode on one address.
- **iPad:** _Guided Access_ (Settings › Accessibility) locks Safari to the page.

Whatever is used, the unlocking PIN stays with facility staff.

## Using it

The CHO does everything from their own device:

1. Register and triage the patient, then **Request a doctor**.
2. Choose **Send to station**. The station greets the patient by first name
   and asks them to wait.
3. When a doctor accepts, the station joins the call by itself. The patient
   only needs the on-screen microphone and camera buttons, if that.
4. When the doctor ends the consultation, or the request is withdrawn, the
   station thanks the patient and returns to the welcome screen. It reloads
   itself, so nothing about that patient stays on it.

A station shows one patient at a time. To move a patient off it before their
consultation ends, use **Take off station** or **Clear screen**.

## Privacy

The station never receives a patient record: only a first name to greet
them, and the doctor's name once they have accepted. Consultations are never
recorded. Position the screen so other people waiting cannot see or hear the
call.
