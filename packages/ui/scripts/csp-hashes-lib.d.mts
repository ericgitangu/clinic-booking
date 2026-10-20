export function inlineScriptHashes(html: string): string[];
export function fillTokens(
  headers: { headers: { key: string; value: string }[] }[],
  hashesOf: (page: string) => string[],
): number;
