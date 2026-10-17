import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// iOS wants an opaque square, so the mark sits on white.
export default async function AppleIcon() {
  const mark = await readFile(
    path.join(process.cwd(), "public/brand/idyllic-mark.png"),
  );
  const src = `data:image/png;base64,${mark.toString("base64")}`;
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#ffffff",
      }}
    >
      <img src={src} width={150} height={150} alt="" />
    </div>,
    size,
  );
}
