// Direct access to the real compose Postgres, for the one scenario that has to put the email
// allowance at its limit (emails-cap.spec.ts). The credentials are the local compose database's own
// throwaway owner role from docker-compose.yml, on the port the stack was started with.
import { Client } from "pg";

const port = process.env.DB_HOST_PORT ?? "5432";
const url =
  process.env.E2E_DB_URL ??
  `postgresql://clinic:clinic@127.0.0.1:${port}/clinic`;

export async function withDb<T>(run: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    return await run(db);
  } finally {
    await db.end();
  }
}
