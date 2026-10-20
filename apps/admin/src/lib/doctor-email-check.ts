// The check on the doctor's email field, in words a person can act on. The API checks again (and
// normalises); this only saves a round trip and says what is wrong.
const SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Null when the text is a usable address; otherwise what to fix. An empty field is not a problem
 *  here (the Save button waits for something to save). */
export function emailProblem(text: string): string | null {
  const value = text.trim();
  if (value === "") return null;
  if (!value.includes("@"))
    return "Add the part after the @, like name@clinic.org.";
  if (/\s/.test(value)) return "Remove the spaces in the address.";
  if ((value.match(/@/g) ?? []).length > 1)
    return "Use one address with a single @.";
  if (value.length > 254) return "This address is too long.";
  if (!SHAPE.test(value)) return "Enter an address like name@clinic.org.";
  return null;
}
