import { useEffect, useRef } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { AlertCircle, CalendarCheck, Loader2, PhoneIncoming } from "lucide-react";
import { ApiError } from "@/lib/api-client";
import { useConfirmShift, useDoctorShifts, type DoctorShift } from "@/features/onboarding/api";
import { usePresence, useQueue, useCountdown } from "@/features/queue/api";
import { useRealtimeEvent, useRealtimeInvalidation } from "@/features/realtime/socket";
import { useOfferAlert } from "@/features/realtime/use-offer-alert";
import { useProfessionalRole } from "@/features/auth/use-role";

/**
 * The two things a professional must not miss, on whichever screen they are on.
 *
 * Both used to live on the queue page alone. A shift assignment was a line on
 * the dashboard and a patient waiting was a card on the queue, so a doctor
 * reading their earnings heard nothing and saw nothing — and an unconfirmed
 * shift means the queue never reaches them at all.
 *
 * Rendered by the shell, above the page, so it survives moving between tabs:
 * the subscription and the poll are mounted once for the whole session rather
 * than once per screen.
 */
export function DoctorAlerts() {
  return (
    <div className="mx-auto w-full max-w-7xl space-y-3 px-4 pt-4 sm:px-6 empty:hidden">
      <ShiftAlert />
      <PatientRequestAlert />
    </div>
  );
}

/**
 * An assigned shift the professional has not accepted yet.
 *
 * Kept up until it is accepted, because until then the queue treats them as
 * unavailable: presence counts confirmed shifts only. Accepting invalidates
 * the shifts query, so every tab showing this banner drops it at once.
 */
function ShiftAlert() {
  const { data, refetch } = useDoctorShifts();
  const confirm = useConfirmShift();

  // The assignment arrives as a notification; this is what makes the banner
  // appear without a reload.
  useRealtimeEvent<{ templateCode?: string }>(
    "notification",
    (payload) => {
      if (payload?.templateCode?.startsWith("doctor.shift")) void refetch();
    },
    true,
  );

  const waiting = (data?.shifts ?? [])
    .filter((shift) => shift.status === "ASSIGNED")
    .sort((a, b) => a.serviceDate.localeCompare(b.serviceDate));

  const shift = waiting[0];
  if (!shift) return null;

  return (
    <div className="card-soft border-2 border-warning bg-warning-soft p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-warning text-white">
            <CalendarCheck className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="font-bold text-warning">
              {waiting.length > 1
                ? `${waiting.length} shifts need your acceptance`
                : "A shift is waiting for you to accept it"}
            </p>
            <p className="mt-0.5 text-sm text-slate-700">
              {shift.shift.label} on {whenIs(shift.serviceDate)}. Neem cannot send you patients
              until you accept it.
            </p>
            {confirm.error ? (
              <p className="mt-2 flex items-center gap-1.5 text-sm text-red-700" role="alert">
                <AlertCircle className="size-4 shrink-0" />
                {confirm.error instanceof ApiError
                  ? confirm.error.message
                  : "That shift could not be accepted."}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <Link to="/doctor" className="text-sm font-semibold text-slate-600 hover:text-slate-900">
            See my shifts
          </Link>
          <button
            type="button"
            disabled={confirm.isPending}
            onClick={() => confirm.mutate(shift.id)}
            className="inline-flex items-center gap-2 rounded-xl bg-warning px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-60"
          >
            {confirm.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Accept shift
          </button>
        </div>
      </div>
    </div>
  );
}

/** Today, tomorrow, or the date, which is what a person would say. */
function whenIs(serviceDate: string): string {
  const day = serviceDate.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  if (day === today) return "today";
  if (day === tomorrow) return "tomorrow";
  return new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-GH", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/**
 * A patient waiting for an answer, wherever the professional is.
 *
 * The queue page shows the offer in full, with the countdown ring and the
 * accept button, so this steps aside there rather than saying the same thing
 * twice. Everywhere else it is the only thing that will reach them.
 *
 * The sound and the browser notification are raised here and nowhere else:
 * two subscriptions would mean two chimes for one patient.
 */
function PatientRequestAlert() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const role = useProfessionalRole();

  const { data: presence } = usePresence();
  const online = presence?.online ?? false;
  const { data: queue } = useQueue(online);
  const alert = useOfferAlert();

  useRealtimeInvalidation("queue.offer", ["doctor", "queue"], online);
  // An offer that lapsed is not an offer. Without this the banner waits for
  // the next three-second poll to notice.
  useRealtimeInvalidation("queue.offer_expired", ["doctor", "queue"], online);

  /*
   * One alert per patient.
   *
   * The socket event and the poll can both surface the same offer, and a
   * reconnect re-delivers it, so the consultation decides whether this is news
   * rather than the arrival of a message.
   */
  const alerted = useRef<string | null>(null);
  const offer = queue?.offer ?? null;

  useEffect(() => {
    if (!offer) {
      alerted.current = null;
      return;
    }
    if (alerted.current === offer.consultationPublicId) return;
    alerted.current = offer.consultationPublicId;

    alert({
      title: "A patient is waiting",
      body: "Open Neem to accept the consultation before the window closes.",
      onClick: () => void navigate({ to: "/doctor/queue" }),
    });
  }, [offer, alert, navigate]);

  if (!offer || pathname.startsWith("/doctor/queue")) return null;

  return <OfferBanner respondByAt={offer.respondByAt} noun={role.noun} />;
}

function OfferBanner({ respondByAt, noun }: { respondByAt: string; noun: string }) {
  const remaining = useCountdown(respondByAt);
  if (remaining <= 0) return null;

  const urgent = remaining <= 20;

  return (
    <div
      role="alert"
      className={`card-soft border-2 p-4 sm:p-5 ${urgent ? "border-red-400 bg-red-50" : "border-brand bg-brand-soft"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={`grid size-10 shrink-0 place-items-center rounded-xl text-white ${urgent ? "bg-red-500" : "animate-pulse bg-brand"}`}
          >
            <PhoneIncoming className="size-5" />
          </span>
          <div className="min-w-0">
            <p className={`font-bold ${urgent ? "text-red-700" : "text-brand"}`}>
              A patient is waiting for a {noun}
            </p>
            <p className="mt-0.5 text-sm text-slate-700">
              {remaining} second{remaining === 1 ? "" : "s"} left to accept. It goes to someone else
              when the time runs out.
            </p>
          </div>
        </div>

        <Link
          to="/doctor/queue"
          className={`shrink-0 rounded-xl px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 ${urgent ? "bg-red-600" : "bg-brand"}`}
        >
          Open the request
        </Link>
      </div>
    </div>
  );
}

export type { DoctorShift };
