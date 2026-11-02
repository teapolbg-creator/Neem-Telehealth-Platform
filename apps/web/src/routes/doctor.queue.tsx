import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  AlertCircle,
  Hourglass,
  Loader2,
  Phone,
  PhoneOutgoing,
  Video,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useProfessionalRole } from "@/features/auth/use-role";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { TriageBadge } from "@/features/facility/TriageBadge";
import { formatVitals } from "@/features/facility/triage";
import { ApiError } from "@/lib/api-client";
import {
  channelLabel,
  consultationOrigin,
  useAcceptOffer,
  useCountdown,
  useDeclineOffer,
  useGoBusy,
  useGoOffline,
  useGoOnline,
  usePresence,
  useQueue,
  type QueueOffer,
} from "@/features/queue/api";
import { useRealtimeInvalidation } from "@/features/realtime/socket";
import {
  dismissNotificationPrompt,
  useNotificationPermission,
  useShouldPromptForNotifications,
} from "@/features/realtime/use-offer-alert";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/doctor/queue")({
  component: DoctorQueue,
});

/**
 * The doctor's queue (spec §24, §30).
 *
 * Two things this screen deliberately does not have:
 *
 *  - **A decline button, except for a CHPS request.** A patient at a pharmacy
 *    or online has paid, and a doctor cannot reject that consultation (spec
 *    §30): the only actions are to accept or to let the window lapse, which
 *    records a missed response and reassigns. A CHPS request can be declined
 *    (brief §B2, D91).
 *  - **Any score or rating.** The routing score and patient ratings are
 *    admin-facing; a doctor never sees either (spec §24, §52), and the API
 *    does not return them to a doctor principal.
 */
function DoctorQueue() {
  const role = useProfessionalRole();
  const { data: presence, isLoading } = usePresence();
  const goOnline = useGoOnline();
  const goOffline = useGoOffline();
  const goBusy = useGoBusy();

  const online = presence?.online ?? false;
  const busy = presence?.busy ?? false;
  const changing = goOnline.isPending || goOffline.isPending || goBusy.isPending;

  const { data: queue } = useQueue(online);
  const shouldPrompt = useShouldPromptForNotifications();

  /**
   * The offer, pushed rather than polled (spec §58).
   *
   * The queue query still polls as a fallback, because a socket that has
   * silently dropped must not cost a doctor an offer. But the socket is what
   * arrives in the first second, and the 90-second window is short enough for
   * that to decide whether the patient is seen.
   */
  useRealtimeInvalidation("queue.offer", ["doctor", "queue"], online);

  if (isLoading) {
    return (
      <AppShell active="doctor">
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell active="doctor">
      {shouldPrompt && <NotificationPrompt />}

      {/*
        A professional is available for as long as their browser is open on
        Neem — the heartbeat runs in the shell, not on this page (D72).
      */}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-sm font-semibold text-brand">Consultation queue</p>
          <h1 className="text-3xl font-bold tracking-tight">
            {busy ? "You are busy" : online ? "You are available" : "You are on a break"}
          </h1>
        </div>

        <div className="flex flex-wrap gap-2">
          {online && !busy ? (
            <button
              type="button"
              disabled={changing}
              onClick={() => goBusy.mutate()}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-white px-5 py-3 text-sm font-semibold transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <Hourglass className="size-4" /> I'm busy
            </button>
          ) : (
            <button
              type="button"
              disabled={changing}
              onClick={() => goOnline.mutate()}
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-semibold text-white transition-colors hover:brightness-110 disabled:opacity-50"
            >
              <Wifi className="size-4" /> I'm available
            </button>
          )}
          {online ? (
            <button
              type="button"
              disabled={changing}
              onClick={() => goOffline.mutate()}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-white px-5 py-3 text-sm font-semibold transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <WifiOff className="size-4" /> Take a break
            </button>
          ) : null}
        </div>
      </header>

      {goOnline.error && (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-4">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {goOnline.error instanceof ApiError ? goOnline.error.message : "Could not go online."}
          </p>
        </div>
      )}

      {/*
        Says plainly why no consultations are arriving. Silence would leave a
        doctor guessing whether the system is broken or they are simply not
        eligible right now.
      */}
      {presence?.blockedBy && (
        <div className="card-soft flex items-start gap-3 border-warning/30 bg-warning-soft p-4">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 text-sm text-slate-700">
            <p className="font-bold text-warning">Not receiving consultations</p>
            <p className="mt-1">{presence.blockedBy}</p>

            {/*
              Which consultation, and a way into it (D66).

              "You are already with 1 of 1 patients" was true and completely
              unactionable: no screen anywhere listed a doctor's occupying
              consultations, so one told they were busy could not find the
              patient they were supposedly with, let alone finish or release
              it. The only route out ran through somebody with database access,
              which is not a route a doctor has.
            */}
            {(presence.occupying ?? []).length > 0 && (
              <ul className="mt-3 space-y-2">
                {presence.occupying.map((consultation) => (
                  <li
                    key={consultation.consultationPublicId}
                    className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-white px-3 py-2"
                  >
                    <span className="font-mono text-xs">{consultation.consultationPublicId}</span>
                    <span className="text-xs text-slate-500">
                      {consultation.state.replace(/_/g, " ").toLowerCase()}
                      {consultation.since
                        ? ` · since ${new Date(consultation.since).toLocaleString("en-GH", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}`
                        : ""}
                    </span>
                    <Link
                      to="/doctor/consultations/$publicId"
                      params={{ publicId: consultation.consultationPublicId }}
                      className="ml-auto rounded-lg bg-warning px-3 py-1.5 text-xs font-bold text-white hover:brightness-110"
                    >
                      Open
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {queue?.offer ? (
        <OfferCard offer={queue.offer} windowSeconds={queue.windowSeconds} />
      ) : (
        <IdleCard online={online} busy={busy} currentLoad={presence?.currentLoad ?? 0} />
      )}

      <section className="card-soft p-6">
        <h2 className="mb-3 font-bold">How consultations reach you</h2>
        <ul className="space-y-2 text-sm leading-relaxed text-slate-600">
          <li>
            Neem matches each patient to a {role.noun} who speaks their language, balancing workload
            across everyone on shift.
          </li>
          <li>
            You have {queue?.windowSeconds ?? 90} seconds to accept. If you do not respond, the
            consultation goes to another {role.noun} and the missed response is recorded.
          </li>
          <li>
            A consultation from a pharmacy or an online patient cannot be declined. A request from a
            CHPS compound can, and goes to another {role.noun}.
          </li>
        </ul>
      </section>
    </AppShell>
  );
}

function OfferCard({ offer, windowSeconds }: { offer: QueueOffer; windowSeconds: number }) {
  const remaining = useCountdown(offer.respondByAt);
  const accept = useAcceptOffer();
  const decline = useDeclineOffer();
  const role = useProfessionalRole();
  const navigate = useNavigate();

  const fraction = Math.max(0, Math.min(1, remaining / windowSeconds));
  const urgent = remaining <= 20;
  const lapsed = remaining <= 0;

  const ModeIcon =
    offer.type === "VIDEO" ? Video : offer.type === "CALL_ME" ? PhoneOutgoing : Phone;

  return (
    <section
      className={cn(
        "card-soft border-2 p-8",
        lapsed ? "border-slate-200" : urgent ? "border-red-300" : "border-brand",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={lapsed ? "muted" : "brand"} pulse={!lapsed}>
              {lapsed ? "Offer expired" : "New consultation"}
            </Chip>
            {/* Which kind it is, before accepting: it decides what happens to
                anything issued, and whether a pharmacy can propose a swap. */}
            <Chip tone={offer.pharmacy || offer.chps ? "medical" : "muted"}>
              {channelLabel(offer.pharmacy, offer.chps ? { name: offer.chps.facilityName } : null)}
            </Chip>
            {offer.chps ? <TriageBadge category={offer.chps.triageCategory} /> : null}
            {offer.chps?.priority === "URGENT" ? <Chip tone="warning">Urgent</Chip> : null}
          </div>
          <h2 className="mt-3 text-2xl font-bold">
            {offer.language?.label ?? "Consultation"} ·{" "}
            <span className="capitalize">{offer.type?.replace("_", " ").toLowerCase()}</span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {consultationOrigin(
              offer.pharmacy,
              offer.chps ? { name: offer.chps.facilityName, district: offer.chps.district } : null,
            )}
          </p>
          {offer.chps ? (
            // What a doctor needs to decide on a CHPS request (brief §B2, D78).
            <p className="mt-2 text-sm">
              {[
                offer.chps.sex ? offer.chps.sex.toLowerCase() : null,
                offer.chps.ageYears !== null ? `${offer.chps.ageYears} years` : null,
              ]
                .filter(Boolean)
                .join(", ")}
              {offer.chps.presentingComplaint ? ` — ${offer.chps.presentingComplaint}` : ""}
            </p>
          ) : null}
          {offer.chps?.vitals && formatVitals(offer.chps.vitals).length > 0 ? (
            <p className="mt-1 text-sm text-slate-600">
              {formatVitals(offer.chps.vitals).join(" · ")}
            </p>
          ) : null}
        </div>

        <div className="text-right">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Time to respond
          </p>
          <p
            className={cn(
              "font-mono text-4xl font-bold tabular-nums",
              lapsed ? "text-slate-400" : urgent ? "text-red-600" : "text-brand",
            )}
          >
            {remaining}s
          </p>
        </div>
      </div>

      <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-300",
            urgent ? "bg-red-500" : "bg-brand",
          )}
          style={{ width: `${fraction * 100}%` }}
        />
      </div>

      <div className="mt-5 flex items-center gap-3 rounded-2xl bg-slate-50 p-4">
        <ModeIcon className="size-5 shrink-0 text-slate-500" />
        <p className="text-xs leading-relaxed text-slate-600">
          The patient is waiting. Accepting opens their details, the vitals{" "}
          {offer.chps ? "the CHO recorded" : "the pharmacy recorded"}, and your clinical workspace.
        </p>
      </div>

      {/*
        One action for a patient who has paid: spec §30 is explicit that doctors
        cannot reject that consultation. A CHPS request can also be declined,
        below (brief §B2, D91).
      */}
      <button
        type="button"
        disabled={accept.isPending || lapsed}
        onClick={() =>
          accept.mutate(offer.consultationPublicId, {
            onSuccess: () =>
              void navigate({
                to: "/doctor/consultations/$publicId",
                params: { publicId: offer.consultationPublicId },
              }),
          })
        }
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-brand py-4 text-lg font-bold text-white shadow-lg shadow-brand/20 hover:brightness-110 disabled:opacity-40"
      >
        {accept.isPending && <Loader2 className="size-5 animate-spin" />}
        {lapsed ? "This offer has expired" : "Accept consultation"}
      </button>

      {offer.chps && !lapsed ? (
        <button
          type="button"
          disabled={decline.isPending || accept.isPending}
          onClick={() => decline.mutate(offer.consultationPublicId)}
          className="mt-3 w-full rounded-2xl border border-border py-3 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
        >
          Decline, offer it to another {role.noun}
        </button>
      ) : null}
      {decline.error ? (
        <p className="mt-3 text-center text-sm text-red-600">
          {decline.error instanceof ApiError ? decline.error.message : "Could not decline."}
        </p>
      ) : null}

      {accept.error && (
        <p className="mt-3 text-center text-sm text-red-600">
          {accept.error instanceof ApiError ? accept.error.message : "Could not accept."}
        </p>
      )}

      {lapsed && (
        <p className="mt-3 text-center text-xs text-slate-500">
          It is being offered to another {role.noun}. This was recorded as a missed response.
        </p>
      )}
    </section>
  );
}

function IdleCard({
  online,
  busy,
  currentLoad,
}: {
  online: boolean;
  busy: boolean;
  currentLoad: number;
}) {
  return (
    <section className="card-soft grid place-items-center p-16 text-center">
      {busy ? (
        <>
          <Hourglass className="size-10 text-slate-300" />
          <h2 className="mt-4 text-xl font-bold">You are busy</h2>
          <p className="mt-2 max-w-sm text-sm text-slate-500">
            No new consultations will be offered to you until you say you are available.
          </p>
        </>
      ) : online ? (
        <>
          <div className="grid size-16 place-items-center rounded-full bg-brand/10">
            <Loader2 className="size-7 animate-spin text-brand" />
          </div>
          <h2 className="mt-5 text-xl font-bold">Waiting for a consultation</h2>
          <p className="mt-2 max-w-sm text-sm text-slate-500">
            {currentLoad > 0
              ? "You are currently with a patient. The next consultation will arrive when you are free."
              : "You will be notified the moment a patient is matched with you."}
          </p>
        </>
      ) : (
        <>
          <WifiOff className="size-10 text-slate-300" />
          <h2 className="mt-4 text-xl font-bold">You are on a break</h2>
          {/*
            Said as a break rather than as a state the system put them in
            (D72). Nothing takes a professional offline but their own choice
            and a browser that has genuinely stopped answering — walking into a
            consultation used to do it, which is why this screen kept appearing
            uninvited.
          */}
          <p className="mt-2 max-w-sm text-sm text-slate-500">
            No consultations will be offered to you until you say you are available again. You stay
            available while you are seeing a patient, and across every page of Neem.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * Asks for notification permission, once, where it makes sense.
 *
 * Not on mount: browsers require a user gesture, and an unprompted request is
 * denied by habit — a denial that then sticks. Shown here because this is the
 * screen where the permission is worth having.
 */
function NotificationPrompt() {
  const { request } = useNotificationPermission();
  const [hidden, setHidden] = useState(false);

  if (hidden) return null;

  return (
    <div className="card-soft flex flex-wrap items-center justify-between gap-4 border-brand/30 bg-brand/[0.03] p-5">
      <div>
        <p className="font-bold">Get told when a consultation arrives</p>
        <p className="mt-0.5 text-sm text-slate-600">
          Neem can sound an alert and show a notification when you are offered a consultation. You
          have 90 seconds to accept one.
        </p>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() =>
            void request().then((answer) => {
              // Answered either way: allowed, there is nothing left to ask;
              // blocked, the browser will not ask again. Only a prompt the
              // doctor closed without answering leaves the banner up.
              if (answer !== "default") setHidden(true);
            })
          }
          className="rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110"
        >
          Turn on alerts
        </button>
        <button
          type="button"
          onClick={() => {
            dismissNotificationPrompt();
            setHidden(true);
          }}
          className="rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-slate-50"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
