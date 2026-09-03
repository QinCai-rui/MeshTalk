const express = require("express");
const { engine } = require("express-handlebars");
const path = require("path");

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

app.get("/", (_req, res) => {
  res.render("home", {
    title: "MeshTalk — Peer-to-Peer Encrypted Messaging",
  });
});

app.get("/index.html", (_req, res) => {
  res.render("home", {
    title: "MeshTalk — Peer-to-Peer Encrypted Messaging",
  });
});

app.get("/features", (_req, res) => {
  res.render("features", {
    title: "Features — MeshTalk",
  });
});

app.get("/features.html", (_req, res) => {
  res.render("features", {
    title: "Features — MeshTalk",
  });
});

app.get("/docs", (_req, res) => {
  res.render("docs", {
    title: "Getting Started — MeshTalk",
  });
});

app.get("/docs.html", (_req, res) => {
  res.render("docs", {
    title: "Getting Started — MeshTalk",
  });
});

app.listen(PORT, () => {
  console.log(`MeshTalk website running at http://localhost:${PORT}`);
});
