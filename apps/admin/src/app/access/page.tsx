import type { Metadata } from "next";
import { AccessManager } from "@/components/access-manager";
import { accessList, invitesList, passesList } from "@/lib/api";
import { callerFor, requireStaff } from "@/lib/session";

export const metadata: Metadata = { title: "Access" };
export const dynamic = "force-dynamic";

// Owner and admin. A viewer, or anyone without a role, gets the 403 page whatever the link was. An
// admin sees the whole list but can act only on viewers; the API enforces it again.
export default async function AccessPage() {
  const staff = await requireStaff("manage-access");
  const caller = callerFor(staff, staff.role);
  // Passes are the owner's alone; the API refuses anyone else.
  const [res, inv, pas] = await Promise.all([
    accessList(caller),
    invitesList(caller),
    staff.role === "owner" ? passesList(caller) : null,
  ]);
  if (!res.ok)
    throw new Error(`access list failed (${res.status} ${res.code})`);
  if (!inv.ok)
    throw new Error(`invites list failed (${inv.status} ${inv.code})`);
  if (pas && !pas.ok)
    throw new Error(`passes list failed (${pas.status} ${pas.code})`);
  return (
    <div className="py-6">
      <AccessManager
        entries={res.data.items}
        invites={inv.data.items}
        passes={pas ? pas.data.items : null}
        actor={staff.role === "owner" ? "owner" : "admin"}
      />
    </div>
  );
}
