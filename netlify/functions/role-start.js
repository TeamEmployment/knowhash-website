// role-start.js
// Netlify Function — start a free knowhash Role from the website (30 Sep 2026).
// Replaces qualifier-claim-free.js.
//
// POST { email, title } → { sent: true }
//
// SECURITY: this never returns a landing-page token. The link is EMAILED to
// the address given, so opening it proves the visitor owns that inbox —
// that's the "free role after email verification" step. (claim-free
// returned the token directly, so typing someone else's email opened
// their page, including their candidates' answers.)
//
// If the email already belongs to a lead (e.g. a Prospect outreach contact),
// they're sent their EXISTING link and nothing is changed — their one free
// role stays whatever it already is. New visitors get a new website lead
// with the typed title proposed as their role (editable until first
// generation, per qualifier-role.js).

const { dataverseRequest } = require("./dataverse-client");
const crypto = require("crypto");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SITE = "https://knowhash.com";

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function sendLinkEmail(toEmail, token, title) {
  const link = `${SITE}/position-qualifier/?token=${encodeURIComponent(token)}`;
  const roleLine = title ? `for <b>${escapeHtml(title)}</b>` : "";
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail }] }],
      from: { email: "notifications@knowhash.com", name: "knowhash" },
      subject: "Your free role on knowhash",
      content: [
        {
          type: "text/plain",
          value: `Here's your link to knowhash Role${title ? ` for ${title}` : ""}:\n\n${link}\n\nKeep this email — the link is how you get back to your role, its documents and your candidates' answers.\n\nDidn't ask for this? You can ignore it; nothing happens unless the link is opened.\n\nknowhash — ${SITE}`,
        },
        {
          type: "text/html",
          value: `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#22355C;max-width:520px;line-height:1.55">
<p>Here's your link to <b>knowhash Role</b> ${roleLine}:</p>
<p><a href="${link}" style="display:inline-block;background:#0D5C63;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Open my role</a></p>
<p style="font-size:13px;color:#58595b">Keep this email — the link is how you get back to your role, its documents and your candidates' answers.</p>
<p style="font-size:12px;color:#9aa3b0">Didn't ask for this? You can ignore it; nothing happens unless the link is opened.</p>
</div>`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`SendGrid ${res.status}: ${await res.text()}`);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
    const { email, title } = JSON.parse(event.body || "{}");

    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 100 || /['"\s]/.test(cleanEmail)
        || cleanEmail.endsWith("@internal.knowhash.com")) {
      return json(400, { error: "Enter a valid email address" });
    }
    const cleanTitle = String(title || "").replace(/\s+/g, " ").trim().slice(0, 197);
    if (!cleanTitle) return json(400, { error: "Enter the role you're hiring for" });

    // Case-insensitive collation — plain eq matches regardless of case.
    const existing = await dataverseRequest(
      "GET",
      `cre5b_knowhashleadses?$filter=cre5b_email eq '${cleanEmail}'&$select=cre5b_knowhashleadsid,cre5b_landing_page_token,cre5b_jobpostingtitle,cre5b_search_role&$top=1`
    );
    const lead = existing.value?.[0];

    if (lead) {
      // Existing contact: send their own link, change nothing about their role.
      let token = lead.cre5b_landing_page_token;
      if (!token) {
        token = crypto.randomBytes(16).toString("hex");
        const patch = { cre5b_landing_page_token: token };
        if (!lead.cre5b_jobpostingtitle && !lead.cre5b_search_role) patch.cre5b_search_role = cleanTitle;
        await dataverseRequest("PATCH", `cre5b_knowhashleadses(${lead.cre5b_knowhashleadsid})`, patch);
      }
      await sendLinkEmail(cleanEmail, token, null);
    } else {
      const token = crypto.randomBytes(16).toString("hex");
      await dataverseRequest("POST", "cre5b_knowhashleadses", {
        cre5b_name: cleanEmail,
        cre5b_newcolumn: cleanEmail,
        cre5b_email: cleanEmail,
        cre5b_search_role: cleanTitle,
        cre5b_lead_source: 342840001, // Website - Position Qualifier
        cre5b_landing_page_token: token,
      });
      await sendLinkEmail(cleanEmail, token, cleanTitle);
    }

    // Same answer either way — never reveals whether the email was already known.
    return json(200, { sent: true });
  } catch (err) {
    console.error("role-start error:", err);
    return json(500, { error: "Something went wrong — please try again shortly." });
  }
};
