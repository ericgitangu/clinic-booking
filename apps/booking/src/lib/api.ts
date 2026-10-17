// The calls the booking screens make. Server-only: they run in server components and server
// actions. Each one goes through the generated SDK in @clinic/api, which checks the request and the
// response against the contract (see call.ts). What belongs to a patient goes through the
// /internal/me endpoints with the signed assertion for the signed-in person: the API decides which
// patient that is, never the browser. Doctors, free times and the readiness check are public.
import "server-only";
import { callApi, type Caller } from "@clinic/api/call";
import {
  bookMineInternalMeAppointmentsPost,
  cancelMineInternalMeAppointmentsAppointmentIdCancelPatch,
  doctorAvailabilityDoctorsDoctorIdAvailabilityGet,
  getDoctorDoctorsDoctorIdGet,
  linkAccountInternalAccountsLinkPost,
  listDoctorsDoctorsGet,
  myAppointmentInternalMeAppointmentsAppointmentIdGet,
  myAppointmentsInternalMeAppointmentsGet,
  readyReadyGet,
  rescheduleMineInternalMeAppointmentsAppointmentIdReschedulePatch,
  type MeAppointmentCreate,
} from "@clinic/api/generated";

export type { Caller } from "@clinic/api/call";

export const listDoctors = () =>
  callApi("listDoctors", (client) => listDoctorsDoctorsGet({ client }), {
    revalidate: 300,
  });

export const getDoctor = (id: string) =>
  callApi(
    "getDoctor",
    (client) =>
      getDoctorDoctorsDoctorIdGet({ client, path: { doctor_id: id } }),
    { revalidate: 300 },
  );

export const getAvailability = (doctorId: string, day: string) =>
  callApi("doctorAvailability", (client) =>
    doctorAvailabilityDoctorsDoctorIdAvailabilityGet({
      client,
      path: { doctor_id: doctorId },
      query: { date: day },
    }),
  );

export const ready = () =>
  callApi("ready", (client) => readyReadyGet({ client }), {
    revalidate: 30,
    timeoutMs: 5000,
  });

// Idempotent: the first call for a sign-in makes the patient, later calls return the same one.
export const linkAccount = (caller: Caller, fullName: string) =>
  callApi(
    "linkAccount",
    (client) =>
      linkAccountInternalAccountsLinkPost({
        client,
        body: { full_name: fullName },
      }),
    { caller },
  );

export const myAppointments = (caller: Caller) =>
  callApi(
    "myAppointments",
    (client) => myAppointmentsInternalMeAppointmentsGet({ client }),
    { caller },
  );

export const myAppointment = (caller: Caller, id: string) =>
  callApi(
    "myAppointment",
    (client) =>
      myAppointmentInternalMeAppointmentsAppointmentIdGet({
        client,
        path: { appointment_id: id },
      }),
    { caller },
  );

export const bookMine = (caller: Caller, body: MeAppointmentCreate) =>
  callApi(
    "bookMine",
    (client) => bookMineInternalMeAppointmentsPost({ client, body }),
    { caller },
  );

export const cancelMine = (caller: Caller, id: string, reason: string) =>
  callApi(
    "cancelMine",
    (client) =>
      cancelMineInternalMeAppointmentsAppointmentIdCancelPatch({
        client,
        path: { appointment_id: id },
        body: { reason },
      }),
    { caller },
  );

export const rescheduleMine = (caller: Caller, id: string, startsAt: string) =>
  callApi(
    "rescheduleMine",
    (client) =>
      rescheduleMineInternalMeAppointmentsAppointmentIdReschedulePatch({
        client,
        path: { appointment_id: id },
        body: { starts_at: startsAt },
      }),
    { caller },
  );
