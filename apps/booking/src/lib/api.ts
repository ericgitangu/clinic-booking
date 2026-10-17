// The calls the booking screens make, typed. Server-only: they run in server components and
// server actions.
import { callApi } from "@clinic/api/call";
import {
  AppointmentSchema,
  AvailabilitySchema,
  DoctorListSchema,
  DoctorSchema,
  PatientAppointmentsSchema,
  PatientSchema,
} from "@clinic/api/schemas";

export const listDoctors = () =>
  callApi("/doctors", { schema: DoctorListSchema, revalidate: 300 });

export const getDoctor = (id: string) =>
  callApi(`/doctors/${encodeURIComponent(id)}`, {
    schema: DoctorSchema,
    revalidate: 300,
  });

export const getAvailability = (doctorId: string, day: string) =>
  callApi(`/doctors/${encodeURIComponent(doctorId)}/availability?date=${day}`, {
    schema: AvailabilitySchema,
  });

export const createPatient = (body: {
  full_name: string;
  phone?: string | null;
  email?: string | null;
}) => callApi("/patients", { method: "POST", body, schema: PatientSchema });

export const createAppointment = (body: {
  doctor_id: string;
  patient_id: string;
  starts_at: string;
}) =>
  callApi("/appointments", { method: "POST", body, schema: AppointmentSchema });

export const getAppointment = (id: string) =>
  callApi(`/appointments/${encodeURIComponent(id)}`, {
    schema: AppointmentSchema,
  });

export const listPatientAppointments = (patientId: string) =>
  callApi(`/patients/${encodeURIComponent(patientId)}/appointments`, {
    schema: PatientAppointmentsSchema,
  });

export const cancelAppointment = (id: string, reason: string) =>
  callApi(`/appointments/${encodeURIComponent(id)}/cancel`, {
    method: "PATCH",
    body: { reason },
    schema: AppointmentSchema,
  });

export const rescheduleAppointment = (id: string, startsAt: string) =>
  callApi(`/appointments/${encodeURIComponent(id)}/reschedule`, {
    method: "PATCH",
    body: { starts_at: startsAt },
    schema: AppointmentSchema,
  });
