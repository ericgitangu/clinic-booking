import type { FooterColumn } from "@clinic/ui/lib/footer";
import { SITE } from "@/lib/site";

const GITHUB = "https://github.com/ericgitangu/clinic-booking";

export const FOOTER_COLUMNS: readonly FooterColumn[] = [
  {
    title: "Idyllic Clinic Admin",
    links: [
      {
        label: "Patient site",
        href: SITE.bookingUrl,
        external: true,
        icon: "calendar",
      },
      {
        label: "Privacy",
        href: `${SITE.bookingUrl}/privacy`,
        external: true,
        icon: "scale",
      },
      {
        label: "Terms",
        href: `${SITE.bookingUrl}/terms`,
        external: true,
        icon: "scale",
      },
    ],
  },
  {
    title: "Staff",
    links: [
      {
        label: "Dashboard",
        href: "/dashboard",
        external: false,
        icon: "calendar",
      },
    ],
  },
  {
    title: "Assessment",
    links: [
      { label: "Source on GitHub", href: GITHUB, external: true, icon: "git" },
      {
        label: "README",
        href: `${GITHUB}#readme`,
        external: true,
        icon: "docs",
      },
      {
        label: "CI/CD pipelines",
        href: "https://app.circleci.com/pipelines/github/ericgitangu/clinic-booking",
        external: true,
        icon: "workflow",
      },
    ],
  },
  {
    title: "Built by Eric Gitangu",
    links: [
      {
        label: "Portfolio",
        href: "https://developer.ericgitangu.com",
        external: true,
        icon: "globe",
      },
      {
        label: "Blog",
        href: "https://developer.ericgitangu.com/blog",
        external: true,
        icon: "pen",
      },
      {
        label: "Résumé",
        href: "https://resume.ericgitangu.com",
        external: true,
        icon: "file-user",
      },
      {
        label: "GitHub",
        href: "https://github.com/ericgitangu",
        external: true,
        icon: "git",
      },
      {
        label: "LinkedIn",
        href: "https://linkedin.com/in/ericgitangu",
        external: true,
        icon: "briefcase",
      },
    ],
  },
];
