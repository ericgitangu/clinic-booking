// Who the emails come from. One place, so the address and the domain cannot drift apart.
//
// Email is sent from the verified subdomain, not the root domain: Resend only sends from a domain
// verified in its dashboard (mail.ericgitangu.com is the verified one), and keeping mail on a
// subdomain protects the root domain's reputation.
export const MAIL_DOMAIN = "mail.ericgitangu.com";
export const FROM_ADDRESS = `reminders@${MAIL_DOMAIN}`;
// Idyllic Clinic <reminders@mail.ericgitangu.com>
export const FROM = `Idyllic Clinic <${FROM_ADDRESS}>`;
// Replies go to the engineer's own address.
export const REPLY_TO = "developer.ericgitangu@gmail.com";
