import type { FooterColumn } from "@clinic/ui/lib/footer";

// Every link the footer shows, in one place so the sitemap and the link-check test read the same list.
// Off until the admin app is deployed and its domain is attached; the link would fail TLS before then.
export const ADMIN_APP_LIVE = false;

const GITHUB = "https://github.com/ericgitangu/clinic-booking";

const ALL_COLUMNS: readonly FooterColumn[] = [
  {
    title: "Clinic",
    links: [
      {
        label: "Book an appointment",
        href: "/",
        external: false,
        icon: "calendar",
      },
      {
        label: "Admin",
        href: "https://clinic-admin.ericgitangu.com",
        external: true,
        icon: "shield",
      },
      { label: "API docs", href: "/docs", external: false, icon: "docs" },
      { label: "ReDoc", href: "/redoc", external: false, icon: "docs" },
      {
        label: "OpenAPI",
        href: "/openapi.json",
        external: false,
        icon: "code",
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
        label: "Architecture decisions",
        href: `${GITHUB}/tree/main/docs/adr`,
        external: true,
        icon: "list",
      },
      {
        label: "CI/CD pipelines",
        href: "https://app.circleci.com/pipelines/github/ericgitangu/clinic-booking",
        external: true,
        icon: "workflow",
      },
      {
        label: "Business case",
        href: "/about",
        external: false,
        icon: "briefcase",
      },
      {
        label: "Data handling",
        href: "/data",
        external: false,
        icon: "database",
      },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "/privacy", external: false, icon: "scale" },
      { label: "Terms", href: "/terms", external: false, icon: "scale" },
      {
        label: "Data handling",
        href: "/data",
        external: false,
        icon: "database",
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

export const FOOTER_COLUMNS: readonly FooterColumn[] = ALL_COLUMNS.map(
  (col) => ({
    ...col,
    links: col.links.filter((l) => ADMIN_APP_LIVE || l.label !== "Admin"),
  }),
);
