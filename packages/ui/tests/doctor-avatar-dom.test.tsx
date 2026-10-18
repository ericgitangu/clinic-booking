// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DoctorAvatar } from "../src/components/doctor-avatar";

const ID = "e52e9da0-f7f3-5a6a-93d3-d7f658947afa";
const NAME = "Dr. Achieng Otieno";

afterEach(cleanup);

describe("DoctorAvatar (stateful)", () => {
  it("shows the image, then the initials once the image errors", () => {
    render(<DoctorAvatar doctorId={ID} name={NAME} size={48} />);
    const img = screen.getByRole("img", { name: NAME });
    expect(img.tagName).toBe("IMG");

    fireEvent.error(img);

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
    expect(screen.getByRole("img", { name: "Dr. Brian Kamau" }).tagName).toBe(
      "IMG",
    );
  });
});
