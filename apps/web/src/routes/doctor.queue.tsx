import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Loader2, Phone, PhoneOutgoing, Video, Wifi, WifiOff } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  useAcceptOffer,
  useCountdown,
  useGoOffline,
  useGoOnline,
  useHeartbeat,
  usePresence,
  useQueue,
  type QueueOffer,
} from "@/features/queue/api";
import { useRealtimeEvent, useRealtimeInvalidation } from "@/features/realtime/socket";
import {
  dismissNotificationPrompt,
  useNotificationPermission,
  useOfferAlert,
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
 *  - **A decline button.** Doctors cannot reject an assigned consultation
 *    (spec §30). The only actions are to accept or to let the window lapse,
 *    which records a missed response and reassigns.
 *  - **Any score or rating.** The routing score and patient ratings are
 *    admin-facing; a doctor never sees either (spec §24, §52), and the API
 *    does not return them to a doctor principal.
 */
function DoctorQueue() {
  const { data: presence, isLoading } = usePresence();
  const goOnline = useGoOnline();
  const goOffline = useGoOffline();

  const online = presence?.online ?? false;
  useHeartbeat(online);

  const { data: queue } = useQueue(online);
  const alert = useOfferAlert();
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

  useRealtimeEvent<{ consultationPublicId: string }>(
    "queue.offer",
    () => {
      // A sound and a browser notification, for the doctor who is not looking
      // at this tab. Nothing clinical in either — a browser notification is
      // rendered by the operating system and visible to anyone nearby.
      alert({
        title: "A consultation is waiting",
        body: "Open Neem to accept it before the window closes.",
      });
    },
    online,
  );

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

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-sm font-semibold text-brand">Consultation queue</p>
          <h1 className="text-3xl font-bold tracking-tight">
            {online ? "You are available" : "You are offline"}
          </h1>
        </div>

        <button
          type="button"
          disabled={goOnline.isPending || goOffline.isPending}
          onClick={() => (online ? goOffline.mutate() : goOnline.mutate())}
          className={cn(
            "inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-colors disabled:opacity-50",
            online
              ? "border border-border bg-white hover:bg-slate-50"
              : "bg-brand text-white hover:brightness-110",
          )}
        >
          {online ? <WifiOff className="size-4" /> : <Wifi className="size-4" />}
          {online ? "Go offline" : "Go online"}
        </button>
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
          <div className="text-sm text-slate-700">
            <p className="font-bold text-warning">Not receiving consultations</p>
            <p className="mt-1">{presence.blockedBy}</p>
          </div>
        </div>
      )}

      {queue?.offer ? (
        <OfferCard offer={queue.offer} windowSeconds={queue.windowSeconds} />
      ) : (
        <IdleCard online={online} currentLoad={presence?.currentLoad ?? 0} />
      )}

      <section className="card-soft p-6">
        <h2 className="mb-3 font-bold">How consultations reach you</h2>
        <ul className="space-y-2 text-sm leading-relaxed text-slate-600">
          <li>
            Neem matches each patient to a doctor who speaks their language, balancing workload
            across everyone on shift.
          </li>
          <li>
            You have {queue?.windowSeconds ?? 90} seconds to accept. If you do not respond, the
            consultation goes to another doctor and the missed response is recorded.
          </li>
          <li>Assigned consultations cannot be declined.</li>
        </ul>
      </section>
    </AppShell>
  );
}

function OfferCard({ offer, windowSeconds }: { offer: QueueOffer; windowSeconds: number }) {
  const remaining = useCountdown(offer.respondByAt);
  const accept = useAcceptOffer();
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
          <Chip tone={lapsed ? "muted" : "brand"} pulse={!lapsed}>
            {lapsed ? "Offer expired" : "New consultation"}
          </Chip>
          <h2 className="mt-3 text-2xl font-bold">
            {offer.language?.label ?? "Consultation"} ·{" "}
            <span className="capitalize">{offer.type?.replace("_", " ").toLowerCase()}</span>
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {offer.pharmacy.name}, {offer.pharmacy.city}
          </p>
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
          The patient is waiting. Accepting opens their details, the vitals the pharmacy recorded,
          and your clinical workspace.
        </p>
      </div>

      {/*
        One action. There is no decline — spec §30 is explicit that doctors
        cannot reject an assigned consultation.
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

      {accept.error && (
        <p className="mt-3 text-center text-sm text-red-600">
          {accept.error instanceof ApiError ? accept.error.message : "Could not accept."}
        </p>
      )}

      {lapsed && (
        <p className="mt-3 text-center text-xs text-slate-500">
          It is being offered to another doctor. This was recorded as a missed response.
        </p>
      )}
    </section>
  );
}

function IdleCard({ online, currentLoad }: { online: boolean; currentLoad: number }) {
  return (
    <section className="card-soft grid place-items-center p-16 text-center">
      {online ? (
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
          <h2 className="mt-4 text-xl font-bold">You are offline</h2>
          <p className="mt-2 max-w-sm text-sm text-slate-500">
            Go online to start receiving consultations during your shift.
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
          onClick={() => void request()}
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
