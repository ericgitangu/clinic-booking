// Every link the footer shows, in one place so the sitemap and the link-check test read the same list.
export type FooterLink = {
  label: string;
  href: string;
  // Path on this site (checked for 200) or a full URL on another one.
  external: boolean;
  icon:
    | "calendar"
    | "shield"
    | "docs"
    | "code"
    | "git"
    | "workflow"
    | "briefcase"
    | "pen"
    | "file-user"
    | "globe"
    | "scale"
    | "database"
    | "list";
};

export type FooterColumn = { title: string; links: readonly FooterLink[] };

const GITHUB = "https://github.com/ericgitangu/clinic-booking";

export const FOOTER_COLUMNS: readonly FooterColumn[] = [
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
        label: "Data & privacy",
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
