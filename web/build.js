const fs = require("fs");
const path = require("path");
const Handlebars = require("handlebars");

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

const pages = [
  ["index.html", "home", "MeshTalk — Peer-to-Peer Encrypted Messaging"],
  ["features.html", "features", "Features — MeshTalk"],
  ["docs.html", "docs", "Getting Started — MeshTalk"],
];

for (const [out, view, title] of pages) {
  const tpl = Handlebars.compile(
    fs.readFileSync(path.join(root, "views", `${view}.hbs`), "utf8")
  );
  fs.writeFileSync(path.join(dist, out), layout({ title, body: tpl({ title }) }));
}

fs.cpSync(path.join(root, "public"), dist, { recursive: true });

console.log(`Built ${pages.length} pages into dist/`);
