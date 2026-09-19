import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { Check, Loader2 } from "lucide-react";
import { PatientFrame, FrameMessage } from "@/components/neem/PatientFrame";
import { ApiError } from "@/lib/api-client";
import { useBookingPaymentStatus } from "@/features/patient/api";

export const Route = createFileRoute("/book/paid")({
  validateSearch: (search: Record<string, unknown>): { booking?: string } => ({
    booking: typeof search.booking === "string" ? search.booking : undefined,
  }),
  component: BackFromCheckout,
});

const ENDED = new Set(["EXPIRED", "CANCELLED", "ABANDONED"]);

/**
 * Where Paystack sends the patient when they finish paying (v2).
 *
 * The address carries our booking reference, and Paystack adds its own
 * transaction reference. Neither decides anything: this page asks the API,
 * which re-verifies with Paystack, exactly as the booking page does. Someone
 * typing this address by hand learns nothing and confirms nothing.
 */
function BackFromCheckout() {
  const { booking } = Route.useSearch();
  const navigate = useNavigate();
  const status = useBookingPaymentStatus(booking ?? null, { watch: true });

  const data = status.data;
  const paid = data?.state === "ACTIVATED" || data?.joinedQueue === true;

  // A consultation for now: straight to the waiting room, as the booking page does.
  useEffect(() => {
    if (data?.joinedQueue && !data.appointmentAt) {
      void navigate({ to: "/patient", replace: true });
    }
  }, [data?.joinedQueue, data?.appointmentAt, navigate]);

  if (!booking) {
    return (
      <PatientFrame>
        <FrameMessage title="Nothing to show here">
          <p>
            Your bookings are under{" "}
            <Link to="/account" className="font-semibold text-brand">
              My care
            </Link>
            .
          </p>
        </FrameMessage>
      </PatientFrame>
    );
  }

  if (status.error) {
    const signedOut = status.error instanceof ApiError && status.error.status === 401;
    return (
      <PatientFrame>
        <FrameMessage
          title={signedOut ? "Sign in to see your booking" : "We could not check that booking"}
        >
          <p>
            Your payment is not affected. Open{" "}
            <Link to="/account" className="font-semibold text-brand">
              My care
            </Link>{" "}
            to see where it stands.
          </p>
        </FrameMessage>
      </PatientFrame>
    );
  }

  if (paid && data?.appointmentAt) {
    return (
      <PatientFrame>
        <div className="card-soft p-8 text-center">
          <div className="mx-auto grid size-14 place-items-center rounded-full bg-emerald-100">
            <Check className="size-7 text-emerald-600" />
          </div>
          <h1 className="mt-4 text-xl font-bold">Paid and booked</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            {new Date(data.appointmentAt).toLocaleString("en-GH", {
              weekday: "long",
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit",
            })}
            . Come back to Neem a few minutes before — your consultation opens by itself.
          </p>
          <p className="mt-4 font-mono text-xs text-slate-400">{booking}</p>
          <Link
            to="/account"
            className="mt-6 block w-full rounded-xl bg-brand py-3.5 font-semibold text-white hover:brightness-110"
          >
            See my bookings
          </Link>
        </div>
      </PatientFrame>
    );
  }

  if (data && (data.state === "PAYMENT_FAILED" || data.paymentStatus === "FAILED")) {
    return (
      <PatientFrame>
        <FrameMessage title="The payment did not go through">
          <p>
            Nothing was charged. You can{" "}
            <Link to="/book" className="font-semibold text-brand">
              book again
            </Link>
            .
          </p>
        </FrameMessage>
      </PatientFrame>
    );
  }

  if (data && ENDED.has(data.state)) {
    return (
      <PatientFrame>
        <FrameMessage title="This booking has closed">
          <p>
            It was not paid in time. You can{" "}
            <Link to="/book" className="font-semibold text-brand">
              book again
            </Link>
            .
          </p>
        </FrameMessage>
      </PatientFrame>
    );
  }

  return (
    <PatientFrame>
      <div className="card-soft p-8 text-center">
        <Loader2 className="mx-auto size-7 animate-spin text-brand" />
        <h1 className="mt-4 text-xl font-bold">Confirming your payment</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          We are checking with Paystack. This page moves on by itself — there is no need to pay
          again.
        </p>
      </div>
    </PatientFrame>
  );
}
