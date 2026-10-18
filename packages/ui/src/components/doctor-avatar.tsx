"use client";

import { useState } from "react";
import { cn } from "@clinic/ui/lib/utils";
import { doctorAvatarSrc, doctorInitials } from "@clinic/ui/lib/doctor-avatar";

type ViewProps = {
  name: string;
  size: number;
  /** null renders the initials fallback. */
  src: string | null;
  onError?: () => void;
  className?: string;
};

// Presentational half, exported so the fallback and the img wiring can be tested without a DOM.
// Fixed width and height on both branches: no layout shift when the fallback swaps in.
export function DoctorAvatarView({
  name,
  size,
  src,
  onError,
  className,
}: ViewProps) {
  const box = { width: size, height: size };
  const base = "inline-block shrink-0 rounded-full";
  if (src === null) {
    return (
      <span
        role="img"
        aria-label={name}
        style={{ ...box, fontSize: Math.max(10, Math.round(size * 0.38)) }}
        className={cn(
          base,
          "inline-flex items-center justify-center bg-muted font-medium text-muted-foreground select-none",
          className,
        )}
      >
        <span aria-hidden="true">{doctorInitials(name)}</span>
      </span>
    );
  }
  return (
    // Plain img: the source is an inline data URI, so next/image has nothing to optimise.
    <img
      src={src}
      alt={name}
      width={size}
      height={size}
      decoding="async"
      onError={onError}
      className={cn(base, "object-cover", className)}
    />
  );
}

export function DoctorAvatar({
  doctorId,
  name,
  size = 40,
  className,
}: {
  doctorId: string;
  name: string;
  size?: number;
  className?: string;
}) {
  const src = doctorAvatarSrc(doctorId);
  // Remember which src failed rather than a boolean, so a new doctorId gets a fresh attempt.
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <DoctorAvatarView
      name={name}
      size={size}
      src={src !== null && failed !== src ? src : null}
      onError={src === null ? undefined : () => setFailed(src)}
      className={className}
    />
  );
}
