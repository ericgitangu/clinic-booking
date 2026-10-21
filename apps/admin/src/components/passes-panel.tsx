"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CopyIcon, TicketPlusIcon } from "lucide-react";
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
import { ConfirmAction } from "@/components/confirm-action";
import { createPass, revokePass } from "@/lib/actions";
import { formatSlot } from "@/lib/clinic-time";
import { ROLE_HELP, ROLE_LABEL, type GrantableRole } from "@/lib/roles";
import type { Pass } from "@clinic/api/generated";

const STATUS_LABEL: Record<Pass["status"], string> = {
  active: "Active",
  expired: "Expired",
  used_up: "Used up",
  revoked: "Revoked",
};

// Only the owner sees this. A pass is a link any verified Google account can accept for a role,
// until it expires or the people it allows have joined. The link is shown here once, because the API
// keeps only a hash of it.
export function PassesPanel({ passes }: { passes: readonly Pass[] }) {
  const router = useRouter();
  const [role, setRole] = useState<GrantableRole>("admin");
  const [people, setPeople] = useState("5");
  const [days, setDays] = useState("14");
  const [link, setLink] = useState<{ url: string; people: number } | null>(
    null,
  );
  const [pending, start] = useTransition();

  const n = Number(people);
  const d = Number(days);
  const valid =
    Number.isInteger(n) &&
    n >= 1 &&
    n <= 10 &&
    Number.isInteger(d) &&
    d >= 1 &&
    d <= 30;

  function submit() {
    start(async () => {
      const res = await createPass(role, n, d);
      if (res.ok) {
        notify.success(res.message);
        setLink({ url: res.link, people: n });
        router.refresh();
      } else {
        notify.error(res.message);
      }
    });
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      notify.success("Link copied.");
    } catch {
      notify.error("Copy did not work. Select the link and copy it.");
    }
  }

  return (
    <section aria-labelledby="passes" className="space-y-4">
      <h2
        id="passes"
        className="font-heading text-xl font-semibold tracking-tight"
      >
        Reviewer passes
      </h2>
      <form
        className="grid gap-3 sm:grid-cols-[12rem_8rem_8rem_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="pass-role">Pass role</Label>
          <Select
            value={role}
            onValueChange={(v) => setRole(v as GrantableRole)}
          >
            <SelectTrigger id="pass-role" className="min-h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["admin", "viewer"] as const).map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABEL[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pass-people">People (1 to 10)</Label>
          <Input
            id="pass-people"
            type="number"
            inputMode="numeric"
            min={1}
            max={10}
            required
            value={people}
            onChange={(e) => setPeople(e.target.value)}
            className="min-h-11"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="pass-days">Days (1 to 30)</Label>
          <Input
            id="pass-days"
            type="number"
            inputMode="numeric"
            min={1}
            max={30}
            required
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="min-h-11"
          />
        </div>
        <Button type="submit" className="min-h-11" disabled={pending || !valid}>
          <TicketPlusIcon aria-hidden /> Make a pass
        </Button>
      </form>
      <p className="max-w-[60ch] text-sm text-muted-foreground">
        {ROLE_HELP[role]} A pass is for the people reviewing this: one link,
        with no email to type. At most 5 passes a day.
      </p>
      {link && (
        <div
          className="space-y-2 rounded-xl border border-border bg-card p-4"
          data-testid="pass-link-box"
        >
          <p className="text-sm font-medium">
            Pass link, shown once. Send it only to the people it is for.
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={link.url}
              aria-label="Pass link"
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
          <p className="text-sm text-muted-foreground">
            Anyone with this link can sign in with any Google account and get
            this role, until it expires or {link.people}{" "}
            {link.people === 1 ? "person has" : "people have"} used it. Revoking
            the pass stops new sign-ins; it does not remove people who already
            joined.
          </p>
        </div>
      )}
      {passes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-muted-foreground">
          No passes yet. Make one and it appears here.
        </p>
      ) : (
        <ul
          className="divide-y divide-border rounded-xl border border-border bg-card/80"
          data-testid="pass-list"
        >
          {passes.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center gap-3 px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {ROLE_LABEL[p.role]} pass, {p.used} of {p.max_uses} used
                </span>
                <span className="block text-sm text-muted-foreground">
                  Made {formatSlot(p.created_at)}
                  {p.status === "active"
                    ? `, expires ${formatSlot(p.expires_at)}`
                    : ""}
                </span>
                {p.uses.length > 0 && (
                  <span className="block break-words text-sm text-muted-foreground">
                    Used by{" "}
                    {p.uses
                      .map((u) => `${u.email} (${formatSlot(u.used_at)})`)
                      .join(", ")}
                  </span>
                )}
              </span>
              <Badge variant={p.status === "active" ? "secondary" : "outline"}>
                {STATUS_LABEL[p.status]}
              </Badge>
              {p.revoked_at === null && p.status !== "expired" && (
                <ConfirmAction
                  trigger={
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 text-destructive"
                      aria-label={`Revoke the ${p.role} pass made ${formatSlot(p.created_at)}`}
                    >
                      Revoke
                    </Button>
                  }
                  title="Revoke this pass?"
                  description="The link stops working for anyone who has not used it. People who already joined keep their access until you revoke them on this page."
                  confirmLabel="Revoke pass"
                  withReason={false}
                  run={() => revokePass(p.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
