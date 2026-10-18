import { afterEach, describe, expect, test } from "bun:test";
import { onRequestGet } from "../functions/api/health.js";

const CONTROL = "https://meshtalk-control.qincai.xyz";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function call(query = "") {
  const request = new Request(`https://meshtalk-site.qincai.xyz/api/health${query}`);
  return onRequestGet({ request, env: { CONTROL_DEFAULT: CONTROL } });
}

describe("Pages /api/health proxy", () => {
  test("rejects a control URL that is not the configured server", async () => {
    const response = await call("?url=" + encodeURIComponent("https://evil.example"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid server URL" });
  });

  test("proxies the configured control server health response", async () => {
    let requested;
    globalThis.fetch = async (input) => {
      requested = String(input);
      return new Response(JSON.stringify({ status: "ok", rooms: 2, connections: 5 }), {
        status: 200,
        headers: {
          "access-control-allow-origin": "https://meshtalk-site.qincai.xyz",
          vary: "Origin",
        },
      });
    };

    const response = await call();
    expect(response.status).toBe(200);
    expect(requested).toBe(`${CONTROL}/health`);
    expect(await response.json()).toEqual({
      status: "ok",
      rooms: 2,
      connections: 5,
      endpoint: `${CONTROL}/health`,
      cors: { allowOrigin: "https://meshtalk-site.qincai.xyz", vary: "Origin" },
    });
  });

  test("returns 502 when the control server is unreachable", async () => {
    globalThis.fetch = async () => {
      throw new Error("connect timeout");
    };

    const response = await call();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "connect timeout",
      endpoint: `${CONTROL}/health`,
    });
  });
});
