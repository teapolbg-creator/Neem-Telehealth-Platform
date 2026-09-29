import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CalendarClock, Download, FileText, Loader2, RotateCcw } from "lucide-react";
import { PatientFrame, FrameMessage } from "@/components/neem/PatientFrame";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  accountDocumentUrl,
  useAccountDocuments,
  useMyAppointments,
  usePatientAccount,
  useRejoinBooking,
  useSignOutAccount,
  type AccountAppointment,
  type AccountConsultation,
} from "@/features/patient/api";

export const Route = createFileRoute("/account/")({
  component: MyCare,
});

/**
 * Everything a patient can come back to (v2).
 *
 * The counter's patient has one consultation and a session that ends with it.
 * A patient with an account has a history — what is booked, what happened, and
 * the documents a professional wrote for them — and this is where they find it
 * without asking anybody.
 *
 * What is deliberately not here: anything clinical beyond the documents
 * themselves. The sealed record is not a patient-facing surface (D23, D24).
 */
function MyCare() {
  const account = usePatientAccount();
  const appointments = useMyAppointments({ enabled: Boolean(account.data) });
  const documents = useAccountDocuments({ enabled: Boolean(account.data) });
  const signOut = useSignOutAccount();

  if (account.isLoading) {
    return (
      <PatientFrame>
        <div className="grid place-items-center py-24">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      </PatientFrame>
    );
  }

  // Not an error: it is the ordinary state of a browser that has not signed in.
  if (!account.data) {
    return (
      <PatientFrame back={{ to: "/book", label: "Book" }}>
        <FrameMessage title="Sign in to see your care">
          <p>
            Start a booking and we will send a code to your email. The same code brings you back
            here afterwards.
          </p>
        </FrameMessage>
        <Link
          to="/book"
          className="mt-4 block rounded-xl bg-brand py-3.5 text-center font-semibold text-white hover:brightness-110"
        >
          See what Neem offers
        </Link>
      </PatientFrame>
    );
  }

  const upcoming = (appointments.data ?? []).filter(
    (appointment) => appointment.state === "RESERVED" || appointment.state === "CONFIRMED",
  );

  /*
   * A consultation that was under way and is not finished (D57).
   *
   * This is the whole point of coming back here on a phone whose browser died
   * mid-call, so it goes above everything else, including what is booked.
   */
  const unfinished = account.data.consultations.filter(
    (consultation) =>
      consultation.state === "INTERRUPTED" ||
      consultation.state === "IN_PROGRESS" ||
      consultation.state === "DOCTOR_ACCEPTED",
  );
  const documentGroups = documents.data?.consultations ?? [];

  return (
    <PatientFrame back={{ to: "/book", label: "Book" }}>
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">My care</h1>
      </header>

      {unfinished.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-400">
            Unfinished
          </h2>
          <div className="space-y-2">
            {unfinished.map((consultation) => (
              <UnfinishedRow key={consultation.publicId} consultation={consultation} />
            ))}
          </div>
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-400">Booked</h2>

        {upcoming.length === 0 ? (
          <p className="card-soft p-5 text-sm text-slate-500">Nothing booked at the moment.</p>
        ) : (
          <div className="space-y-2">
            {upcoming.map((appointment) => (
              <AppointmentRow key={appointment.reference} appointment={appointment} />
            ))}
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-400">
          Your documents
        </h2>

        {documents.isLoading ? (
          <div className="card-soft grid place-items-center p-8">
            <Loader2 className="size-5 animate-spin text-brand" />
          </div>
        ) : documentGroups.length === 0 ? (
          <p className="card-soft p-5 text-sm leading-relaxed text-slate-500">
            Anything a professional writes for you appears here and stays here: a prescription, a
            referral, a summary.
          </p>
        ) : (
          <div className="space-y-3">
            {documentGroups.map((group) => (
              <div key={group.consultationReference} className="card-soft p-5">
                <p className="font-mono text-xs text-slate-400">{group.consultationReference}</p>
                <div className="mt-3 space-y-2">
                  {group.documents.map((document) => (
                    <a
                      key={document.publicId}
                      href={accountDocumentUrl(document.kind, document.publicId)}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-3 rounded-xl border border-border p-3 hover:bg-slate-50"
                    >
                      <FileText className="size-4 shrink-0 text-brand" />
                      <span className="flex-1 text-sm font-semibold">{document.title}</span>
                      <Download className="size-4 shrink-0 text-slate-400" />
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-400">History</h2>

        {account.data.consultations.length === 0 ? (
          <p className="card-soft p-5 text-sm text-slate-500">No consultations yet.</p>
        ) : (
          <div className="card-soft divide-y divide-border">
            {account.data.consultations.map((consultation) => (
              <div key={consultation.publicId} className="flex items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {consultation.serviceName ?? "Consultation"}
                  </p>
                  <p className="font-mono text-xs text-slate-400">{consultation.publicId}</p>
                </div>
                <span className="shrink-0 text-xs text-slate-500">
                  {new Date(consultation.createdAt).toLocaleDateString("en-GH", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <button
        type="button"
        onClick={() => signOut.mutate()}
        disabled={signOut.isPending}
        className="w-full rounded-xl border border-border py-3 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50"
      >
        Sign out on this device
      </button>
    </PatientFrame>
  );
}

/**
 * One consultation waiting to be picked back up.
 *
 * The sentence about paying comes before the button, not after it. A patient
 * whose call dropped will not press anything they think might charge them
 * again, and the button is worth nothing if they will not press it.
 */
function UnfinishedRow({ consultation }: { consultation: AccountConsultation }) {
  const rejoin = useRejoinBooking();
  const navigate = useNavigate();

  return (
    <div className="card-soft p-4">
      <div className="flex items-start gap-3">
        <RotateCcw className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{consultation.serviceName ?? "Consultation"}</p>
          <p className="font-mono text-xs text-slate-400">{consultation.publicId}</p>
          <p className="mt-2 text-sm font-bold text-slate-900">You do not need to pay again.</p>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
            This consultation is still open. Rejoin and the same professional will be told you are
            back.
          </p>
        </div>
      </div>

      <button
        type="button"
        disabled={rejoin.isPending}
        onClick={() =>
          rejoin.mutate(consultation.publicId, {
            // The session cookie the server just set is what the portal reads,
            // so there is nothing to pass along.
            onSuccess: () => void navigate({ to: "/patient" }),
          })
        }
        className="mt-3 w-full rounded-xl bg-brand py-3 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
      >
        {rejoin.isPending ? "Rejoining…" : "Rejoin the consultation"}
      </button>

      {rejoin.isError && (
        <p className="mt-2 text-xs text-red-600">
          {rejoin.error instanceof ApiError
            ? rejoin.error.message
            : "That consultation could not be rejoined."}
        </p>
      )}
    </div>
  );
}

function AppointmentRow({ appointment }: { appointment: AccountAppointment }) {
  const unpaid = appointment.state === "RESERVED";

  return (
    <div className="card-soft flex items-start gap-3 p-4">
      <CalendarClock className="mt-0.5 size-5 shrink-0 text-brand" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          {new Date(appointment.startsAt).toLocaleString("en-GH", {
            weekday: "long",
            day: "numeric",
            month: "long",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
        <p className="truncate text-sm text-slate-500">
          {appointment.service.name} · {appointment.professional.fullName}
        </p>
      </div>
      {/*
        An unpaid reservation is a held slot, not a booking, and the difference
        matters to somebody deciding whether to be free that afternoon.
      */}
      <Chip tone={unpaid ? "warning" : "medical"}>{unpaid ? "Unpaid" : "Confirmed"}</Chip>
    </div>
  );
}
