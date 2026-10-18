import type { Metadata } from "next";
import { AccessManager } from "@/components/access-manager";
import { StaffBar } from "@/components/staff-bar";
import { accessList } from "@/lib/api";
import { callerFor, requireStaff } from "@/lib/session";

export const metadata: Metadata = { title: "Access" };
export const dynamic = "force-dynamic";

// Owner only. A signed-in person without the capability gets the 403 page, whatever the link was.
export default async function AccessPage() {
  const staff = await requireStaff("manage-access");
  const res = await accessList(callerFor(staff, staff.role));
  if (!res.ok)
    throw new Error(`access list failed (${res.status} ${res.code})`);
  return (
    <>
      <StaffBar
        name={staff.name}
        email={staff.email}
        image={staff.image}
        role={staff.role}
      />
      <div className="py-6">
        <AccessManager entries={res.data.items} />
      </div>
    </>
  );
}
