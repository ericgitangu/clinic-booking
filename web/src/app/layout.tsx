import type { ReactNode } from "react";

export const metadata = {
  title: "Clinic Booking API",
  description: "Clinic booking REST API — docs and status.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
