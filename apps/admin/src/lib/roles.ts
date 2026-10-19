// What each staff role may do. The UI hides what a role cannot do, but every server action and
// page checks again, and the API checks the role in the signed assertion a third time.
export const ROLES = ["owner", "admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];
export type GrantableRole = Exclude<Role, "owner">;

export type Capability = "view" | "manage-appointments" | "manage-access";

// "manage-access" mirrors the API's CAN_MANAGE_ACCESS gate (owner and admin). What an admin may do
// to whom (viewers only, never the owner or another admin) is the API's rule, answered as
// ROLE_ESCALATION or OWNER_PROTECTED; the screens only hide what would be refused.
const GRANTS: Record<Role, readonly Capability[]> = {
  owner: ["view", "manage-appointments", "manage-access"],
  admin: ["view", "manage-appointments", "manage-access"],
  viewer: ["view"],
};

export function can(role: Role | null, capability: Capability): boolean {
  return role !== null && GRANTS[role].includes(capability);
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  viewer: "Viewer",
};

export const ROLE_HELP: Record<Role, string> = {
  owner: "Everything, and who has access.",
  admin: "The dashboard, and cancelling or rescheduling for patients.",
  viewer: "The dashboard, read only.",
};
