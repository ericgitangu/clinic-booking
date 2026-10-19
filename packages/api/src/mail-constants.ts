// The constants of the sender address, with no imports, so code that is not a server module (a
// Playwright spec, a client component) can use them. The sending itself is in ./mail.ts, which is
// server-only because it holds the Resend key.
//
// Email is sent from the verified subdomain, not the root domain: Resend only sends from a domain
// verified in its dashboard (mail.ericgitangu.com is the verified one), and keeping mail on a
// subdomain protects the root domain's reputation.
export const MAIL_DOMAIN = "mail.ericgitangu.com";
export const FROM_ADDRESS = `reminders@${MAIL_DOMAIN}`;
// Replies go to the engineer's own address.
export const REPLY_TO = "developer.ericgitangu@gmail.com";
