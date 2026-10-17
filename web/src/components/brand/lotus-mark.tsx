import Image from "next/image";
import { cn } from "@/lib/utils";

// The Idyllic lotus. In dark mode the navy petals would sink into the page, so the mark sits on a
// light tile there.
export function LotusMark({
  size,
  className,
  priority,
}: {
  size: number;
  className?: string;
  priority?: boolean;
}) {
  return (
    <Image
      // Pre-sized WebP files: image optimisation is off (it bills), so the browser gets the bytes as-is.
      src={
        size > 80
          ? "/brand/idyllic-mark-256.webp"
          : "/brand/idyllic-mark-80.webp"
      }
      alt=""
      width={size}
      height={size}
      sizes={`${size}px`}
      priority={priority}
      className={cn("rounded-xl dark:bg-white/95 dark:p-1", className)}
    />
  );
}
