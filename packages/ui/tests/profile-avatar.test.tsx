import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProfileAvatar,
  initialsOf,
  isGoogleAvatar,
} from "@clinic/ui/components/account/profile-avatar";

const URL_ = "https://lh3.googleusercontent.com/a/abc=s96-c";

describe("initialsOf", () => {
  it.each([
    ["Pat Mwangi", "PM"],
    ["pat mwangi", "PM"],
    ["Wanjiru", "W"],
    ["Mary Anne Otieno", "MO"],
    ["  Eric   Gitangu ", "EG"],
    ["Émile Zola", "ÉZ"],
    ["", "?"],
    ["   ", "?"],
  ])("%j gives %j", (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });
});

describe("ProfileAvatar", () => {
  it("renders the remote picture, 32px, with the person's name in the alt text", () => {
    const html = renderToStaticMarkup(
      <ProfileAvatar name="Pat Mwangi" image={URL_} />,
    );
    expect(html).toContain("<img");
    expect(html).toContain(`src="${URL_}"`);
    expect(html).toContain('alt="Pat Mwangi&#x27;s profile picture"');
    expect(html).toContain('width="32"');
    expect(html).toContain('height="32"');
    expect(html).toContain("rounded-full");
    expect(html).toMatch(/referrer-?policy="no-referrer"/i);
  });

  it.each([null, undefined, ""])(
    "shows initials, not an image, for %j",
    (image) => {
      const html = renderToStaticMarkup(
        <ProfileAvatar name="Pat Mwangi" image={image} />,
      );
      expect(html).not.toContain("<img");
      // Drawn by CSS from data-initials: no text node for a screen reader or axe to read.
      expect(html).toContain('data-initials="PM"');
      expect(html).not.toContain(">PM<");
      expect(html).toContain('aria-hidden="true"');
    },
  );
});

describe("isGoogleAvatar", () => {
  it("accepts only https on exactly lh3.googleusercontent.com", () => {
    expect(isGoogleAvatar(URL_)).toBe(true);
    for (const bad of [
      "http://lh3.googleusercontent.com/a/abc",
      "https://lh3.googleusercontent.com.evil.example/a",
      "https://evil.example/lh3.googleusercontent.com",
      "https://user@lh3.googleusercontent.com/a",
      "https://lh3.googleusercontent.com:8443/a",
      "https://lh4.googleusercontent.com/a",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "not a url",
    ])
      expect(isGoogleAvatar(bad), bad).toBe(false);
  });

  it("shows initials for an image on another host", () => {
    const html = renderToStaticMarkup(
      <ProfileAvatar name="Pat Mwangi" image="https://evil.example/a.png" />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain('data-initials="PM"');
  });
});
