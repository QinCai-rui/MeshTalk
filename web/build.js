const fs = require("fs");
const path = require("path");
const Handlebars = require("handlebars");
const site = require("./pages.json");

const root = __dirname;
const dist = path.join(root, "dist");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const partialsDir = path.join(root, "views", "partials");
for (const f of fs.readdirSync(partialsDir)) {
  if (!f.endsWith(".hbs")) continue;
  Handlebars.registerPartial(
    path.basename(f, ".hbs"),
    fs.readFileSync(path.join(partialsDir, f), "utf8")
  );
}

const layout = Handlebars.compile(
  fs.readFileSync(path.join(root, "views", "layouts", "main.hbs"), "utf8")
);

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

const outputs = [...site.pages, site.notFound];

for (const page of outputs) {
  const tpl = Handlebars.compile(
    fs.readFileSync(path.join(root, "views", `${page.view}.hbs`), "utf8")
  );
  const ctx = pageContext(page);
  fs.writeFileSync(path.join(dist, page.output), layout({ ...ctx, body: tpl(ctx) }));
}

fs.cpSync(path.join(root, "public"), dist, { recursive: true });

console.log(`Built ${outputs.length} pages into dist/`);
