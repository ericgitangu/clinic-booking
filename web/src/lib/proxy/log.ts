// One structured line per failure, to stderr so Vercel's log drain picks it up. Fields are
// restricted to identifiers, statuses and short redacted messages; never a token or a header.
export function logError(
  message: string,
  fields: Record<string, string | number | undefined>,
): void {
  console.error(JSON.stringify({ severity: "ERROR", message, ...fields }));
}

// Error bodies from Google can echo input. Strip anything that looks like a JWT, cap the length.
export function redact(text: string): string {
  return text
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
      "[redacted-jwt]",
    )
    .replace(/\s+/g, " ")
    .slice(0, 240);
}
