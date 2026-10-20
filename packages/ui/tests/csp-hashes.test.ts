import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fillTokens, inlineScriptHashes } from "../scripts/csp-hashes-lib.mjs";

const sha = (s: string) =>
  `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

describe("inlineScriptHashes", () => {
  it("hashes inline scripts and nothing else", () => {
    const html = `<html><head>
      <script src="/a.js" async></script>
      <script id="_R_">self.__next_f=[]</script>
      <script type="application/ld+json">{"a":1}</script>
      <script>self.__next_f.push([1,"x"])</script>
      <script type="module">import("/m.js")</script>
      <script></script></head></html>`;
    expect(inlineScriptHashes(html)).toEqual([
      sha("self.__next_f=[]"),
      sha('self.__next_f.push([1,"x"])'),
      sha('import("/m.js")'),
    ]);
  });
  it("counts a repeated script once", () => {
    const html = "<script>a()</script><script>a()</script>";
    expect(inlineScriptHashes(html)).toEqual([sha("a()")]);
  });
});

describe("fillTokens", () => {
  const headers = () => [
    {
      headers: [
        {
          key: "Content-Security-Policy",
          value: "script-src 'self' __INLINE_SCRIPT_HASHES:about__; x",
        },
      ],
    },
    { headers: [{ key: "Other", value: "none" }] },
  ];
  it("puts a page's hashes where its token was", () => {
    const h = headers();
    const n = fillTokens(h, (page: string) => [
      `'sha256-${page}'`,
      "'sha256-b'",
    ]);
    expect(n).toBe(1);
    expect(h[0].headers[0].value).toBe(
      "script-src 'self' 'sha256-about' 'sha256-b'; x",
    );
    expect(h[1].headers[0].value).toBe("none");
  });
  it("fills a page whose name starts with an underscore", () => {
    const h = [
      {
        headers: [
          {
            key: "Content-Security-Policy",
            value: "script-src __INLINE_SCRIPT_HASHES:_not-found__",
          },
        ],
      },
    ];
    fillTokens(h, (page: string) => [`'${page}'`]);
    expect(h[0].headers[0].value).toBe("script-src '_not-found'");
  });
  it("fails when a page has no inline script to hash", () => {
    expect(() => fillTokens(headers(), () => [])).toThrow(/no inline script/);
  });
});
