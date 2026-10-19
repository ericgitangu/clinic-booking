import { expect, type Locator, type Page } from "@playwright/test";
import { hhmm } from "../api";

// A time on the doctor's grid, found the way a person finds it: by its text. A free time is a link
// named "09:00 free, book this time"; every other time is plain text with the reason beside it and
// no link.
export const REASONS =
  /Booked|Just taken|Your visit|You have another visit|No longer available/;

export const chip = (page: Page, startsAt: string): Locator =>
  page
    .getByRole("listitem")
    .filter({ hasText: new RegExp(`^${hhmm(startsAt)}`) });

export const freeLink = (page: Page, startsAt: string): Locator =>
  page.getByRole("link", { name: new RegExp(`^${hhmm(startsAt)} free`) });

export async function expectFree(
  page: Page,
  startsAt: string,
  options?: { timeout?: number },
) {
  await expect(freeLink(page, startsAt)).toBeVisible(options);
}

// Inactive: shown with its reason, and not a link. `reason` narrows which reason.
export async function expectInactive(
  page: Page,
  startsAt: string,
  reason: RegExp | string = REASONS,
  options?: { timeout?: number },
) {
  await expect(chip(page, startsAt)).toContainText(reason, options);
  await expect(freeLink(page, startsAt)).toHaveCount(0, options);
}

// The ring a keyboard user sees: the design's own (2 px, offset 2 px, the --ring colour), not the
// browser default. The expected colour is resolved from the token by the browser itself.
export async function expectDesignedFocusRing(link: Locator) {
  const { style, width, offset, color, token } = await link.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--ring)";
    document.body.append(probe);
    const token = getComputedStyle(probe).color;
    probe.remove();
    const cs = getComputedStyle(el);
    return {
      style: cs.outlineStyle,
      width: cs.outlineWidth,
      offset: cs.outlineOffset,
      color: cs.outlineColor,
      token,
    };
  });
  expect(style).toBe("solid");
  expect(width).toBe("2px");
  expect(offset).toBe("2px");
  expect(color).toBe(token);
}

// Reaches an element the way a keyboard user does: by pressing Tab from the top of the page until it
// has focus (no programmatic focus), so :focus-visible applies exactly as it would for a person.
export async function tabTo(page: Page, target: Locator, max = 120) {
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) return;
  }
  throw new Error(`Tab did not reach the element in ${max} presses`);
}
