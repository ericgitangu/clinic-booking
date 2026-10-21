// Screenshots of the running apps. Only images that match the UI on main are listed. Each one is a
// light and a dark file with its real size, so the page reserves the space before it loads.
export type Screenshot = {
  id: string;
  title: string;
  light: string;
  dark: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
  taken: string;
};

export const SCREENSHOTS: readonly Screenshot[] = [
  {
    id: "staff-dashboard",
    title: "Staff dashboard",
    light: "/screenshots/staff-dashboard-light.webp",
    dark: "/screenshots/staff-dashboard-dark.webp",
    width: 1280,
    height: 1576,
    alt: "The staff dashboard for the owner role. Today's visits are listed per doctor with their times, patient names, status (arrived, no-show, cancelled, booked) and actions to mark, reschedule and cancel, and one doctor's arrival email set. Under them sit the live feed of bookings and staff actions, with a count of new events, and four figures: visits today, upcoming booked, cancelled visits and fill rate.",
    caption:
      "The admin app's dashboard as the owner sees it, at 1280 px wide. It shows today's visits per doctor, the live feed and the fill rate.",
    taken: "2026-10-21",
  },
];
