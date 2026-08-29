import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { NeemLogo } from "@/components/neem/Logo";
import { ApiError } from "@/lib/api-client";
import { useExchangeToken } from "@/features/consultation/api";

export const Route = createFileRoute("/s/$token")({
  component: ConsultationLanding,
});

/**
 * The QR landing page (spec §10, §71).
 *
 * The patient's whole journey starts here: they scan a code at the pharmacy
 * counter and land on this URL. It exchanges the one-time token for a
 * device-bound session, then hands over to the portal.
 *
 * Two details that matter:
 *
 *  - The exchange is a POST the page makes itself, not a GET the URL performs.
 *    A GET would be consumed by link previews, antivirus scanners and chat
 *    clients before the patient ever arrived, burning a single-use code.
 *  - It runs exactly once. React strict mode double-invokes effects in
 *    development, and a second exchange would fail against its own first.
 */
function ConsultationLanding() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const exchange = useExchangeToken();
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    exchange.mutate(token, {
      // Replace, so the token never sits in history where a back button —
      // or a shared screenshot of the address bar — could resurface it.
      onSuccess: () => void navigate({ to: "/patient", replace: true }),
    });
  }, [token, exchange, navigate]);

  return (
    <div className="grid min-h-dvh place-items-center bg-surface px-6">
      <div className="w-full max-w-sm text-center">
        <NeemLogo className="mx-auto text-xl" markClassName="size-10" />

        {exchange.isError ? (
          <div className="card-soft mt-8 border-red-200 bg-red-50 p-6 text-left">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
              <div>
                <p className="font-bold text-red-700">This link is no longer valid</p>
                <p className="mt-1 text-sm leading-relaxed text-red-700">
                  {exchange.error instanceof ApiError
                    ? exchange.error.message
                    : "Please ask the pharmacy for a new code."}
                </p>
              </div>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-slate-600">
              Each consultation code works once, and only for a short time. The pharmacist can print
              a new one for you.
            </p>
          </div>
        ) : (
          <div className="mt-10">
            <Loader2 className="mx-auto size-7 animate-spin text-brand" />
            <p className="mt-4 text-sm text-slate-500">Opening your consultation…</p>
          </div>
        )}
      </div>
    </div>
  );
}
