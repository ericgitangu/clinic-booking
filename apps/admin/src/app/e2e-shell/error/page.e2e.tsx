// A page that always throws, so the shell's e2e tests can see the error screen in a real build. It is a
// page only in builds made with SHELL_E2E=1 (next.config.ts adds the "e2e.tsx" page extension then);
// in every other build the file is ignored and the route does not exist.
export default function ShellErrorFixture(): never {
  throw new Error("shell e2e: deliberate error");
}

export const dynamic = "force-dynamic";
