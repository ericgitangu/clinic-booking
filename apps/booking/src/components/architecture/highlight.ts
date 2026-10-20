// A small tokenizer for the code blocks on /architecture. It runs on the server while the page is
// built, so the browser gets finished spans and no script. It knows only what the page's blocks
// use: shell, JSON and SQL. Anything else is shown as plain text.

export type Token = {
  kind: "plain" | "comment" | "string" | "flag" | "key" | "keyword";
  text: string;
};

type Rule = { kind: Token["kind"]; re: RegExp };

const SHELL: Rule[] = [
  { kind: "comment", re: /^#[^\n]*/ },
  { kind: "string", re: /^"(?:[^"\\]|\\.)*"|^'[^']*'/ },
  { kind: "flag", re: /^--?[A-Za-z][\w-]*/ },
  { kind: "key", re: /^\$\{?[A-Za-z_]\w*\}?/ },
];

const JSON_RULES: Rule[] = [
  { kind: "key", re: /^"(?:[^"\\]|\\.)*"(?=\s*:)/ },
  { kind: "string", re: /^"(?:[^"\\]|\\.)*"/ },
  { kind: "keyword", re: /^(?:true|false|null)\b/ },
];

const SQL_RULES: Rule[] = [
  { kind: "comment", re: /^--[^\n]*/ },
  { kind: "string", re: /^'(?:[^']|'')*'/ },
  {
    kind: "keyword",
    re: /^(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|ON|TO|AND|OR|NOT|NULL|AS|WITH|ROLE|TABLE|INDEX|UNIQUE|USING|ORDER|BY|LIMIT|JOIN|LEFT|COUNT)\b/i,
  },
];

const RULES: Record<string, Rule[] | undefined> = {
  bash: SHELL,
  json: JSON_RULES,
  sql: SQL_RULES,
};

export function highlight(lang: string, code: string): Token[] {
  const rules = RULES[lang];
  if (!rules) return [{ kind: "plain", text: code }];
  const out: Token[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ kind: "plain", text: plain });
    plain = "";
  };
  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    let hit: { kind: Token["kind"]; text: string } | null = null;
    // A shell word can only start a flag or a comment at a word boundary.
    const atBoundary = i === 0 || /[\s(;|&=]/.test(code[i - 1]!);
    if (atBoundary || lang !== "bash") {
      for (const r of rules) {
        const m = r.re.exec(rest);
        if (m) {
          hit = { kind: r.kind, text: m[0] };
          break;
        }
      }
    }
    if (hit) {
      flush();
      out.push(hit);
      i += hit.text.length;
    } else {
      plain += code[i];
      i += 1;
    }
  }
  flush();
  return out;
}
