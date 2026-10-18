import type { Page } from "@playwright/test";
import { hhmm } from "../api";

// A time on the doctor's grid. A free one holds a real link to its details page; every other state
// is plain text with no link (data-state says which).
export const chip = (page: Page, startsAt: string) =>
  page.locator(`li[data-time="${hhmm(startsAt)}"]`);

export const FREE = "free";
export const INACTIVE = /^(booked|just-taken|yours|yours-elsewhere|gone)$/;
