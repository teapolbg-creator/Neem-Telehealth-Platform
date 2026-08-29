import { cn } from "@/lib/utils";
import neemMark from "@/assets/neem-mark.png";

/**
 * The Neem mark and wordmark.
 *
 * The Lovable prototype loaded this through `neem-mark.png.asset.json`, whose
 * URL (`/__l5e/assets-v1/…`) resolves only on Lovable's own infrastructure — so
 * the logo rendered as a broken image everywhere else. The asset is now a real
 * file in the repository, bundled by Vite like any other import.
 */
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
        src={neemMark}
        alt="Neem"
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
