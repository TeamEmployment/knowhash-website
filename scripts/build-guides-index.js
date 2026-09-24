// Scans /guides/*/index.html and writes /guides/index.json for the /support page.
// Runs on every Netlify deploy (see netlify.toml). No dependencies.
// A guide is listed only if it has <meta name="kh-guide-listed" content="true">.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.env.PUBLISH_DIR || ".");
const GUIDES = path.join(ROOT, "guides");

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const meta = (html, name) => {
  // Match the tag first, then read content="..." or content='...' so apostrophes inside double quotes survive
  const tag = html.match(new RegExp(`<meta[^>]*name=["']${name}["'][^>]*>`, "i"));
  if (!tag) return "";
  const c = tag[0].match(/content="([^"]*)"|content='([^']*)'/i);
  return c ? decode((c[1] ?? c[2]).trim()) : "";
};
const numParts = (n) => n.split(".").map(Number);
const byNumber = (a, b) => {
  const x = numParts(a.number), y = numParts(b.number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
};

const guides = [];
for (const dir of fs.readdirSync(GUIDES, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const file = path.join(GUIDES, dir.name, "index.html");
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, "utf8");
  if (meta(html, "kh-guide-listed").toLowerCase() !== "true") continue;

  const number = (dir.name.match(/^(\d+(?:\.\d+)*)-/) || [])[1] || "";
  const titleTag = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || dir.name;
  guides.push({
    number,
    slug: dir.name,
    url: `/guides/${dir.name}/`,
    title: decode(titleTag.split("|")[0].trim()),
    description: meta(html, "description"),
    section: meta(html, "kh-guide-section") || "General",
  });
}
guides.sort(byNumber);

fs.writeFileSync(path.join(GUIDES, "index.json"),
  JSON.stringify({ generated: new Date().toISOString(), guides }, null, 2));
console.log(`guides/index.json: ${guides.length} listed guide(s)`);
