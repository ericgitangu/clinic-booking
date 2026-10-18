import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

// App icons for the manifest: the lotus mark on a light tile, at the two sizes installable apps
// need, plus a maskable one. A phone crops a maskable icon to its own shape (circle, squircle), and
// only the centre 80% is safe, so the mark is smaller there and the tile fills the whole square.
const ICONS = [
  { id: "192", size: 192, mark: 0.84 },
  { id: "512", size: 512, mark: 0.84 },
  { id: "maskable-512", size: 512, mark: 0.56 },
] as const;

export function generateImageMetadata() {
  return ICONS.map((i) => ({
    id: i.id,
    size: { width: i.size, height: i.size },
    contentType: "image/png",
  }));
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const wanted = String(await id);
  const icon = ICONS.find((i) => i.id === wanted) ?? ICONS[0];
  const size = icon.size;
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
        width={Math.round(size * icon.mark)}
        height={Math.round(size * icon.mark)}
        alt=""
      />
    </div>,
    { width: size, height: size },
  );
}
