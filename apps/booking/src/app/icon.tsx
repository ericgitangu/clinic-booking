import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

// App icons for the manifest: the lotus mark on a light tile, at the two sizes installable apps need.
const SIZES = [192, 512] as const;

export function generateImageMetadata() {
  return SIZES.map((s) => ({
    id: String(s),
    size: { width: s, height: s },
    contentType: "image/png",
  }));
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const size = Number(await id);
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
      <img
        src={src}
        width={Math.round(size * 0.84)}
        height={Math.round(size * 0.84)}
        alt=""
      />
    </div>,
    { width: size, height: size },
  );
}
