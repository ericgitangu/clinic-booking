// Shapes the shared footer renders; each app supplies its own columns.
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
    | "list"
    | "terminal";
};

export type FooterColumn = { title: string; links: readonly FooterLink[] };
