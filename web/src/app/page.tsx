// Static landing page: no client JS. Links to the API docs and health.
export const dynamic = "force-static";

export default function Home() {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "4rem auto",
        padding: "0 1rem",
        fontFamily: "system-ui",
      }}
    >
      <h1>Clinic Booking API</h1>
      <p>
        A small clinic booking REST API. The interactive docs and the OpenAPI
        contract are below; the API itself is served under <code>/api</code>.
      </p>
      <ul>
        <li>
          <a href="/docs">Swagger UI</a>
        </li>
        <li>
          <a href="/redoc">ReDoc</a>
        </li>
        <li>
          <a href="/openapi.json">OpenAPI contract</a>
        </li>
        <li>
          <a href="/api/health">Health</a>
        </li>
      </ul>
    </main>
  );
}
