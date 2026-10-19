import { getStaff } from "@/lib/session";

// Shown with a real 403 status whenever a page calls forbidden().
export default async function Forbidden() {
  const staff = await getStaff().catch(() => null);
  return (
    <section className="mx-auto max-w-md py-16" data-testid="forbidden">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        You do not have access
      </h1>
      <p className="mt-4 text-lg leading-8 text-muted-foreground">
        {staff?.role
          ? "Your role cannot open this page."
          : "This account has not been given access to the clinic dashboard."}{" "}
        Ask the clinic owner to add or update your access, then reload.
      </p>
    </section>
  );
}
