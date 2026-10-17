// Response and request shapes of the clinic API, written against contracts/openapi.json.
// tests/contract.test.ts compares every field name and every required field with the contract,
// so a change to the API that these schemas do not follow fails a test.
import { z } from "zod";

const nullable = <T extends z.ZodType>(t: T) => t.nullable();

export const ClinicSchema = z.object({
  id: z.string(),
  name: z.string(),
  timezone: z.string(),
});

export const WorkingWindowSchema = z.object({
  weekday: z.number(),
  start_time: z.string(),
  end_time: z.string(),
});

export const DoctorSchema = z.object({
  id: z.string(),
  full_name: z.string(),
  specialty: z.string(),
  clinic: ClinicSchema,
  working_hours: z.array(WorkingWindowSchema),
});
export const DoctorListSchema = z.object({ items: z.array(DoctorSchema) });

export const SlotSchema = z.object({
  starts_at: z.string(),
  ends_at: z.string(),
});
export const AvailabilitySchema = z.object({
  doctor_id: z.string(),
  date: z.string(),
  timezone: z.string(),
  slot_minutes: z.number().optional(),
  slots: z.array(SlotSchema),
});

export const PatientSchema = z.object({
  id: z.string(),
  full_name: z.string(),
  phone: nullable(z.string()),
  email: nullable(z.string()),
  created_at: z.string(),
});

export const AppointmentStatus = z.enum(["booked", "cancelled"]);

export const AppointmentSchema = z.object({
  id: z.string(),
  doctor_id: z.string(),
  patient_id: z.string(),
  starts_at: z.string(),
  ends_at: z.string(),
  status: AppointmentStatus,
  cancellation_reason: nullable(z.string()),
  cancelled_at: nullable(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});

export const DoctorRefSchema = z.object({
  id: z.string(),
  full_name: z.string(),
  specialty: z.string(),
});

export const AppointmentWithDoctorSchema = AppointmentSchema.extend({
  doctor: DoctorRefSchema,
});
export const PatientAppointmentsSchema = z.object({
  items: z.array(AppointmentWithDoctorSchema),
  next_cursor: z.null().optional(),
});

export type Doctor = z.infer<typeof DoctorSchema>;
export type Slot = z.infer<typeof SlotSchema>;
export type Availability = z.infer<typeof AvailabilitySchema>;
export type Patient = z.infer<typeof PatientSchema>;
export type Appointment = z.infer<typeof AppointmentSchema>;
export type AppointmentWithDoctor = z.infer<typeof AppointmentWithDoctorSchema>;

// The problem codes the booking screens handle by name. Anything else is treated as a generic
// failure; the full list is in the contract.
export const PROBLEM_CODES = [
  "VALIDATION_ERROR",
  "TIMEZONE_REQUIRED",
  "UNKNOWN_DOCTOR",
  "UNKNOWN_PATIENT",
  "SLOT_IN_PAST",
  "BOOKING_TOO_SOON",
  "DATE_OUT_OF_RANGE",
  "SLOT_MISALIGNED",
  "OUTSIDE_WORKING_HOURS",
  "SLOT_TAKEN",
  "PATIENT_DOUBLE_BOOKED",
  "APPOINTMENT_ALREADY_CANCELLED",
  "APPOINTMENT_ALREADY_STARTED",
  "PATIENT_PHONE_EXISTS",
  "CONCURRENT_UPDATE",
  "DOCTOR_NOT_FOUND",
  "PATIENT_NOT_FOUND",
  "APPOINTMENT_NOT_FOUND",
  "NOT_FOUND",
  "DB_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];
