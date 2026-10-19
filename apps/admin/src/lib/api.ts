// The calls the admin screens make. Server-only: they run in server components and server actions.
// Each one goes through the generated SDK in @clinic/api, which checks the request and the response
// against the contract (see packages/api/src/call.ts). The /internal calls carry the signed
// assertion for `caller`; the two public reads (one appointment, free times) carry none.
import "server-only";
import { callApi, type Caller } from "@clinic/api/call";
import { memo, readKey } from "@/lib/render-cache";
import {
  cancelForPatientInternalAdminAppointmentsAppointmentIdCancelPatch,
  changeAccessRoleInternalAdminAccessEmailPatch,
  acceptInviteInternalAdminInvitesAcceptPost,
  cancellationReasonsInternalAdminOpsCancellationReasonsGet,
  createInviteInternalAdminInvitesPost,
  doctorRunningLateInternalAdminDoctorsDoctorIdRunningLatePost,
  listAuditInternalAdminAuditGet,
  listInvitesInternalAdminInvitesGet,
  remindNowInternalAdminAppointmentsAppointmentIdRemindPost,
  revokeInviteInternalAdminInvitesInviteIdDelete,
  createAppointmentInternalAdminAppointmentsPost,
  daySheetInternalAdminOpsDaySheetCsvGet,
  doctorAvailabilityDoctorsDoctorIdAvailabilityGet,
  gapsInternalAdminOpsGapsGet,
  heatmapInternalAdminOpsHeatmapGet,
  kpisInternalAdminOpsKpisGet,
  markArrivedInternalAdminAppointmentsAppointmentIdArrivedPost,
  markNoShowInternalAdminAppointmentsAppointmentIdNoShowPost,
  todayInternalAdminOpsTodayGet,
  unlockAppointmentInternalAdminAppointmentsAppointmentIdUnlockPost,
  vetoAppointmentInternalAdminAppointmentsAppointmentIdVetoPost,
  listDoctorsDoctorsGet,
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
  memo(readKey("sessionInfo", caller, []), () =>
    callApi(
      "sessionInfo",
      (client) => getSessionInfoInternalAdminSessionGet({ client }),
      { caller },
    ),
  );

export const metrics = (caller: Caller, from: string, to: string) =>
  memo(readKey("metrics", caller, [from, to]), () =>
    callApi(
      "metrics",
      (client) =>
        getMetricsInternalAdminMetricsGet({
          client,
          query: { from, to, bucket: "day" },
        }),
      { caller },
    ),
  );

export interface AppointmentQuery {
  status?: "booked" | "cancelled" | "all";
  doctor_id?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string | null;
}

export const appointmentsPage = (caller: Caller, query: AppointmentQuery) =>
  memo(readKey("appointmentsPage", caller, [query]), () =>
    callApi(
      "appointments",
      (client) =>
        listAppointmentsInternalAdminAppointmentsGet({
          client,
          query: { ...query, cursor: query.cursor ?? undefined },
        }),
      { caller },
    ),
  );

export const lineage = (caller: Caller, id: string) =>
  memo(readKey("lineage", caller, [id]), () =>
    callApi(
      "lineage",
      (client) =>
        getLineageInternalAdminAppointmentsAppointmentIdLineageGet({
          client,
          path: { appointment_id: id },
        }),
      { caller },
    ),
  );

export const accessList = (caller: Caller) =>
  memo(readKey("accessList", caller, []), () =>
    callApi(
      "accessList",
      (client) => listAccessInternalAdminAccessGet({ client }),
      { caller },
    ),
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
  reason: string,
) =>
  callApi(
    "rescheduleForPatient",
    (client) =>
      rescheduleForPatientInternalAdminAppointmentsAppointmentIdReschedulePatch(
        {
          client,
          path: { appointment_id: id },
          body: { starts_at: startsAt, reason },
        },
      ),
    { caller },
  );

export const getAppointment = (id: string) =>
  memo(readKey("getAppointment", null, [id]), () =>
    callApi("getAppointment", (client) =>
      getAppointmentAppointmentsAppointmentIdGet({
        client,
        path: { appointment_id: id },
      }),
    ),
  );

export const availability = (doctorId: string, date: string) =>
  memo(readKey("availability", null, [doctorId, date]), () =>
    callApi("doctorAvailability", (client) =>
      doctorAvailabilityDoctorsDoctorIdAvailabilityGet({
        client,
        path: { doctor_id: doctorId },
        query: { date },
      }),
    ),
  );

export const doctors = () =>
  memo(readKey("doctors", null, []), () =>
    callApi("listDoctors", (client) => listDoctorsDoctorsGet({ client })),
  );

// Operations reads. Any staff role may read them; the API decides what a viewer sees (initials,
// masked phone), never this app.
export const opsToday = (caller: Caller, date?: string) =>
  memo(readKey("opsToday", caller, [date]), () =>
    callApi(
      "opsToday",
      (client) =>
        todayInternalAdminOpsTodayGet({ client, query: date ? { date } : {} }),
      { caller },
    ),
  );

export const opsKpis = (caller: Caller, from: string, to: string) =>
  memo(readKey("opsKpis", caller, [from, to]), () =>
    callApi(
      "opsKpis",
      (client) => kpisInternalAdminOpsKpisGet({ client, query: { from, to } }),
      { caller },
    ),
  );

export const opsReasons = (caller: Caller, from: string, to: string) =>
  memo(readKey("opsReasons", caller, [from, to]), () =>
    callApi(
      "opsReasons",
      (client) =>
        cancellationReasonsInternalAdminOpsCancellationReasonsGet({
          client,
          query: { from, to },
        }),
      { caller },
    ),
  );

export const opsHeatmap = (
  caller: Caller,
  from: string,
  to: string,
  doctorId?: string,
) =>
  memo(readKey("opsHeatmap", caller, [from, to, doctorId]), () =>
    callApi(
      "opsHeatmap",
      (client) =>
        heatmapInternalAdminOpsHeatmapGet({
          client,
          query: { from, to, ...(doctorId ? { doctor_id: doctorId } : {}) },
        }),
      { caller },
    ),
  );

export const opsGaps = (caller: Caller, hours = 48) =>
  memo(readKey("opsGaps", caller, [hours]), () =>
    callApi(
      "opsGaps",
      (client) => gapsInternalAdminOpsGapsGet({ client, query: { hours } }),
      { caller },
    ),
  );

export const opsDaySheet = (caller: Caller, date: string) =>
  callApi(
    "opsDaySheet",
    (client) =>
      daySheetInternalAdminOpsDaySheetCsvGet({ client, query: { date } }),
    { caller },
  );

export const markAttendance = (
  caller: Caller,
  id: string,
  kind: "arrived" | "no_show",
  reason?: string,
) =>
  callApi(
    "markAttendance",
    (client) =>
      kind === "arrived"
        ? markArrivedInternalAdminAppointmentsAppointmentIdArrivedPost({
            client,
            path: { appointment_id: id },
            body: reason ? { reason } : null,
          })
        : markNoShowInternalAdminAppointmentsAppointmentIdNoShowPost({
            client,
            path: { appointment_id: id },
            body: reason ? { reason } : null,
          }),
    { caller },
  );

export const staffBook = (
  caller: Caller,
  body: {
    doctor_id: string;
    starts_at: string;
    reason: string;
    patient: { full_name: string; phone?: string; email?: string };
  },
) =>
  callApi(
    "staffBook",
    (client) =>
      createAppointmentInternalAdminAppointmentsPost({ client, body }),
    { caller },
  );

export const vetoAppointment = (caller: Caller, id: string, reason: string) =>
  callApi(
    "veto",
    (client) =>
      vetoAppointmentInternalAdminAppointmentsAppointmentIdVetoPost({
        client,
        path: { appointment_id: id },
        body: { reason },
      }),
    { caller },
  );

export const unlockAppointment = (caller: Caller, id: string, reason: string) =>
  callApi(
    "unlock",
    (client) =>
      unlockAppointmentInternalAdminAppointmentsAppointmentIdUnlockPost({
        client,
        path: { appointment_id: id },
        body: { reason },
      }),
    { caller },
  );

export const remindNow = (caller: Caller, id: string, reason?: string) =>
  callApi(
    "remindNow",
    (client) =>
      remindNowInternalAdminAppointmentsAppointmentIdRemindPost({
        client,
        path: { appointment_id: id },
        body: reason ? { reason } : null,
      }),
    { caller },
  );

export const runningLate = (
  caller: Caller,
  doctorId: string,
  minutes: number,
  reason?: string,
) =>
  callApi(
    "runningLate",
    (client) =>
      doctorRunningLateInternalAdminDoctorsDoctorIdRunningLatePost({
        client,
        path: { doctor_id: doctorId },
        body: { minutes, ...(reason ? { reason } : {}) },
      }),
    { caller },
  );

export const invitesList = (caller: Caller) =>
  memo(readKey("invitesList", caller, []), () =>
    callApi(
      "invitesList",
      (client) => listInvitesInternalAdminInvitesGet({ client }),
      { caller },
    ),
  );

export const inviteCreate = (
  caller: Caller,
  email: string,
  role: "admin" | "viewer",
) =>
  callApi(
    "inviteCreate",
    (client) =>
      createInviteInternalAdminInvitesPost({ client, body: { email, role } }),
    { caller },
  );

export const inviteRevoke = (caller: Caller, id: string) =>
  callApi(
    "inviteRevoke",
    (client) =>
      revokeInviteInternalAdminInvitesInviteIdDelete({
        client,
        path: { invite_id: id },
      }),
    { caller },
  );

export const inviteAccept = (caller: Caller, token: string) =>
  callApi(
    "inviteAccept",
    (client) =>
      acceptInviteInternalAdminInvitesAcceptPost({ client, body: { token } }),
    { caller },
  );

export const auditList = (
  caller: Caller,
  query: { limit?: number; cursor?: string | null; appointment_id?: string },
) =>
  memo(readKey("auditList", caller, [query]), () =>
    callApi(
      "auditList",
      (client) =>
        listAuditInternalAdminAuditGet({
          client,
          query: { ...query, cursor: query.cursor ?? undefined },
        }),
      { caller },
    ),
  );
