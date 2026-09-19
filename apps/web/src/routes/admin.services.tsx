import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { formatMoney } from "@/features/consultation/api";
import {
  DISCIPLINE_LABEL,
  useAdminServices,
  useUpdateService,
  type AdminService,
} from "@/features/professionals/api";

export const Route = createFileRoute("/admin/services")({
  component: AdminServices,
});

const CLINIC_LABEL: Record<string, string> = {
  GENERAL: "General practice",
  WEIGHT_LOSS: "Weight-loss clinic",
};

/**
 * What patients can book, and what it costs (v2).
 *
 * A price change here applies to bookings made after it. Every consultation
 * keeps the price it was booked at, so nobody's charge is rewritten, and each
 * change is recorded in the audit log with what it was and what it became.
 *
 * The counter's own price is not here: it is the `consultation.priceMinor`
 * setting, under Settings.
 */
function AdminServices() {
  const { data, isLoading, error } = useAdminServices();

  return (
    <AppShell active="admin">
      <div className="mx-auto w-full max-w-4xl">
        <p className="text-xs font-bold uppercase tracking-wider text-brand">Neem Administration</p>
        <h1 className="mt-1 text-3xl font-bold">Services</h1>
        <p className="mt-2 max-w-2xl text-pretty text-sm leading-relaxed text-slate-500">
          What patients can book for themselves, and what each costs. A change applies to bookings
          made after it; every consultation keeps the price it was booked at. The pharmacy counter
          price is under Settings.
        </p>

        {isLoading && (
          <div className="card-soft mt-6 grid place-items-center p-16">
            <Loader2 className="size-6 animate-spin text-brand" />
          </div>
        )}

        {error && (
          <div className="card-soft mt-6 flex items-start gap-3 border-red-200 bg-red-50 p-6">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
            <p className="text-sm text-red-700">
              {error instanceof ApiError ? error.message : "Services could not be loaded."}
            </p>
          </div>
        )}

        {data && (
          <div className="mt-6 space-y-3">
            {data.map((service) => (
              <ServiceRow key={service.code} service={service} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function ServiceRow({ service }: { service: AdminService }) {
  const update = useUpdateService();
  const [cedis, setCedis] = useState((service.price.amountMinor / 100).toFixed(2));

  const priceMinor = Math.round(Number(cedis) * 100);
  const priceValid = Number.isFinite(priceMinor) && priceMinor >= 100;
  const priceChanged = priceValid && priceMinor !== service.price.amountMinor;

  return (
    <div className="card-soft p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold">{service.name}</p>
          <p className="text-xs text-slate-500">
            {CLINIC_LABEL[service.clinic] ?? service.clinic} ·{" "}
            {DISCIPLINE_LABEL[service.discipline] ?? service.discipline} ·{" "}
            <span className="font-mono">{service.code}</span>
          </p>
        </div>
        <Chip tone={service.isActive ? "brand" : "muted"}>
          {service.isActive ? "Offered" : "Not offered"}
        </Chip>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-semibold text-slate-500">Price (GH₵)</span>
          <input
            inputMode="decimal"
            value={cedis}
            onChange={(event) => setCedis(event.target.value.replace(/[^\d.]/g, ""))}
            className="w-32 rounded-lg border border-border px-3 py-2 text-sm tabular-nums"
          />
        </label>

        <button
          type="button"
          disabled={!priceChanged || update.isPending}
          onClick={() => update.mutate({ code: service.code, priceMinor })}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          Save price
        </button>

        <button
          type="button"
          disabled={update.isPending}
          onClick={() => update.mutate({ code: service.code, isActive: !service.isActive })}
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
        >
          {service.isActive ? "Stop offering" : "Start offering"}
        </button>

        {priceChanged ? (
          <span className="pb-2 text-xs text-slate-500">
            {formatMoney(service.price)} →{" "}
            {formatMoney({ amountMinor: priceMinor, currency: service.price.currency })}
          </span>
        ) : null}
      </div>

      {update.error ? (
        <p className="mt-3 text-sm text-red-600">
          {update.error instanceof ApiError ? update.error.message : "Not saved."}
        </p>
      ) : null}
    </div>
  );
}
