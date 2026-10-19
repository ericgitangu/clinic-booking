import type { ReactNode } from "react";
import { QueryProvider } from "@/components/pwa/providers";

export default function Layout({ children }: { children: ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}
