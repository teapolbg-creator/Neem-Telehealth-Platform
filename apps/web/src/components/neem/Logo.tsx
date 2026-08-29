import { cn } from "@/lib/utils";
import markAsset from "@/assets/neem-mark.png.asset.json";

export function NeemLogo({
  className,
  markClassName,
  showWordmark = true,
}: {
  className?: string;
  markClassName?: string;
  showWordmark?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <img
        src={markAsset.url}
        alt="Neem logo"
        className={cn("size-9 object-contain", markClassName)}
      />
      {showWordmark && (
        <span className="font-display font-bold tracking-[0.14em] uppercase text-brand leading-none">
          Neem
        </span>
      )}
    </span>
  );
}
