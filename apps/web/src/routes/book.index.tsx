import { createFileRoute, Link } from "@tanstack/react-router";
import { Loader2, Stethoscope } from "lucide-react";
import { PatientFrame, FrameMessage } from "@/components/neem/PatientFrame";
import { formatMoney } from "@/features/consultation/api";
import { usePatientClinics, type PatientService } from "@/features/patient/api";

export const Route = createFileRoute("/book/")({
  component: WhatWeOffer,
});

/**
 * What a patient can book, and what it costs (v2).
 *
 * The price is shown before anything else is asked for. A patient deciding
 * whether they can afford a consultation should not have to give their name
 * and their symptoms to find out.
 */
function WhatWeOffer() {
  const { data, isLoading } = usePatientClinics();

  if (isLoading) {
    return (
      <PatientFrame wide>
        <div className="grid place-items-center py-24">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      </PatientFrame>
    );
  }

  // Switched off and nothing offered are different facts, and the server tells
  // us which. Neither is an error, and neither is dressed up as one.
  if (!data?.enabled) {
    return (
      <PatientFrame wide>
        <FrameMessage title="Booking is not open yet">
          <p>
            Neem consultations are available today through our partner pharmacies. Booking here, for
            yourself, is coming soon.
          </p>
        </FrameMessage>
      </PatientFrame>
    );
  }

  if (data.clinics.length === 0) {
    return (
      <PatientFrame wide>
        <FrameMessage title="Nothing is available right now">
          <p>Please try again shortly.</p>
        </FrameMessage>
      </PatientFrame>
    );
  }

  return (
    <PatientFrame wide>
      <header className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-balance">
          See someone about it today.
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-pretty text-sm leading-relaxed text-slate-600">
          A licensed Ghanaian professional, by video or audio, from wherever you are. You pay once,
          before the consultation, and you keep whatever they write for you.
        </p>
      </header>

      <div className="space-y-8">
        {data.clinics.map((clinic) => (
          <section key={clinic.code}>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-lg font-bold">{clinic.name}</h2>
              {clinic.fromPrice && clinic.services.length > 1 ? (
                <span className="text-sm text-slate-500">from {formatMoney(clinic.fromPrice)}</span>
              ) : null}
            </div>
            <p className="mb-4 text-sm leading-relaxed text-slate-600">{clinic.description}</p>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {clinic.services.map((service) => (
                <ServiceCard key={service.code} service={service} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </PatientFrame>
  );
}

function ServiceCard({ service }: { service: PatientService }) {
  return (
    <div className="card-soft flex flex-col p-5">
      <div className="mb-3 grid size-10 place-items-center rounded-xl bg-brand/10">
        <Stethoscope className="size-5 text-brand" />
      </div>

      <h3 className="font-bold leading-snug">{service.name}</h3>
      {service.description ? (
        <p className="mt-1.5 flex-1 text-sm leading-relaxed text-slate-600">
          {service.description}
        </p>
      ) : (
        <div className="flex-1" />
      )}

      <p className="mt-4 text-2xl font-bold tabular-nums">{formatMoney(service.price)}</p>

      <div className="mt-4 grid gap-2">
        <Link
          to="/book/$serviceCode"
          params={{ serviceCode: service.code }}
          search={{ when: "now" as const }}
          className="rounded-xl bg-brand py-3 text-center text-sm font-semibold text-white hover:brightness-110"
        >
          Book now
        </Link>
        <Link
          to="/book/$serviceCode"
          params={{ serviceCode: service.code }}
          search={{ when: "later" as const }}
          className="rounded-xl border border-border py-3 text-center text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          Choose a time
        </Link>
      </div>
    </div>
  );
}
