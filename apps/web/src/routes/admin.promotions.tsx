import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Loader2, Tag, Ban } from "lucide-react";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import {
  formatMinor,
  useAdminPromotions,
  useCreatePromotion,
  useDeactivatePromotion,
  type Promotion,
} from "@/features/finance/api";

export const Route = createFileRoute("/admin/promotions")({
  component: AdminPromotions,
});

/**
 * Promotional codes (spec §42).
 *
 * A code's rules are enforced when a pharmacy redeems it, on the server, where
 * no client can supply a discount amount. This screen is where the codes come
 * from — before it existed, running a campaign meant writing database rows by
 * hand.
 */
function AdminPromotions() {
  const { data: promotions, isLoading, error } = useAdminPromotions(false);

  return (
    <AppShell active="admin">
      <header>
        <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
        <h1 className="text-3xl font-bold tracking-tight">Promotions</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-500">
          Discount codes a pharmacy can apply when starting a consultation. Every rule — window,
          usage limit, minimum amount — is checked server-side at redemption.
        </p>
      </header>

      <NewPromotion />

      {isLoading && (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      )}

      {error && (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {error instanceof ApiError ? error.message : "Promotions could not be loaded."}
          </p>
        </div>
      )}

      {promotions?.length === 0 && (
        <div className="card-soft p-12 text-center">
          <Tag className="mx-auto size-10 text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">No promotions have been created yet.</p>
        </div>
      )}

      <div className="space-y-3">
        {promotions?.map((promotion) => (
          <PromotionRow key={promotion.code} promotion={promotion} />
        ))}
      </div>
    </AppShell>
  );
}

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function NewPromotion() {
  const create = useCreatePromotion();
  const [code, setCode] = useState("");
  const [type, setType] = useState<"PERCENT" | "FIXED">("PERCENT");
  const [value, setValue] = useState("");
  const [startsAt, setStartsAt] = useState(today());
  const [endsAt, setEndsAt] = useState(inDays(30));
  const [maxUses, setMaxUses] = useState("");
  const [campaign, setCampaign] = useState("");

  const numericValue = Number(value);
  const ready = code.trim().length >= 3 && Number.isFinite(numericValue) && numericValue > 0;

  return (
    <section className="card-soft p-6">
      <h2 className="font-bold">New promotion</h2>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Code</span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            maxLength={40}
            placeholder="LAUNCH20"
            className="mt-1 w-full rounded-xl border border-border px-3 py-2 font-mono text-sm"
          />
        </label>

        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Type</span>
          <select
            value={type}
            onChange={(event) => setType(event.target.value as "PERCENT" | "FIXED")}
            className="mt-1 w-full rounded-xl border border-border bg-white px-3 py-2 text-sm"
          >
            <option value="PERCENT">Percentage off</option>
            <option value="FIXED">Fixed amount off</option>
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
            {type === "PERCENT" ? "Per cent" : "Amount (GH₵)"}
          </span>
          <input
            type="number"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            min={0}
            step={type === "PERCENT" ? 1 : 0.01}
            placeholder={type === "PERCENT" ? "20" : "10.00"}
            className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">From</span>
          <input
            type="date"
            value={startsAt}
            onChange={(event) => setStartsAt(event.target.value)}
            className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Until</span>
          <input
            type="date"
            value={endsAt}
            onChange={(event) => setEndsAt(event.target.value)}
            className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Usage limit (optional)
          </span>
          <input
            type="number"
            value={maxUses}
            onChange={(event) => setMaxUses(event.target.value)}
            min={1}
            placeholder="Unlimited"
            className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
          />
        </label>

        <label className="block sm:col-span-2 lg:col-span-3">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
            Campaign (optional)
          </span>
          <input
            value={campaign}
            onChange={(event) => setCampaign(event.target.value)}
            maxLength={120}
            placeholder="Accra launch, September"
            className="mt-1 w-full rounded-xl border border-border px-3 py-2 text-sm"
          />
        </label>
      </div>

      {create.error && (
        <p className="mt-3 text-sm text-red-600">
          {create.error instanceof ApiError
            ? create.error.message
            : "The promotion could not be created."}
        </p>
      )}

      <button
        type="button"
        disabled={!ready || create.isPending}
        onClick={() =>
          create.mutate(
            {
              code: code.trim(),
              type,
              // Percentages travel as basis points and money as pesewas, so
              // neither crosses the wire as a decimal (spec §38, §98).
              valueBp: type === "PERCENT" ? Math.round(numericValue * 100) : undefined,
              valueMinor: type === "FIXED" ? Math.round(numericValue * 100) : undefined,
              startsAt,
              endsAt,
              maxUses: maxUses ? Number(maxUses) : undefined,
              campaign: campaign.trim() || undefined,
            },
            {
              onSuccess: () => {
                setCode("");
                setValue("");
                setMaxUses("");
                setCampaign("");
              },
            },
          )
        }
        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-bold text-white hover:brightness-110 disabled:opacity-40"
      >
        {create.isPending && <Loader2 className="size-4 animate-spin" />}
        Create
      </button>
    </section>
  );
}

function PromotionRow({ promotion }: { promotion: Promotion }) {
  const deactivate = useDeactivatePromotion();

  const worth =
    promotion.type === "PERCENT"
      ? `${(promotion.valueBp ?? 0) / 100}% off`
      : `${formatMinor(promotion.valueMinor ?? 0)} off`;

  return (
    <section className="card-soft flex flex-wrap items-center justify-between gap-4 p-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-bold">{promotion.code}</span>
          <Chip tone={promotion.redeemable ? "medical" : "muted"}>
            {promotion.redeemable
              ? "redeemable"
              : promotion.isActive
                ? "not in window"
                : "withdrawn"}
          </Chip>
        </div>
        <p className="mt-1 text-sm text-slate-600">
          {worth} · {new Date(promotion.startsAt).toLocaleDateString()} to{" "}
          {new Date(promotion.endsAt).toLocaleDateString()}
          {promotion.pharmacyName && ` · ${promotion.pharmacyName} only`}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">
          Used {promotion.usedCount}
          {promotion.maxUses !== null && ` of ${promotion.maxUses}`} ·{" "}
          {/*
            What the campaign has actually cost. `usedCount` alone does not say
            it, and it is the number an administrator is asked about.
          */}
          {formatMinor(promotion.discountedMinor)} given away
          {promotion.campaign && ` · ${promotion.campaign}`}
        </p>
      </div>

      {promotion.isActive && (
        <button
          type="button"
          disabled={deactivate.isPending}
          onClick={() => deactivate.mutate(promotion.code)}
          className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
        >
          <Ban className="size-4" /> Withdraw
        </button>
      )}
    </section>
  );
}
