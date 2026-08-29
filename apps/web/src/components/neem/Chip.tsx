import { cn } from "@/lib/utils";

type Tone = "brand" | "medical" | "warning" | "muted" | "danger";

const toneMap: Record<Tone, string> = {
  brand: "bg-brand/10 text-brand",
  medical: "bg-medical/10 text-medical",
  warning: "bg-warning/15 text-warning",
  muted: "bg-slate-100 text-slate-600",
  danger: "bg-red-100 text-red-600",
};

export function Chip({
  tone = "muted",
  pulse = false,
  children,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("chip", toneMap[tone], className)}>
      {pulse && (
        <span
          className={cn(
            "size-1.5 rounded-full",
            tone === "brand" && "bg-brand animate-pulse",
            tone === "medical" && "bg-medical animate-pulse",
            tone === "warning" && "bg-warning animate-pulse",
            tone === "danger" && "bg-red-500 animate-pulse",
            tone === "muted" && "bg-slate-400",
          )}
        />
      )}
      {children}
    </span>
  );
}
