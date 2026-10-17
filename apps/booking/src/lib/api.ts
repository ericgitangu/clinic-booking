// The calls the booking screens make. Server-only: they run in server components and server
// actions. Each one goes through the generated SDK in @clinic/api, which checks the request and the
// response against the contract (see call.ts).
import { callApi } from "@clinic/api/call";
import {
  cancelAppointmentAppointmentsAppointmentIdCancelPatch,
  createAppointmentAppointmentsPost,
  doctorAvailabilityDoctorsDoctorIdAvailabilityGet,
  getAppointmentAppointmentsAppointmentIdGet,
  getDoctorDoctorsDoctorIdGet,
  listDoctorsDoctorsGet,
  patientAppointmentsPatientsPatientIdAppointmentsGet,
  postPatientPatientsPost,
  readyReadyGet,
  rescheduleAppointmentAppointmentsAppointmentIdReschedulePatch,
  type AppointmentCreate,
  type PatientCreate,
} from "@clinic/api/generated";

export const listDoctors = () =>
  callApi("listDoctors", (client) => listDoctorsDoctorsGet({ client }), {
    revalidate: 300,
  });

export const getDoctor = (id: string) =>
  callApi(
    "getDoctor",
    (client) =>
      getDoctorDoctorsDoctorIdGet({ client, path: { doctor_id: id } }),
    {
      revalidate: 300,
    },
  );

export const getAvailability = (doctorId: string, day: string) =>
  callApi("doctorAvailability", (client) =>
    doctorAvailabilityDoctorsDoctorIdAvailabilityGet({
      client,
      path: { doctor_id: doctorId },
      query: { date: day },
    }),
  );

export const createPatient = (body: PatientCreate) =>
  callApi("postPatient", (client) => postPatientPatientsPost({ client, body }));

export const createAppointment = (body: AppointmentCreate) =>
  callApi("createAppointment", (client) =>
    createAppointmentAppointmentsPost({ client, body }),
  );

export const getAppointment = (id: string) =>
  callApi("getAppointment", (client) =>
    getAppointmentAppointmentsAppointmentIdGet({
      client,
      path: { appointment_id: id },
    }),
  );

export const listPatientAppointments = (patientId: string) =>
  callApi("patientAppointments", (client) =>
    patientAppointmentsPatientsPatientIdAppointmentsGet({
      client,
      path: { patient_id: patientId },
    }),
  );

export const cancelAppointment = (id: string, reason: string) =>
  callApi("cancelAppointment", (client) =>
    cancelAppointmentAppointmentsAppointmentIdCancelPatch({
      client,
      path: { appointment_id: id },
      body: { reason },
    }),
  );

export const rescheduleAppointment = (id: string, startsAt: string) =>
  callApi("rescheduleAppointment", (client) =>
    rescheduleAppointmentAppointmentsAppointmentIdReschedulePatch({
      client,
      path: { appointment_id: id },
      body: { starts_at: startsAt },
    }),
  );

export const ready = () =>
  callApi("ready", (client) => readyReadyGet({ client }), {
    revalidate: 30,
    timeoutMs: 5000,
  });
