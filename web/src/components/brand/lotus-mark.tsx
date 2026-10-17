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
      src="/brand/idyllic-mark.png"
      alt=""
      width={size}
      height={size}
      priority={priority}
      className={cn("rounded-xl dark:bg-white/95 dark:p-1", className)}
    />
  );
}
