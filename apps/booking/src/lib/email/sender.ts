// Who the emails come from. One place, so the address and the domain cannot drift apart. The address,
// domain and reply-to are shared with the admin app (packages/api/src/mail.ts); the display name is
// this app's own.
import {
  FROM_ADDRESS,
  MAIL_DOMAIN,
  REPLY_TO,
} from "@clinic/api/mail-constants";

export { FROM_ADDRESS, MAIL_DOMAIN, REPLY_TO };
// Idyllic Clinic <reminders@mail.ericgitangu.com>
export const FROM = `Idyllic Clinic <${FROM_ADDRESS}>`;
