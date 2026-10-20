import type { ShellRoutes } from "@clinic/ui/lib/shell-trail";

// Every page of the staff app and where "back" goes from it. "/" is the sign-in gate and
// "/dashboard" is home for someone signed in, so neither has a way back; a path that does not exist
// goes back to the dashboard, which sends the signed-out to the gate.
export const SHELL_ROUTES: ShellRoutes = {
  fallbackParent: "/dashboard",
  unknownLabel: "Page not found",
  routes: [
    { pattern: "/", label: "Sign in", backLabel: "sign in" },
    { pattern: "/dashboard", label: "Dashboard", backLabel: "dashboard" },
    { pattern: "/access", label: "Access", parent: "/dashboard" },
    { pattern: "/audit", label: "Audit", parent: "/dashboard" },
    { pattern: "/dashboard/print", label: "Print view", parent: "/dashboard" },
    { pattern: "/invite/:token", label: "Invitation", parent: "/" },
    {
      pattern: "/dashboard/appointments/:id",
      label: "Appointment history",
      parent: "/dashboard",
    },
  ],
};

// What the header offers someone who is not signed in: the one place they can go. "/" is the
// sign-in gate, and "/dashboard" would only send them back to it.
export const SIGNED_OUT_NAV = [
  { href: "/", label: "Sign in", inline: true },
] as const;
