import { useEffect, useRef, useState } from "react";
import { Eraser, Check } from "lucide-react";

/**
 * Signature capture (spec §23, answers doc Q18: "Doctor draws signature during
 * onboarding").
 *
 * Draws to a canvas and exports a PNG data URI. The API encrypts it at rest
 * and binds it to the verified doctor; it is never served from a public URL,
 * because a signature reachable by URL is a signature anyone can forge onto a
 * prescription.
 *
 * Handles pointer events rather than mouse events so it works with a stylus or
 * a finger — a doctor onboarding on a tablet is the likely case.
 */
export function SignaturePad({
  onCapture,
  disabled,
  existingCapturedAt,
}: {
  onCapture: (dataUrl: string) => void;
  disabled?: boolean;
  existingCapturedAt?: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    /**
     * Size the backing store to the element's real size.
     *
     * Measuring once on mount is not enough: the canvas is inside a responsive
     * grid, so on first paint it can report a much narrower box than it ends up
     * with. That mismatch is not cosmetic — pointer coordinates are in CSS
     * pixels, so an undersized backing store makes the stroke drift away from
     * the pointer and exports a distorted signature.
     *
     * A ResizeObserver re-sizes whenever the element settles or the window
     * changes. Resizing a canvas clears it, so any existing stroke is preserved
     * and redrawn.
     */
    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const nextWidth = Math.round(rect.width * ratio);
      const nextHeight = Math.round(rect.height * ratio);
      if (canvas.width === nextWidth && canvas.height === nextHeight) return;

      const previous =
        canvas.width > 0 && canvas.height > 0
          ? canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height)
          : undefined;

      canvas.width = nextWidth;
      canvas.height = nextHeight;

      const context = canvas.getContext("2d");
      if (!context) return;

      if (previous) context.putImageData(previous, 0, 0);

      // Draw in CSS pixels; the backing store stays at device resolution so the
      // exported PNG is crisp on a high-DPI tablet.
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.lineWidth = 2;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = "#0f172a";
    };

    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const positionOf = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const start = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;

    // Capture the pointer so a stroke that leaves the canvas still ends cleanly.
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;

    const { x, y } = positionOf(event);
    context.beginPath();
    context.moveTo(x, y);
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || disabled) return;
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;

    const { x, y } = positionOf(event);
    context.lineTo(x, y);
    context.stroke();
    setHasInk(true);
  };

  const end = () => {
    drawing.current = false;
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    context.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  };

  return (
    <div>
      {existingCapturedAt && (
        <p className="mb-3 flex items-center gap-2 text-xs text-brand">
          <Check className="size-4" />
          Signature captured on {new Date(existingCapturedAt).toLocaleDateString()}. Drawing a new
          one replaces it for future prescriptions.
        </p>
      )}

      <div className="rounded-2xl border-2 border-dashed border-border bg-white">
        <canvas
          ref={canvasRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          className="h-40 w-full touch-none rounded-2xl"
          aria-label="Signature drawing area"
          role="img"
        />
      </div>

      <p className="mt-2 text-xs text-slate-500">
        Sign as you would on a paper prescription. This signature appears on every prescription and
        referral you issue.
      </p>

      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={clear}
          disabled={disabled || !hasInk}
          className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-slate-50 disabled:opacity-40"
        >
          <Eraser className="size-4" /> Clear
        </button>

        <button
          type="button"
          disabled={disabled || !hasInk}
          onClick={() => {
            const dataUrl = canvasRef.current?.toDataURL("image/png");
            if (dataUrl) onCapture(dataUrl);
          }}
          className="flex-1 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          Save signature
        </button>
      </div>
    </div>
  );
}
