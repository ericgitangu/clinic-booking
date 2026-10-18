import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

// A page that always throws, so the shell's e2e tests can see the error screen in a real build.
// It exists only when SHELL_E2E=1 (set by the Playwright config); everywhere else it is a 404.
export default function ShellErrorFixture(): never {
  if (process.env.SHELL_E2E !== "1") notFound();
  throw new Error("shell e2e: deliberate error");
}
