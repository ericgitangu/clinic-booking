import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/proxy/gcp-id-token", async (orig) => ({
  ...(await orig<typeof import("../src/proxy/gcp-id-token")>()),
  mintIdToken: vi.fn(),
}));

import { callApi } from "../src/call";
import { listDoctorsDoctorsGet } from "../src/generated";
import { mintIdToken } from "../src/proxy/gcp-id-token";

describe("callApi when the identity token cannot be minted", () => {
  beforeEach(() => {
    process.env.API_URL = "https://api.example.run.app";
    process.env.VERCEL_ENV = "production"; // minting on, as in Cloud Run
    vi.mocked(mintIdToken).mockReset();
  });
  afterEach(() => {
    delete process.env.VERCEL_ENV;
    vi.restoreAllMocks();
  });

  it("returns UPSTREAM_AUTH_FAILED and sends nothing", async () => {
    vi.mocked(mintIdToken).mockRejectedValue(new Error("mint failed"));
    const sent = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json([]));

    const res = await callApi("doctors", (client) =>
      listDoctorsDoctorsGet({ client }),
    );

    expect(res).toMatchObject({
      ok: false,
      status: 502,
      code: "UPSTREAM_AUTH_FAILED",
    });
    expect(mintIdToken).toHaveBeenCalledTimes(1);
    expect(sent).not.toHaveBeenCalled();
  });
});
