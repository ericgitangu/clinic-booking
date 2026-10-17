import type { Severity } from "@/lib/problems";

export type NextSlot = { starts_at: string };

export type ActionState =
  | { status: "idle" }
  | {
      status: "error";
      code: string;
      message: string;
      severity: Severity;
      fieldErrors?: Record<string, string>;
      nextSlots?: NextSlot[];
      doctorId?: string;
    }
  | { status: "done"; message: string };

export const initialState: ActionState = { status: "idle" };
