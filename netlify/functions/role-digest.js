// role-digest.js
// Netlify SCHEDULED function — the knowhash Role morning digest (30 Sep 2026).
// Runs daily at 20:00 UTC (schedule in netlify.toml) = 7am Melbourne in
// daylight saving (Oct–Apr), 6am the rest of the year. Emails the last 24
// hours of knowhash Role activity to DIGEST_EMAIL (default Mike).
// Can also be run on demand from the Netlify UI (Functions → role-digest → Run).

const { roleActivity } = require("./role-activity");
const { sendEmail, esc } = require("./role-format");

const TO = process.env.DIGEST_EMAIL || "mike@teamemployment.com.au";

function docsLine(d) {
  const parts = [];
  if (d.pd) parts.push("PD");
  if (d.ads.length) parts.push(`Ad (${d.ads.join(", ")})`);
  if (d.questions) parts.push("Questions");
  return parts.join(" · ") || "none yet";
}

exports.handler = async () => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { totals: t, roles } = await roleActivity(since);

    const quiet = roles.length === 0 && t.answers === 0;
    const subject = quiet
      ? "knowhash Role — a quiet day"
      : `knowhash Role — ${t.newRoles} new role${t.newRoles === 1 ? "" : "s"}, ${t.answers} answer${t.answers === 1 ? "" : "s"}`;

    const statRow = [
      ["New roles", `${t.newRoles}`, `${t.newWebsite} website · ${t.newProspect} prospect`],
      ["Roles set (first document)", `${t.lockedInWindow}`, "the real sign of engagement"],
      ["Roles with activity", `${t.activeRoles}`, `${t.withEmail} have given an email`],
      ["Candidate answers", `${t.answers}`, ""],
    ];

    const rows = roles.map((r) => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eef0f4;vertical-align:top">
          <b style="color:#22355C">${esc(r.title)}</b>${r.isNew ? ' <span style="font-size:11px;color:#1F8F3B;font-weight:700">NEW</span>' : ""}<br>
          <span style="color:#6b7480;font-size:12.5px">${r.source}${r.who ? ` · ${esc(r.who)}` : ""}${r.company ? ` · ${esc(r.company)}` : ""}</span>
        </td>
        <td style="padding:8px 10px;border-bottom:1px solid #eef0f4;font-size:13px;vertical-align:top">${r.locked ? "Set" : "Draft"} · ${r.drafts}/10 drafts<br><span style="color:#6b7480">${docsLine(r.docs)}</span></td>
        <td style="padding:8px 10px;border-bottom:1px solid #eef0f4;font-size:13px;vertical-align:top">${r.email ? "Email ✓" : "No email"}${r.answers ? `<br>${r.answers} answer${r.answers === 1 ? "" : "s"}` : ""}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eef0f4;font-size:13px;vertical-align:top">${r.privateLink ? `<a href="${r.privateLink}" style="color:#0D5C63">Open</a>` : ""}</td>
      </tr>`).join("");

    const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#2b2b2b;max-width:680px;line-height:1.5">
<h2 style="font-size:19px;color:#22355C;margin:0 0 4px">knowhash Role — last 24 hours</h2>
<p style="color:#6b7480;font-size:13px;margin:0 0 16px">${new Date(since).toLocaleString("en-AU", { timeZone: "Australia/Melbourne" })} to now</p>
<table style="border-collapse:collapse;width:100%;margin-bottom:18px">${statRow.map(([l, n, s]) => `
  <tr><td style="padding:6px 0;font-size:14px">${l}</td><td style="padding:6px 10px;font-size:18px;font-weight:700;color:#0D5C63;text-align:right">${n}</td><td style="padding:6px 0;font-size:12.5px;color:#6b7480">${s}</td></tr>`).join("")}
</table>
${quiet ? '<p style="font-size:14px">Nothing new. All quiet.</p>' : `
<table style="border-collapse:collapse;width:100%;font-size:14px">
  <tr style="text-align:left;color:#6b7480;font-size:11.5px"><th style="padding:6px 10px">Role</th><th style="padding:6px 10px">Progress</th><th style="padding:6px 10px">Contact</th><th></th></tr>
  ${rows}
</table>`}
<p style="font-size:12px;color:#9aa3b0;margin-top:20px">Links open each role's private page \u2014 this email is for you only. Anytime view: ${"https://knowhash.com/qualifier-stats/"}</p>
</div>`;

    const text = `knowhash Role — last 24 hours\n\nNew roles: ${t.newRoles} (${t.newWebsite} website, ${t.newProspect} prospect)\nRoles set: ${t.lockedInWindow}\nRoles with activity: ${t.activeRoles} (${t.withEmail} with email)\nCandidate answers: ${t.answers}\n\n` +
      roles.map((r) => `- ${r.title} [${r.source}${r.who ? `, ${r.who}` : ""}] ${r.locked ? "set" : "draft"}, ${r.drafts}/10 drafts, ${r.email ? "email" : "no email"}${r.answers ? `, ${r.answers} answers` : ""}${r.privateLink ? `\n  ${r.privateLink}` : ""}`).join("\n");

    await sendEmail({ to: TO, subject, text, html });
    return { statusCode: 200, body: JSON.stringify({ sent: true, roles: roles.length }) };
  } catch (err) {
    console.error("role-digest error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
