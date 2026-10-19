"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CopyIcon, MailPlusIcon } from "lucide-react";
import { Badge } from "@clinic/ui/components/ui/badge";
import { Button } from "@clinic/ui/components/ui/button";
import { Input } from "@clinic/ui/components/ui/input";
import { Label } from "@clinic/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@clinic/ui/components/ui/select";
import { notify } from "@clinic/ui/lib/notify";
import { createInvite, revokeInvite } from "@/lib/actions";
import { formatSlot } from "@/lib/clinic-time";
import { ROLE_HELP, ROLE_LABEL, type GrantableRole } from "@/lib/roles";
import type { Invite } from "@clinic/api/generated";

const STATUS_LABEL: Record<Invite["status"], string> = {
  open: "Waiting",
  expired: "Expired",
  consumed: "Accepted",
  revoked: "Revoked",
};

// Invite someone by email. They sign in with that Google account and accept within 72 hours; the
// link is in the email and is shown here once, because the API keeps only a hash of it.
export function InvitesPanel({ invites }: { invites: readonly Invite[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<GrantableRole>("viewer");
  const [link, setLink] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const res = await createInvite(email, role);
      if (res.ok) {
        notify.success(res.message);
        setLink(res.link);
        setEmail("");
        router.refresh();
      } else {
        notify.error(res.message);
      }
    });
  }

  function revoke(id: string) {
    start(async () => {
      const res = await revokeInvite(id);
      if (res.ok) {
        notify.success(res.message);
        router.refresh();
      } else {
        notify.error(res.message);
      }
    });
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      notify.success("Link copied.");
    } catch {
      notify.error("Copy did not work. Select the link and copy it.");
    }
  }

  return (
    <section aria-labelledby="invites" className="space-y-4">
      <h2
        id="invites"
        className="font-heading text-xl font-semibold tracking-tight"
      >
        Invitations
      </h2>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="invite-email">Email to invite</Label>
          <Input
            id="invite-email"
            type="email"
            autoComplete="off"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-h-11"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invite-role">Role</Label>
          <Select
            value={role}
            onValueChange={(v) => setRole(v as GrantableRole)}
          >
            <SelectTrigger id="invite-role" className="min-h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["viewer", "admin"] as const).map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABEL[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" className="min-h-11" disabled={pending || !email}>
          <MailPlusIcon aria-hidden /> Send invitation
        </Button>
      </form>
      <p className="max-w-[60ch] text-sm text-muted-foreground">
        {ROLE_HELP[role]} The invitation lasts 72 hours and works only for a
        Google account with this exact email.
      </p>
      {link && (
        <div
          className="space-y-2 rounded-xl border border-border bg-card p-4"
          data-testid="invite-link-box"
        >
          <p className="text-sm font-medium">
            Invitation link, shown once. Send it only to them.
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={link}
              aria-label="Invitation link"
              className="min-h-11 font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={copy}
            >
              <CopyIcon aria-hidden /> Copy
            </Button>
          </div>
        </div>
      )}
      {invites.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-muted-foreground">
          No invitations yet. Invite a colleague and they appear here.
        </p>
      ) : (
        <ul
          className="divide-y divide-border rounded-xl border border-border bg-card/80"
          data-testid="invite-list"
        >
          {invites.map((i) => (
            <li
              key={i.id}
              className="flex flex-wrap items-center gap-3 px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block break-words font-medium">{i.email}</span>
                <span className="block text-sm text-muted-foreground">
                  {ROLE_LABEL[i.role]}, invited by {i.invited_by}
                  {i.status === "open"
                    ? `, expires ${formatSlot(i.expires_at)}`
                    : ""}
                </span>
              </span>
              <Badge variant={i.status === "open" ? "secondary" : "outline"}>
                {STATUS_LABEL[i.status]}
              </Badge>
              {i.status === "open" && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 text-destructive"
                  disabled={pending}
                  onClick={() => revoke(i.id)}
                  aria-label={`Revoke the invitation for ${i.email}`}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
