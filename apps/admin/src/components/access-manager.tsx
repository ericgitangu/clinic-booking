"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { PencilIcon, UserMinusIcon, UserPlusIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@clinic/ui/components/ui/alert-dialog";
import { Badge } from "@clinic/ui/components/ui/badge";
import { Button } from "@clinic/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@clinic/ui/components/ui/dialog";
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
import { notify } from "@clinic/ui/lib/notify";
import {
  changeAccessRole,
  grantAccess,
  revokeAccess,
  type ActionResult,
} from "@/lib/actions";
import { InvitesPanel } from "@/components/invites-panel";
import { formatSlot } from "@/lib/clinic-time";
import { ROLE_HELP, ROLE_LABEL, type GrantableRole } from "@/lib/roles";
import type { AccessEntry, Invite } from "@clinic/api/generated";

const GRANTABLE: readonly GrantableRole[] = ["admin", "viewer"];

type Dialogue =
  | { kind: "none" }
  | { kind: "add" }
  | { kind: "role"; entry: AccessEntry }
  | { kind: "revoke"; entry: AccessEntry };

// Only the owner reaches this page, and every action is checked again on the server and in the
// API, so what is hidden here is a convenience and never the protection.
export function AccessManager({
  entries,
  invites,
  actor,
}: {
  entries: AccessEntry[];
  invites: Invite[];
  /** Who is looking. An admin can invite, and change or revoke viewers; the owner can do it all. */
  actor: "owner" | "admin";
}) {
  const router = useRouter();
  const [dialogue, setDialogue] = useState<Dialogue>({ kind: "none" });
  const [pending, start] = useTransition();
  const close = () => setDialogue({ kind: "none" });

  function run(task: () => Promise<ActionResult>) {
    start(async () => {
      const res = await task();
      if (res.ok) {
        notify.success(res.message);
        close();
        router.refresh();
      } else {
        notify.error(res.message);
      }
    });
  }

  const active = entries.filter((e) => e.revoked_at === null);
  const revoked = entries.filter((e) => e.revoked_at !== null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          Access
        </h1>
        {actor === "owner" && (
          <Button
            className="min-h-11"
            onClick={() => setDialogue({ kind: "add" })}
          >
            <UserPlusIcon aria-hidden /> Add someone
          </Button>
        )}
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
                  <RowActions entry={e} actor={actor} onPick={setDialogue} />
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
            <RowActions entry={e} actor={actor} onPick={setDialogue} wide />
          </li>
        ))}
      </ul>

      <InvitesPanel invites={invites} />

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

      <AddDialog
        open={dialogue.kind === "add"}
        pending={pending}
        onClose={close}
        onSubmit={(email, role) => run(() => grantAccess(email, role))}
      />
      <RoleDialog
        entry={dialogue.kind === "role" ? dialogue.entry : null}
        pending={pending}
        onClose={close}
        onSubmit={(email, role) => run(() => changeAccessRole(email, role))}
      />
      <AlertDialog
        open={dialogue.kind === "revoke"}
        onOpenChange={(o) => !o && close()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke access?</AlertDialogTitle>
            <AlertDialogDescription>
              {dialogue.kind === "revoke"
                ? `${dialogue.entry.email} will see an access-denied page on their next click. You can add them again later.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">
              Keep access
            </AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11"
              disabled={pending}
              onClick={(ev) => {
                ev.preventDefault();
                if (dialogue.kind === "revoke") {
                  const email = dialogue.entry.email;
                  run(() => revokeAccess(email));
                }
              }}
            >
              Revoke access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RowActions({
  entry,
  actor,
  onPick,
  wide = false,
}: {
  entry: AccessEntry;
  actor: "owner" | "admin";
  onPick: (d: Dialogue) => void;
  wide?: boolean;
}) {
  // The owner is fixed by configuration: nothing to change or revoke. An admin may act on viewers
  // only; the API answers ROLE_ESCALATION for anything else, so hiding it is a convenience.
  if (entry.source === "env") return null;
  if (actor === "admin" && entry.role !== "viewer") return null;
  return (
    <div className={wide ? "grid grid-cols-2 gap-2" : "flex justify-end gap-2"}>
      {actor === "owner" && (
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => onPick({ kind: "role", entry })}
          aria-label={`Change role of ${entry.email}`}
        >
          <PencilIcon aria-hidden /> Change role
        </Button>
      )}
      <Button
        variant="outline"
        className="min-h-11 text-destructive"
        onClick={() => onPick({ kind: "revoke", entry })}
        aria-label={`Revoke access of ${entry.email}`}
      >
        <UserMinusIcon aria-hidden /> Revoke
      </Button>
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

function AddDialog({
  open,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (email: string, role: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add someone</DialogTitle>
          <DialogDescription>
            They sign in with that Google address and get the role you pick.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(email, role);
          }}
        >
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
          <DialogFooter>
            <Button type="submit" className="min-h-11" disabled={pending}>
              {pending ? "Adding" : "Add access"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RoleDialog({
  entry,
  pending,
  onClose,
  onSubmit,
}: {
  entry: AccessEntry | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: (email: string, role: string) => void;
}) {
  const [role, setRole] = useState<string | null>(null);
  const value = role ?? entry?.role ?? "viewer";
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(o) => {
        if (!o) {
          setRole(null);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change role</DialogTitle>
          <DialogDescription>{entry?.email}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="change-role">Role</Label>
          <RoleSelect id="change-role" value={value} onChange={setRole} />
        </div>
        <DialogFooter>
          <Button
            className="min-h-11"
            disabled={pending || !entry || value === entry.role}
            onClick={() => entry && onSubmit(entry.email, value)}
          >
            {pending ? "Saving" : "Save role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
