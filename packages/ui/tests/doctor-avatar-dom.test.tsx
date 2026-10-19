// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DoctorAvatar } from "../src/components/doctor-avatar";

const ID = "e52e9da0-f7f3-5a6a-93d3-d7f658947afa";
const NAME = "Dr. Achieng Otieno";
const PORTRAIT = `${NAME}, AI-generated portrait of a fictional doctor`;
const ILLUSTRATION = `${NAME}, illustration of a fictional doctor`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DoctorAvatar (stateful)", () => {
  it("shows the portrait, then the illustration, then the initials as each fails", () => {
    render(<DoctorAvatar doctorId={ID} name={NAME} size={48} />);
    const photo = screen.getByRole("img", { name: PORTRAIT });
    expect(photo.tagName).toBe("IMG");
    expect(photo.getAttribute("src")).toBe(`/doctors/${ID}-256.webp`);
    expect(photo.getAttribute("srcset")).toBe(
      `/doctors/${ID}-128.webp 128w, /doctors/${ID}-256.webp 256w, /doctors/${ID}-512.webp 512w`,
    );
    expect(photo.getAttribute("title")).toBe(
      "AI-generated portraits of fictional doctors",
    );
    expect(photo.getAttribute("width")).toBe("48");

    fireEvent.error(photo);

    const svg = screen.getByRole("img", { name: ILLUSTRATION });
    expect(svg.tagName).toBe("IMG");
    expect(svg.getAttribute("src")).toBe(`/doctors/${ID}.svg`);
    expect(svg.getAttribute("srcset")).toBeNull();
    expect(svg.getAttribute("title")).toBe(
      "Illustration of a fictional doctor",
    );

    fireEvent.error(svg);

    const fallback = screen.getByRole("img", { name: NAME });
    expect(fallback.tagName).toBe("SPAN");
    expect(fallback.textContent).toBe("AO");
    expect(document.querySelector("img")).toBeNull();
  });

  it("gives a different doctor a fresh attempt after an earlier failure", () => {
    const { rerender } = render(<DoctorAvatar doctorId={ID} name={NAME} />);
    fireEvent.error(screen.getByRole("img", { name: PORTRAIT }));
    rerender(
      <DoctorAvatar
        doctorId="412e6793-68f2-5c62-832d-cb7839acae9d"
        name="Dr. Brian Kamau"
      />,
    );
    const next = screen.getByRole("img", {
      name: "Dr. Brian Kamau, AI-generated portrait of a fictional doctor",
    });
    expect(next.tagName).toBe("IMG");
    expect(next.getAttribute("src")).toBe(
      "/doctors/412e6793-68f2-5c62-832d-cb7839acae9d-256.webp",
    );
  });

  it("has an explicit size on the image and on the initials fallback, so nothing shifts", () => {
    const { rerender } = render(
      <DoctorAvatar doctorId={ID} name={NAME} size={56} />,
    );
    const img = screen.getByRole("img", { name: PORTRAIT });
    expect(img.getAttribute("width")).toBe("56");
    expect(img.getAttribute("height")).toBe("56");

    rerender(
      <DoctorAvatar doctorId="unknown" name="Dr. Zed Quinn" size={40} />,
    );
    const fallback = screen.getByRole("img", { name: "Dr. Zed Quinn" });
    expect(fallback.tagName).toBe("SPAN");
    expect(fallback.textContent).toBe("ZQ");
    expect(fallback).toHaveProperty("style.width", "40px");
    expect(fallback).toHaveProperty("style.height", "40px");
    expect(document.querySelector("img")).toBeNull();
  });

  it("says in the alt text that the portrait is AI-generated and fictional, and keeps the disclosure as the description", () => {
    render(<DoctorAvatar doctorId={ID} name={NAME} />);
    const img = screen.getByRole("img", { name: PORTRAIT });
    expect(img.getAttribute("alt")).toBe(PORTRAIT);
    expect(img.getAttribute("title")).toMatch(
      /AI-generated portraits of fictional doctors/,
    );
  });
});

describe("DoctorAvatar priority", () => {
  it("fetches a priority portrait ahead of the others, and only that one", () => {
    const { container, rerender } = render(
      <DoctorAvatar doctorId={ID} name={NAME} priority lazy={false} />,
    );
    const img = container.querySelector("img")!;
    expect(img.getAttribute("fetchpriority")).toBe("high");
    expect(img.getAttribute("loading")).toBeNull();
    rerender(<DoctorAvatar doctorId={ID} name={NAME} />);
    expect(
      container.querySelector("img")!.getAttribute("fetchpriority"),
    ).toBeNull();
  });
});

describe("DoctorAvatar defer", () => {
  it("asks for no image until it scrolls into view", () => {
    let fire: (e: { isIntersecting: boolean }[]) => void = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: typeof fire) {
          fire = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<DoctorAvatar doctorId={ID} name={NAME} defer />);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("img", { name: NAME }).textContent).toBe("AO");

    act(() => fire([{ isIntersecting: false }]));
    expect(document.querySelector("img")).toBeNull();

    act(() => fire([{ isIntersecting: true }]));
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      `/doctors/${ID}-256.webp`,
    );
  });

  it("shows the portrait at once where there is no IntersectionObserver", () => {
    render(<DoctorAvatar doctorId={ID} name={NAME} defer />);
    expect(document.querySelector("img")).not.toBeNull();
  });
});
