"use client";

import Image from "next/image";
import { useState } from "react";
import { cn } from "@clinic/ui/lib/utils";

// Up to two capital letters: the first letters of the first and last word of the name.
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0])[0] ?? "";
  const last =
    words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? "") : "";
  return (first + last).toLocaleUpperCase();
}

// With image optimisation off, remotePatterns is not enforced, so the host is checked here: only an
// https address on exactly lh3.googleusercontent.com (no other host, scheme, port or credentials) is
// loaded; anything else shows the initials.
export function isGoogleAvatar(image: string): boolean {
  try {
    const u = new URL(image);
    return (
      u.protocol === "https:" &&
      u.hostname === "lh3.googleusercontent.com" &&
      u.port === "" &&
      u.username === "" &&
      u.password === ""
    );
  } catch {
    return false;
  }
}

// The person's Google profile picture, round. With no picture, or when it fails to load (offline,
// blocked, removed), their initials in the same circle. The picture is a plain remote file: image
// optimisation is off in both apps (it bills), and Google's host wants no referrer.
export function ProfileAvatar({
  name,
  image,
  size = 32,
  className,
}: {
  name: string;
  image?: string | null;
  size?: number;
  className?: string;
}) {
  // Remember which address failed, so a new picture gets its own chance.
  const [failed, setFailed] = useState<string | null>(null);
  const box = { width: size, height: size };
  if (image && isGoogleAvatar(image) && failed !== image) {
    return (
      <Image
        src={image}
        alt={`${name}'s profile picture`}
        {...box}
        unoptimized
        referrerPolicy="no-referrer"
        onError={() => setFailed(image)}
        className={cn("shrink-0 rounded-full object-cover", className)}
      />
    );
  }
  // The initials are drawn by CSS from data-initials, not written as text. A button's name comes
  // from its aria-label ("Account menu for Pat Mwangi"); visible text that its name does not
  // contain (the initials) fails WCAG 2.5.3 Label in Name, and axe reads real text nodes.
  return (
    <span
      aria-hidden
      data-initials={initialsOf(name)}
      style={box}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground before:content-[attr(data-initials)]",
        className,
      )}
    />
  );
}
