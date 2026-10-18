// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DoctorAvatar } from "../src/components/doctor-avatar";

const ID = "e52e9da0-f7f3-5a6a-93d3-d7f658947afa";
const NAME = "Dr. Achieng Otieno";

afterEach(cleanup);

describe("DoctorAvatar (stateful)", () => {
  it("shows the portrait, then the illustration, then the initials as each fails", () => {
    render(<DoctorAvatar doctorId={ID} name={NAME} size={48} />);
    const photo = screen.getByRole("img", { name: NAME });
    expect(photo.tagName).toBe("IMG");
    expect(photo.getAttribute("src")).toBe(`/doctors/${ID}-256.webp`);
    expect(photo.getAttribute("srcset")).toBe(
      `/doctors/${ID}-256.webp 1x, /doctors/${ID}-512.webp 2x`,
    );
    expect(photo.getAttribute("title")).toBe(
      "AI-generated portrait of a fictional doctor",
    );
    expect(photo.getAttribute("width")).toBe("48");

    fireEvent.error(photo);

    const svg = screen.getByRole("img", { name: NAME });
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
    fireEvent.error(screen.getByRole("img", { name: NAME }));
    rerender(
      <DoctorAvatar
        doctorId="412e6793-68f2-5c62-832d-cb7839acae9d"
        name="Dr. Brian Kamau"
      />,
    );
    const next = screen.getByRole("img", { name: "Dr. Brian Kamau" });
    expect(next.tagName).toBe("IMG");
    expect(next.getAttribute("src")).toBe(
      "/doctors/412e6793-68f2-5c62-832d-cb7839acae9d-256.webp",
    );
  });

  it("has an explicit size on the image and on the initials fallback, so nothing shifts", () => {
    const { rerender } = render(
      <DoctorAvatar doctorId={ID} name={NAME} size={56} />,
    );
    const img = screen.getByRole("img", { name: NAME });
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

  it("keeps the doctor's name as the alt text and the disclosure as the description", () => {
    render(<DoctorAvatar doctorId={ID} name={NAME} />);
    const img = screen.getByRole("img", { name: NAME });
    expect(img.getAttribute("alt")).toBe(NAME);
    expect(img.getAttribute("title")).toMatch(/AI-generated portrait/);
  });
});
