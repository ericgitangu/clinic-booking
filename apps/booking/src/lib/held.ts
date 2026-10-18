// Words for a patient who tries to book a time they already hold.
export function heldMessage(h: {
  sameDoctor: boolean;
  when: string;
  doctor: string;
}): string {
  const who = h.sameDoctor ? h.doctor : `another doctor (${h.doctor})`;
  return `You already have a visit with ${who} at ${h.when}. Pick another time, or look in My appointments.`;
}
