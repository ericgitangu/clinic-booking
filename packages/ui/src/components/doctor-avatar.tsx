"use client";

import { useEffect, useRef, useState, type Ref } from "react";
import { cn } from "@clinic/ui/lib/utils";
import {
  ILLUSTRATION_DISCLOSURE,
  PORTRAIT_DISCLOSURE,
  doctorAvatarSrc,
  doctorInitials,
  doctorPhoto,
} from "@clinic/ui/lib/doctor-avatar";

type ViewProps = {
  name: string;
  size: number;
  /** null renders the initials fallback. */
  src: string | null;
  /** 256 w and 512 w candidates for src (the portrait). */
  srcSet?: string;
  /** The displayed width, so the browser picks the smallest candidate that is sharp enough. */
  sizes?: string;
  /** Said on hover and as the image's description, not part of the alt text. */
  title?: string;
  onError?: () => void;
  imgRef?: Ref<HTMLImageElement>;
  /** Load only when it nears the screen (for portraits below the first screen). */
  lazy?: boolean;
  className?: string;
};

// Presentational half, exported so the fallback and the img wiring can be tested without a DOM.
// Fixed width and height on both branches: no layout shift when the fallback swaps in.
export function DoctorAvatarView({
  name,
  size,
  src,
  srcSet,
  sizes,
  title,
  onError,
  imgRef,
  lazy,
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
      ref={imgRef}
      src={src}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt={name}
      title={title}
      width={size}
      height={size}
      decoding="async"
      loading={lazy ? "lazy" : undefined}
      onError={onError}
      className={cn(base, "object-cover", className)}
    />
  );
}

// What failed to load, so the chain is portrait, then the illustration, then the initials. The
// doctor id is kept with it, so a different doctor starts again from the portrait.
type Failure = { id: string; level: "photo" | "svg" };

export function DoctorAvatar({
  doctorId,
  name,
  size = 40,
  lazy,
  className,
}: {
  doctorId: string;
  name: string;
  size?: number;
  lazy?: boolean;
  className?: string;
}) {
  const photo = doctorPhoto(doctorId);
  const svg = doctorAvatarSrc(doctorId);
  const [failure, setFailure] = useState<Failure | null>(null);
  const failed = failure?.id === doctorId ? failure.level : null;
  const showPhoto = photo !== null && failed === null;
  const showSvg = svg !== null && failed !== "svg" && !showPhoto;
  const props = showPhoto
    ? {
        src: photo.src,
        srcSet: photo.srcSet,
        title: PORTRAIT_DISCLOSURE,
        onError: () => setFailure({ id: doctorId, level: "photo" }),
      }
    : showSvg
      ? {
          src: svg,
          title: ILLUSTRATION_DISCLOSURE,
          onError: () => setFailure({ id: doctorId, level: "svg" }),
        }
      : { src: null };
  // The server-rendered <img> may fail before React has attached onError (the event is not
  // replayed), so on mount and whenever the source changes, an image that has already failed moves
  // the chain on. A failed image is complete with no width.
  const imgRef = useRef<HTMLImageElement>(null);
  const onError = "onError" in props ? props.onError : undefined;
  const current = props.src;
  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth === 0) onError?.();
    // onError is a fresh closure each render; the source is what identifies the attempt.
  }, [current]);
  return (
    <DoctorAvatarView
      name={name}
      size={size}
      className={className}
      imgRef={imgRef}
      lazy={lazy}
      sizes={`${size}px`}
      {...props}
    />
  );
}
