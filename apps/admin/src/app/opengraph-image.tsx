import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

export const alt = `${SITE.name}: the staff dashboard`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The share card: the same white-lettered logo on the brand navy as the patient app's, with the
// line that says this is the staff side.
export default async function OpenGraphImage() {
  const logo = await readFile(
    path.join(process.cwd(), "public/brand/idyllic-logo-dark.png"),
  );
  const src = `data:image/png;base64,${logo.toString("base64")}`;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        background: "#0a1130",
        padding: "0 90px",
      }}
    >
      <img src={src} width={444} height={336} alt="" />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginLeft: 70,
          width: 506,
          color: "#e8f0fa",
        }}
      >
        <div style={{ fontSize: 68, fontWeight: 700, lineHeight: 1.1 }}>
          Idyllic staff dashboard
        </div>
        <div
          style={{
            fontSize: 32,
            marginTop: 24,
            color: "#a3b4d6",
            lineHeight: 1.35,
          }}
        >
          Appointments, history and access for clinic staff.
        </div>
      </div>
    </div>,
    size,
  );
}
