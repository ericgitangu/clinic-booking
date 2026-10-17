// The calls the admin screens make. Server-only: they run in server components and server actions.
// Each one goes through the generated SDK in @clinic/api, which checks the request and the response
// against the contract (see packages/api/src/call.ts). The /internal calls carry the signed
// assertion for `caller`; the two public reads (one appointment, free times) carry none.
import "server-only";
import { callApi, type Caller } from "@clinic/api/call";
import {
  cancelForPatientInternalAdminAppointmentsAppointmentIdCancelPatch,
  changeAccessRoleInternalAdminAccessEmailPatch,
  doctorAvailabilityDoctorsDoctorIdAvailabilityGet,
  getAppointmentAppointmentsAppointmentIdGet,
  getLineageInternalAdminAppointmentsAppointmentIdLineageGet,
  getMetricsInternalAdminMetricsGet,
  getSessionInfoInternalAdminSessionGet,
  grantAccessInternalAdminAccessPost,
  listAccessInternalAdminAccessGet,
  listAppointmentsInternalAdminAppointmentsGet,
  rescheduleForPatientInternalAdminAppointmentsAppointmentIdReschedulePatch,
  revokeAccessInternalAdminAccessEmailDelete,
} from "@clinic/api/generated";

export type { Caller } from "@clinic/api/call";

export const sessionInfo = (caller: Caller) =>
  callApi(
    "sessionInfo",
    (client) => getSessionInfoInternalAdminSessionGet({ client }),
    { caller },
  );

export const metrics = (caller: Caller, from: string, to: string) =>
  callApi(
    "metrics",
    (client) =>
      getMetricsInternalAdminMetricsGet({
        client,
        query: { from, to, bucket: "day" },
      }),
    { caller },
  );

export interface AppointmentQuery {
  status?: "booked" | "cancelled" | "all";
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string | null;
}

export const appointmentsPage = (caller: Caller, query: AppointmentQuery) =>
  callApi(
    "appointments",
    (client) =>
      listAppointmentsInternalAdminAppointmentsGet({
        client,
        query: { ...query, cursor: query.cursor ?? undefined },
      }),
    { caller },
  );

export const lineage = (caller: Caller, id: string) =>
  callApi(
    "lineage",
    (client) =>
      getLineageInternalAdminAppointmentsAppointmentIdLineageGet({
        client,
        path: { appointment_id: id },
      }),
    { caller },
  );

export const accessList = (caller: Caller) =>
  callApi(
    "accessList",
    (client) => listAccessInternalAdminAccessGet({ client }),
    { caller },
  );

export const grantAccess = (
  caller: Caller,
  email: string,
  role: "admin" | "viewer",
) =>
  callApi(
    "grantAccess",
    (client) =>
      grantAccessInternalAdminAccessPost({ client, body: { email, role } }),
    { caller },
  );

export const changeAccessRole = (
  caller: Caller,
  email: string,
  role: "admin" | "viewer",
) =>
  callApi(
    "changeAccessRole",
    (client) =>
      changeAccessRoleInternalAdminAccessEmailPatch({
        client,
        path: { email },
        body: { role },
      }),
    { caller },
  );

export const revokeAccess = (caller: Caller, email: string) =>
  callApi(
    "revokeAccess",
    (client) =>
      revokeAccessInternalAdminAccessEmailDelete({ client, path: { email } }),
    { caller },
  );

export const cancelForPatient = (caller: Caller, id: string, reason: string) =>
  callApi(
    "cancelForPatient",
    (client) =>
      cancelForPatientInternalAdminAppointmentsAppointmentIdCancelPatch({
        client,
        path: { appointment_id: id },
        body: { reason },
      }),
    { caller },
  );

export const rescheduleForPatient = (
  caller: Caller,
  id: string,
  startsAt: string,
) =>
  callApi(
    "rescheduleForPatient",
    (client) =>
      rescheduleForPatientInternalAdminAppointmentsAppointmentIdReschedulePatch(
        {
          client,
          path: { appointment_id: id },
          body: { starts_at: startsAt },
        },
      ),
    { caller },
  );

export const getAppointment = (id: string) =>
  callApi("getAppointment", (client) =>
    getAppointmentAppointmentsAppointmentIdGet({
      client,
      path: { appointment_id: id },
    }),
  );

export const availability = (doctorId: string, date: string) =>
  callApi("doctorAvailability", (client) =>
    doctorAvailabilityDoctorsDoctorIdAvailabilityGet({
      client,
      path: { doctor_id: doctorId },
      query: { date },
    }),
  );
