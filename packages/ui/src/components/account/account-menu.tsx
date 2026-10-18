"use client";

import { LogOutIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ProfileAvatar } from "@clinic/ui/components/account/profile-avatar";
import { Button } from "@clinic/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@clinic/ui/components/ui/dropdown-menu";

// Who is signed in, as their picture; one tap opens who they are, where to go and Sign out. The
// trigger is a 44px button named for the person, so a screen reader hears whose menu it is.
export function AccountMenu({
  name,
  email,
  image,
  links = [],
  children,
  onSignOut,
}: {
  name: string;
  email: string;
  image?: string | null;
  links?: readonly { href: string; label: string }[];
  /** Extra facts under the name, e.g. the staff role. */
  children?: ReactNode;
  onSignOut: () => void | Promise<void>;
}) {
  return (
    // Not modal: a small menu should not hide the rest of the page from assistive technology (axe
    // reports every focusable thing outside a modal menu as aria-hidden-focus).
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 rounded-full"
          aria-label={`Account menu for ${name}`}
        >
          <ProfileAvatar name={name} image={image} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
          <span className="truncate text-sm font-semibold text-foreground">
            {name}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {email}
          </span>
          {children}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {links.map((l) => (
          <DropdownMenuItem key={l.href} asChild className="min-h-11">
            <Link href={l.href}>{l.label}</Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem
          className="min-h-11"
          onSelect={() => void onSignOut()}
        >
          <LogOutIcon aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
