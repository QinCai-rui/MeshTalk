const express = require("express");
const { engine } = require("express-handlebars");
const path = require("path");
const site = require("./pages.json");

const app = express();
const PORT = process.env.PORT || 3000;

app.engine("hbs", engine({
  extname: ".hbs",
  defaultLayout: "main",
  layoutsDir: path.join(__dirname, "views", "layouts"),
  partialsDir: path.join(__dirname, "views", "partials"),
}));

app.set("view engine", "hbs");
app.set("views", path.join(__dirname, "views"));

app.use(express.static(path.join(__dirname, "public")));

const CONTROL_DEFAULT = "https://meshtalk-control.qincai.xyz";

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

app.get("/api/health", async (req, res) => {
  const raw = (req.query.url || CONTROL_DEFAULT).trim();
  if (!isHttpUrl(raw)) {
    return res.status(400).json({ error: "Invalid server URL" });
  }
  const target = raw.replace(/\/+$/, "");
  try {
    const upstream = await fetch(target + "/health", { signal: AbortSignal.timeout(10000) });
    const body = await upstream.json();
    res.status(upstream.status).json({
      ...body,
      endpoint: target + "/health",
      cors: {
        allowOrigin: upstream.headers.get("access-control-allow-origin"),
        vary: upstream.headers.get("vary"),
      },
    });
  } catch (err) {
    res.status(502).json({ error: String(err?.message ?? err), endpoint: target + "/health" });
  }
});

function pageContext(page) {
  return {
    title: page.title,
    site: site.site,
    meta: {
      description: page.description || site.site.defaultDescription,
      keywords: page.keywords || site.site.defaultKeywords,
      robots: page.robots,
      ogType: page.ogType || "website",
      canonical: page.canonical,
    },
  };
}

for (const page of site.pages) {
  const routes = [page.route, ...(page.aliases || [])];
  for (const route of routes) {
    app.get(route, (_req, res) => {
      res.render(page.view, pageContext(page));
    });
  }
}

app.use((_req, res) => {
  res.status(404).render(site.notFound.view, pageContext(site.notFound));
});

app.listen(PORT, () => {
  console.log(`MeshTalk website running at http://localhost:${PORT}`);
});
