import type { ShellRoutes } from "@clinic/ui/lib/shell-trail";

// Every page of the patient app and where "back" goes from it. Labels are static on purpose: the
// trail must render with the page, before any doctor or appointment has been fetched.
export const SHELL_ROUTES: ShellRoutes = {
  fallbackParent: "/",
  unknownLabel: "Page not found",
  routes: [
    { pattern: "/", label: "Home" },
    { pattern: "/book", label: "Book a visit", parent: "/" },
    { pattern: "/book/:doctorId", label: "Choose a time", parent: "/book" },
    {
      pattern: "/book/:doctorId/details",
      label: "Your details",
      parent: "/book/:doctorId",
    },
    {
      pattern: "/book/confirmed/:id",
      label: "Booking confirmed",
      parent: "/appointments",
    },
    { pattern: "/appointments", label: "My appointments", parent: "/" },
    {
      pattern: "/appointments/:id/reschedule",
      label: "Reschedule",
      parent: "/appointments",
    },
    { pattern: "/about", label: "Business case", parent: "/" },
    { pattern: "/privacy", label: "Privacy", parent: "/" },
    { pattern: "/terms", label: "Terms", parent: "/" },
    { pattern: "/data", label: "Data handling", parent: "/" },
    { pattern: "/docs", label: "API docs", parent: "/" },
    { pattern: "/redoc", label: "ReDoc", parent: "/" },
    { pattern: "/decisions", label: "Decisions", parent: "/" },
  ],
};
