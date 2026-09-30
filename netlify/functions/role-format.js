// role-format.js
// Shared helpers for knowhash Role (30 Sep 2026): turn a stored document
// into plain text / email HTML, and send mail via SendGrid. Not an endpoint
// (no handler) — required by qualifier-role.js, role-doc.js and
// qualifier-submit-response.js, the same way dataverse-client.js is.

const SITE = "https://knowhash.com";
const NAMES = { qualifier: "Candidate questions", pd: "Position description", ad: "Job ad" };

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// For ads, `doc` is the full stored object; `board` picks the one ad.
function pickAd(doc, board) {
  const ads = (doc && doc.ads) || [];
  return ads.find((a) => a.board === board) || null;
}

function shareUrl(candidateToken, kind, board) {
  const b = kind === "ad" && board ? `&b=${encodeURIComponent(board)}` : "";
  return `${SITE}/position-qualifier/doc/?t=${encodeURIComponent(candidateToken)}&d=${kind}${b}`;
}

function docToText(kind, title, doc, board) {
  const L = [title, kind === "ad" && board ? `${NAMES[kind]} · ${board}` : NAMES[kind], ""];
  if (kind === "pd") {
    if (doc.purpose) L.push("Purpose of the role", doc.purpose, "");
    (doc.sections || []).forEach((s) => L.push(s.heading, ...(s.items || []).map((i) => `- ${i}`), ""));
    if (doc.reportingLine) L.push("Reporting line", doc.reportingLine);
  } else if (kind === "ad") {
    const a = pickAd(doc, board) || {};
    L.push(a.headline || "", "");
    if (a.sellingPoints && a.sellingPoints.length) L.push(...a.sellingPoints.map((p) => `* ${p}`), "");
    if (a.intro) L.push(a.intro, "");
    L.push(...(a.bullets || []).map((b) => `- ${b}`));
    if (a.closing) L.push("", a.closing);
  } else if (kind === "qualifier") {
    (doc.sections || []).forEach((s) => {
      L.push(s.title, s.tagline);
      (s.items || []).forEach((i) => L.push(`- ${i.question}${i.type === "open" ? " (open answer)" : ""}`));
      L.push("");
    });
  }
  return L.join("\n").trim();
}

function list(items) {
  return items && items.length ? `<ul style="margin:0 0 10px;padding-left:20px">${items.map((i) => `<li style="margin-bottom:4px">${esc(i)}</li>`).join("")}</ul>` : "";
}
function h(t) { return `<h3 style="font-size:15px;margin:18px 0 6px;color:#22355C">${esc(t)}</h3>`; }

function docToHtml(kind, title, doc, board) {
  let body = "";
  if (kind === "pd") {
    if (doc.purpose) body += h("Purpose of the role") + `<p>${esc(doc.purpose)}</p>`;
    (doc.sections || []).forEach((s) => { body += h(s.heading) + list(s.items); });
    if (doc.reportingLine) body += h("Reporting line") + `<p>${esc(doc.reportingLine)}</p>`;
  } else if (kind === "ad") {
    const a = pickAd(doc, board) || {};
    body += `<p style="font-size:17px;font-weight:700;color:#22355C;margin:6px 0 12px">${esc(a.headline)}</p>`;
    if (a.sellingPoints && a.sellingPoints.length) body += h("Selling points") + list(a.sellingPoints);
    if (a.intro) body += `<p>${esc(a.intro)}</p>`;
    body += list(a.bullets);
    if (a.closing) body += `<p>${esc(a.closing)}</p>`;
  }
  const label = kind === "ad" && board ? `${NAMES[kind]} · ${board}` : NAMES[kind];
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#2b2b2b;max-width:600px;line-height:1.55;font-size:14px">
<div style="font-size:21px;font-weight:700;color:#22355C">${esc(title)}</div>
<div style="font-size:11.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#1F8F3B;margin:2px 0 10px">${esc(label)}</div>
${body}</div>`;
}

async function sendEmail({ to, subject, text, html }) {
  const content = [{ type: "text/plain", value: text }];
  if (html) content.push({ type: "text/html", value: html });
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: "notifications@knowhash.com", name: "knowhash" },
      subject,
      content,
    }),
  });
  if (!res.ok) throw new Error(`SendGrid ${res.status}: ${await res.text()}`);
}

const EMAIL_RE = /^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/;
function cleanEmail(e) {
  const v = String(e || "").trim().toLowerCase();
  return EMAIL_RE.test(v) && v.length <= 100 && !v.endsWith("@internal.knowhash.com") ? v : null;
}

// Google reCAPTCHA v3 (30 Sep 2026) — same pattern as the Team Employment
// apply form: invisible to people, token checked here, scores below 0.5
// rejected. Fails CLOSED: if RECAPTCHA_SECRET_KEY isn't set on this site,
// protected forms are refused rather than left open to bots.
const RECAPTCHA_MIN_SCORE = 0.5;
async function verifyRecaptcha(token, expectedAction) {
  const secret = process.env.RECAPTCHA_SECRET_KEY;
  if (!secret) { console.error("RECAPTCHA_SECRET_KEY not set"); return false; }
  if (typeof token !== "string" || !token) return false;
  try {
    const res = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }),
    });
    const r = await res.json();
    const ok = r.success === true && (r.score ?? 0) >= RECAPTCHA_MIN_SCORE && (!expectedAction || r.action === expectedAction);
    if (!ok) console.warn("reCAPTCHA rejected:", JSON.stringify({ score: r.score, action: r.action, errors: r["error-codes"] }));
    return ok;
  } catch (e) {
    console.error("reCAPTCHA verify failed:", e);
    return false;
  }
}

module.exports = { SITE, NAMES, esc, pickAd, shareUrl, docToText, docToHtml, sendEmail, cleanEmail, verifyRecaptcha };
