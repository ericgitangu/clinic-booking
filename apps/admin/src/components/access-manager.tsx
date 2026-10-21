"use client";

import { useState } from "react";
import { PencilIcon, UserMinusIcon, UserPlusIcon } from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@clinic/ui/components/ui/table";
import { changeAccessRole, grantAccess, revokeAccess } from "@/lib/actions";
import { ConfirmAction } from "@/components/confirm-action";
import { InvitesPanel } from "@/components/invites-panel";
import { PassesPanel } from "@/components/passes-panel";
import { formatSlot } from "@/lib/clinic-time";
import { ROLE_HELP, ROLE_LABEL, type GrantableRole } from "@/lib/roles";
import type { AccessEntry, Invite, Pass } from "@clinic/api/generated";

const GRANTABLE: readonly GrantableRole[] = ["admin", "viewer"];

// Only the owner reaches this page, and every action is checked again on the server and in the
// API, so what is hidden here is a convenience and never the protection.
export function AccessManager({
  entries,
  invites,
  passes,
  actor,
}: {
  entries: AccessEntry[];
  invites: Invite[];
  /** The owner's passes; null for an admin, who does not see or make them. */
  passes: Pass[] | null;
  /** Who is looking. An admin can invite, and change or revoke viewers; the owner can do it all. */
  actor: "owner" | "admin";
}) {
  const active = entries.filter((e) => e.revoked_at === null);
  const revoked = entries.filter((e) => e.revoked_at !== null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Access
        </h1>
        {actor === "owner" && <AddSomeone />}
      </div>
      <p className="max-w-[60ch] text-muted-foreground">
        Only people listed here can open the dashboard. A change applies on
        their next click.
      </p>

      <div className="hidden md:block">
        <Table data-testid="access-table">
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Added by</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {active.map((e) => (
              <TableRow key={e.email}>
                <TableCell>{e.email}</TableCell>
                <TableCell>
                  <Badge variant={e.role === "owner" ? "default" : "secondary"}>
                    {ROLE_LABEL[e.role]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {e.source === "env"
                    ? "Fixed by configuration"
                    : `${e.granted_by}${e.granted_at ? `, ${formatSlot(e.granted_at)}` : ""}`}
                </TableCell>
                <TableCell className="text-right">
                  <RowActions entry={e} actor={actor} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className="space-y-3 md:hidden" data-testid="access-cards">
        {active.map((e) => (
          <li
            key={e.email}
            className="space-y-3 rounded-xl border border-border bg-card p-4"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 break-words font-medium">{e.email}</p>
              <Badge variant={e.role === "owner" ? "default" : "secondary"}>
                {ROLE_LABEL[e.role]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {e.source === "env"
                ? "Fixed by configuration"
                : `Added by ${e.granted_by}`}
            </p>
            <RowActions entry={e} actor={actor} wide />
          </li>
        ))}
      </ul>

      <InvitesPanel invites={invites} />
      {passes !== null && <PassesPanel passes={passes} />}

      {revoked.length > 0 && (
        <section aria-labelledby="revoked" className="space-y-2">
          <h2 id="revoked" className="font-heading text-lg font-semibold">
            Revoked
          </h2>
          <ul className="space-y-1 text-muted-foreground">
            {revoked.map((e) => (
              <li key={e.email}>
                {e.email}, was {ROLE_LABEL[e.role].toLowerCase()}
                {e.revoked_at ? `, revoked ${formatSlot(e.revoked_at)}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RowActions({
  entry,
  actor,
  wide = false,
}: {
  entry: AccessEntry;
  actor: "owner" | "admin";
  wide?: boolean;
}) {
  // The owner is fixed by configuration: nothing to change or revoke. An admin may act on viewers
  // only; the API answers ROLE_ESCALATION for anything else, so hiding it is a convenience.
  if (entry.source === "env") return null;
  if (actor === "admin" && entry.role !== "viewer") return null;
  return (
    <div className={wide ? "grid grid-cols-2 gap-2" : "flex justify-end gap-2"}>
      {actor === "owner" && <ChangeRole entry={entry} />}
      <ConfirmAction
        trigger={
          <Button
            variant="outline"
            className="min-h-11 text-destructive"
            aria-label={`Revoke access of ${entry.email}`}
          >
            <UserMinusIcon aria-hidden /> Revoke
          </Button>
        }
        title="Revoke access?"
        description={`${entry.email} will see an access-denied page on their next click. You can add them again later.`}
        confirmLabel="Revoke access"
        withReason={false}
        run={() => revokeAccess(entry.email)}
      />
    </div>
  );
}

function RoleSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="min-h-11 w-full">
        <SelectValue placeholder="Pick a role" />
      </SelectTrigger>
      <SelectContent>
        {GRANTABLE.map((r) => (
          <SelectItem key={r} value={r}>
            {ROLE_LABEL[r]}: {ROLE_HELP[r]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Giving someone access straight away. Like every action it opens the one confirmation dialog; the
// API takes no reason for this one, so that field is left out.
function AddSomeone() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  return (
    <ConfirmAction
      trigger={
        <Button className="min-h-11">
          <UserPlusIcon aria-hidden /> Add someone
        </Button>
      }
      title="Add someone"
      description="They sign in with that Google address and get the role you pick."
      confirmLabel="Add access"
      withReason={false}
      extraReady={/.+@.+\..+/.test(email.trim())}
      run={() => grantAccess(email, role)}
      onDone={() => setEmail("")}
      extra={
        <>
          <div className="space-y-2">
            <Label htmlFor="add-email">Google email</Label>
            <Input
              id="add-email"
              type="email"
              autoComplete="off"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="min-h-11"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="add-role">Role</Label>
            <RoleSelect id="add-role" value={role} onChange={setRole} />
          </div>
        </>
      }
    />
  );
}

function ChangeRole({ entry }: { entry: AccessEntry }) {
  const [role, setRole] = useState<string | null>(null);
  const value = role ?? entry.role;
  return (
    <ConfirmAction
      trigger={
        <Button
          variant="outline"
          className="min-h-11"
          aria-label={`Change role of ${entry.email}`}
        >
          <PencilIcon aria-hidden /> Change role
        </Button>
      }
      title="Change role"
      description={entry.email}
      confirmLabel="Save role"
      withReason={false}
      extraReady={value !== entry.role}
      run={() => changeAccessRole(entry.email, value)}
      onDone={() => setRole(null)}
      extra={
        <div className="space-y-2">
          <Label htmlFor="change-role">Role</Label>
          <RoleSelect id="change-role" value={value} onChange={setRole} />
        </div>
      }
    />
  );
}
