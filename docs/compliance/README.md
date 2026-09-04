# Compliance Research — Scope and Limits

## What this folder is

Engineering research to identify which Ghanaian legal and regulatory instruments plausibly apply to Neem, so that the questions reach a qualified lawyer or regulatory consultant in a usable form.

## What this folder is not

**This is not legal advice.** Nothing here has been verified against an official source. Every entry in the register is marked `UNVERIFIED` and must be confirmed before anyone relies on it.

## Rules this folder follows (spec §78)

1. **No regulation is assumed true.** Each candidate instrument is listed with the level of confidence in its existence and title, and with an explicit note that its content, current version, and applicability are unconfirmed.
2. **Law, regulation, guidance, and engineering assumption are labelled separately.** They are not blended into a single "requirement".
3. **No application behaviour depends on an unverified regulatory assumption.** Where a design choice was influenced by a likely requirement, the choice is justified on independent engineering grounds — good data minimisation, honest deletion, auditability — so that a change in the regulatory picture adjusts configuration, not architecture.
4. **Anything needing professional confirmation is flagged as such**, with a specific question rather than a general "check this".

## How to use it

`ghana-regulatory-register.md` holds one row per candidate instrument, plus the open questions and the engineering implications of each. Take the open questions to counsel. As answers come back, replace `UNVERIFIED` with the source, the date checked, and who confirmed it.

`counsel-brief-g7.md` is the first of those instructions, drafted and ready to send: the five retention and patient-data questions still open, each with the decision it drives, what the product does today in the absence of an answer, and what changes once there is one. Two of the five block launch. It is confined to retention and patient data on purpose — the wider register is a separate, larger instruction.

## Verification status

**Nothing in this folder has been verified.** No official source has been consulted, and no live research was performed during Phase 0. Verification is a named task and has not yet been done.
