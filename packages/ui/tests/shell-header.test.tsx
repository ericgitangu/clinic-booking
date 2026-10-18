// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

let path = "/book";
vi.mock("next/navigation", () => ({ usePathname: () => path }));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/image", () => ({
  default: (p: { alt: string }) => <img alt={p.alt} />,
}));
vi.mock("@clinic/ui/components/layout/theme-toggle", () => ({
  ThemeToggle: () => <button type="button">Display settings</button>,
}));

import { ShellHeader } from "@clinic/ui/components/app-shell/shell-header";
import { ShellTrail } from "@clinic/ui/components/app-shell/shell-trail";
import type { NavLink } from "@clinic/ui/lib/nav";
import type { ShellRoutes } from "@clinic/ui/lib/shell-trail";

const links: NavLink[] = [
  { href: "/book", label: "Book a visit", inline: true },
  { href: "/docs", label: "API docs" },
];

afterEach(cleanup);

describe("ShellHeader", () => {
  it("marks the current section with aria-current=page, in the bar and the menu", () => {
    path = "/book/abc/details";
    render(<ShellHeader name="Clinic" links={links} />);
    const current = screen
      .getAllByRole("link", { name: "Book a visit", hidden: true })
      .filter((a) => a.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(2);
    expect(
      screen
        .getByRole("link", { name: "API docs", hidden: true })
        .hasAttribute("aria-current"),
    ).toBe(false);
  });

  it("opens the menu as a disclosure, closes it on Escape and gives focus back", () => {
    path = "/";
    render(<ShellHeader name="Clinic" links={links} />);
    const button = screen.getByRole("button", { name: "Open menu" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    const close = screen.getByRole("button", { name: "Close menu" });
    expect(close.getAttribute("aria-expanded")).toBe("true");
    screen.getByRole("link", { name: "API docs" }).focus();
    fireEvent.keyDown(screen.getByRole("link", { name: "API docs" }), {
      key: "Escape",
    });
    const again = screen.getByRole("button", { name: "Open menu" });
    expect(again.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(again);
  });

  it("closes the menu when the page changes", () => {
    path = "/";
    const { rerender } = render(<ShellHeader name="Clinic" links={links} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getByRole("button", { name: "Close menu" })).toBeTruthy();
    path = "/book";
    rerender(<ShellHeader name="Clinic" links={links} />);
    expect(screen.getByRole("button", { name: "Open menu" })).toBeTruthy();
  });

  it("is sticky and takes the notch inset", () => {
    render(<ShellHeader name="Clinic" links={links} />);
    const header = screen.getByRole("banner");
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("top-0");
    expect(header.className).toContain("safe-area-inset-top");
  });
});

describe("ShellTrail", () => {
  const routes: ShellRoutes = {
    fallbackParent: "/",
    unknownLabel: "Page not found",
    routes: [
      { pattern: "/", label: "Home" },
      { pattern: "/book", label: "Book a visit", parent: "/" },
    ],
  };
  it("renders nothing on a root page", () => {
    path = "/";
    const { container } = render(<ShellTrail config={routes} />);
    expect(container.innerHTML).toBe("");
  });
  it("links back with a real href and marks the current page", () => {
    path = "/book";
    render(<ShellTrail config={routes} />);
    const back = screen.getByRole("link", {
      name: "Back to Home",
      hidden: true,
    });
    expect(back.getAttribute("href")).toBe("/");
    expect(screen.getByText("Book a visit").getAttribute("aria-current")).toBe(
      "page",
    );
  });
});
