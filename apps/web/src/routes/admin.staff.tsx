import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AlertCircle, Check, Copy, KeyRound, Loader2, UserPlus } from "lucide-react";
import {
  GEO_SCOPE_LEVELS,
  type GeoScopeLevel,
  type StaffAccount,
  type StaffAccountRole,
  type StaffAccountSetup,
} from "@neem/contracts";
import { AppShell } from "@/components/neem/AppShell";
import { Chip } from "@/components/neem/Chip";
import { ApiError } from "@/lib/api-client";
import { Field } from "@/features/facility/LocationFields";
import { useGeography } from "@/features/facility/api";
import { inputClass } from "@/features/facility/form";
import {
  ROLE_LABEL,
  SCOPE_LEVEL_LABEL,
  useCreateStaffAccount,
  useReissueStaffSetupLink,
  useSetStaffAccountStatus,
  useStaffAccounts,
} from "@/features/staff/api";

export const Route = createFileRoute("/admin/staff")({
  component: StaffAccounts,
});

/**
 * Neem's own staff accounts (CHPS slice 3a, D84).
 *
 * The super administrator creates operations administrators and district
 * officers here and hands each a one-time set-up link. Super administrators
 * are listed so the list is complete, but are made and changed only on the
 * server.
 */
function StaffAccounts() {
  const accounts = useStaffAccounts();
  const [adding, setAdding] = useState(false);
  const [setup, setSetup] = useState<StaffAccountSetup | null>(null);

  return (
    <AppShell active="admin">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 text-sm font-semibold text-brand">Neem Administration</p>
          <h1 className="text-3xl font-bold tracking-tight">Staff accounts</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-500">
            Operations administrators run the queue, doctors, pharmacies and facilities, without
            staff accounts, settings, money or the audit log. District officers see the CHPS
            facilities in their area and change nothing.
          </p>
        </div>
        {!adding ? (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setSetup(null);
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            <UserPlus className="size-4" /> Add an account
          </button>
        ) : null}
      </header>

      {setup ? <SetupLink setup={setup} onDone={() => setSetup(null)} /> : null}

      {adding ? (
        <AddAccount
          onCancel={() => setAdding(false)}
          onCreated={(created) => {
            setAdding(false);
            setSetup(created);
          }}
        />
      ) : null}

      {accounts.isLoading ? (
        <div className="card-soft grid place-items-center p-16">
          <Loader2 className="size-6 animate-spin text-brand" />
        </div>
      ) : null}

      {accounts.error ? (
        <div className="card-soft flex items-start gap-3 border-red-200 bg-red-50 p-6">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-500" />
          <p className="text-sm text-red-700">
            {accounts.error instanceof ApiError
              ? accounts.error.message
              : "The accounts could not be loaded."}
          </p>
        </div>
      ) : null}

      {accounts.data ? <AccountList accounts={accounts.data} onSetup={setSetup} /> : null}
    </AppShell>
  );
}

function AccountList({
  accounts,
  onSetup,
}: {
  accounts: StaffAccount[];
  onSetup: (setup: StaffAccountSetup) => void;
}) {
  const setStatus = useSetStaffAccountStatus();
  const reissue = useReissueStaffSetupLink();
  const error = setStatus.error ?? reissue.error;

  return (
    <div className="card-soft p-5">
      <ul className="divide-y divide-border">
        {accounts.map((account) => {
          const editable = account.role !== "ADMIN" && !account.isSelf;
          return (
            <li
              key={account.userPublicId}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="font-semibold">
                  {account.fullName}
                  {account.isSelf ? (
                    <span className="ml-2 text-xs font-normal text-slate-500">you</span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {ROLE_LABEL[account.role]}
                  {account.scope ? ` · ${account.scope.label}` : ""}
                  {account.title ? ` · ${account.title}` : ""} · {account.email}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {account.status !== "ACTIVE" ? (
                  <Chip tone="danger">
                    {account.status === "SUSPENDED" ? "Suspended" : "Disabled"}
                  </Chip>
                ) : !account.hasSetPassword ? (
                  <Chip tone="warning">Awaiting set-up</Chip>
                ) : account.role !== "DISTRICT" && !account.twoFactorEnabled ? (
                  <Chip tone="warning">2FA not enrolled</Chip>
                ) : (
                  <Chip tone="brand">Set up</Chip>
                )}
                {editable && account.status === "ACTIVE" ? (
                  <button
                    type="button"
                    disabled={reissue.isPending}
                    onClick={() =>
                      reissue.mutate(account.userPublicId, { onSuccess: (next) => onSetup(next) })
                    }
                    title="Issue a new one-time link. Any earlier link stops working."
                    className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    <KeyRound className="size-3" /> New set-up link
                  </button>
                ) : null}
                {editable && account.status !== "DISABLED" ? (
                  <button
                    type="button"
                    disabled={setStatus.isPending}
                    onClick={() =>
                      setStatus.mutate({
                        userPublicId: account.userPublicId,
                        status: account.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE",
                      })
                    }
                    className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    {account.status === "ACTIVE" ? "Suspend" : "Restore"}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="mt-3 text-sm text-red-600">
          {error instanceof ApiError ? error.message : "Not changed."}
        </p>
      ) : null}
    </div>
  );
}

function AddAccount({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (setup: StaffAccountSetup) => void;
}) {
  const create = useCreateStaffAccount();
  const geography = useGeography();
  const [role, setRole] = useState<StaffAccountRole>("DISTRICT");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [phone, setPhone] = useState("");
  const [level, setLevel] = useState<GeoScopeLevel>("DISTRICT");
  const [regionId, setRegionId] = useState("");
  const [districtId, setDistrictId] = useState("");
  const [subDistrictId, setSubDistrictId] = useState("");
  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};

  const region = geography.data?.find((entry) => entry.id === regionId);
  const district = region?.districts.find((entry) => entry.id === districtId);

  return (
    <form
      className="card-soft space-y-4 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(
          role === "OPS_ADMIN"
            ? { role, fullName, email, title }
            : {
                role,
                fullName,
                email,
                title,
                phone,
                scope: { level, regionId, districtId, subDistrictId },
              },
          { onSuccess: onCreated },
        );
      }}
    >
      <p className="font-bold">New account</p>
      <div className="flex flex-wrap gap-2">
        {(["DISTRICT", "OPS_ADMIN"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setRole(option)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${
              role === option
                ? "border-brand bg-brand-soft text-brand"
                : "border-border text-slate-600 hover:bg-slate-50"
            }`}
          >
            {ROLE_LABEL[option]}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        {role === "OPS_ADMIN"
          ? "Must enrol in two-factor authentication on first sign-in."
          : "Sees the facilities in the chosen area. Cannot change anything."}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" error={fieldErrors.fullName}>
          <input
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Email (used to sign in)" error={fieldErrors.email}>
          <input
            value={email}
            type="email"
            onChange={(event) => setEmail(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Title (optional)" error={fieldErrors.title}>
          <input
            value={title}
            placeholder={role === "DISTRICT" ? "e.g. District Director of Health Services" : ""}
            onChange={(event) => setTitle(event.target.value)}
            className={inputClass}
          />
        </Field>
        {role === "DISTRICT" ? (
          <Field label="Phone (optional)" error={fieldErrors.phone}>
            <input
              value={phone}
              inputMode="tel"
              onChange={(event) => setPhone(event.target.value)}
              className={inputClass}
            />
          </Field>
        ) : null}
      </div>

      {role === "DISTRICT" ? (
        <div className="space-y-3 rounded-xl border border-border bg-slate-50/60 p-4">
          <p className="text-sm font-semibold">Area this account covers</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Covers">
              <select
                value={level}
                onChange={(event) => setLevel(event.target.value as GeoScopeLevel)}
                className={inputClass}
              >
                {GEO_SCOPE_LEVELS.map((option) => (
                  <option key={option} value={option}>
                    {SCOPE_LEVEL_LABEL[option]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Region" error={fieldErrors["scope.regionId"]}>
              <select
                value={regionId}
                onChange={(event) => {
                  setRegionId(event.target.value);
                  setDistrictId("");
                  setSubDistrictId("");
                }}
                className={inputClass}
              >
                <option value="">Choose a region</option>
                {geography.data?.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </Field>
            {level !== "REGION" ? (
              <Field label="District" error={fieldErrors["scope.districtId"]}>
                <select
                  value={districtId}
                  disabled={!region}
                  onChange={(event) => {
                    setDistrictId(event.target.value);
                    setSubDistrictId("");
                  }}
                  className={inputClass}
                >
                  <option value="">{region ? "Choose a district" : "Choose a region first"}</option>
                  {region?.districts.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {level === "SUB_DISTRICT" ? (
              <Field label="Sub-district" error={fieldErrors["scope.subDistrictId"]}>
                <select
                  value={subDistrictId}
                  disabled={!district}
                  onChange={(event) => setSubDistrictId(event.target.value)}
                  className={inputClass}
                >
                  <option value="">
                    {!district
                      ? "Choose a district first"
                      : district.subDistricts.length === 0
                        ? "None recorded in this district"
                        : "Choose a sub-district"}
                  </option>
                  {district?.subDistricts.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>
        </div>
      ) : null}

      {create.error && Object.keys(fieldErrors).length === 0 ? (
        <p className="text-sm text-red-600">
          {create.error instanceof ApiError ? create.error.message : "Not created."}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-white"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!fullName.trim() || !email.trim() || create.isPending}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          Create account
        </button>
      </div>
    </form>
  );
}

/**
 * The one-time link, shown once, as for CHPS staff. It is a credential: give
 * it to its owner and nobody else.
 */
function SetupLink({ setup, onDone }: { setup: StaffAccountSetup; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}${setup.setupPath}`;

  return (
    <div className="space-y-2 rounded-xl border border-brand/30 bg-brand-soft p-4">
      <p className="text-sm font-semibold">Set-up link for {setup.account.fullName}</p>
      <p className="text-xs text-slate-600">
        Give this to {setup.account.fullName} and nobody else. They use it once to choose their
        password. It expires {new Date(setup.setupExpiresAt).toLocaleString()} and will not be shown
        again.{" "}
        {setup.emailed
          ? `It has also been emailed to ${setup.account.email}.`
          : "Email is not set up on this deployment, so it has not been emailed."}
      </p>
      <div className="flex gap-2">
        <input readOnly value={url} className={`${inputClass} font-mono text-xs`} />
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => setCopied(true));
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <button
        type="button"
        onClick={onDone}
        className="text-xs font-semibold text-slate-600 hover:underline"
      >
        Done — hide the link
      </button>
    </div>
  );
}
