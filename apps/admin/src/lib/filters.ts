// Kept apart from the client components that use them: a server component cannot read a value
// exported from a "use client" module.
export const RANGES = [7, 14, 30] as const;
export const STATUSES = ["all", "booked", "cancelled"] as const;
export type StatusFilterValue = (typeof STATUSES)[number];
