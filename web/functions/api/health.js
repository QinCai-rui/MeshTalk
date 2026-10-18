// Cloudflare Pages Function: /api/health
//
// Server-side proxy for the control server health check. Browsers cannot rely
// on the control server allowing cross-origin requests, so the status page asks
// this same-origin route to fetch /health upstream. It works even when the
// control server sends no CORS headers.
//
// This mirrors the Express route in ../server.js, which local development and
// Docker still use. Only the configured control server may be probed; the url
// query parameter exists so the page can confirm which endpoint it checked.

const FALLBACK_CONTROL = "https://meshtalk-control.qincai.xyz";

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const defaultControl = (env && env.CONTROL_DEFAULT) || FALLBACK_CONTROL;

  const param = new URL(request.url).searchParams.get("url");
  const raw = param && param.trim() !== "" ? param.trim() : defaultControl;
  if (!isHttpUrl(raw) || raw.replace(/\/+$/, "") !== defaultControl) {
    return Response.json({ error: "Invalid server URL" }, { status: 400 });
  }

  const target = raw.replace(/\/+$/, "");
  const endpoint = target + "/health";
  try {
    const upstream = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
    const body = await upstream.json();
    return Response.json(
      {
        ...body,
        endpoint,
        cors: {
          allowOrigin: upstream.headers.get("access-control-allow-origin"),
          vary: upstream.headers.get("vary"),
        },
      },
      { status: upstream.status }
    );
  } catch (err) {
    return Response.json(
      { error: String(err?.message ?? err), endpoint },
      { status: 502 }
    );
  }
}
