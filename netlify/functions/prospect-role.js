// prospect-role.js
// Netlify Function — Mike's internal Prospect extension talks to this to
// see and fix what a prospect's knowhash Role link will show (30 Sep 2026).
//
// Auth: header x-prospect-key must equal env PROSPECT_KEY. Only the
// internal (unpublished) Prospect extension has it.
//
// GET  ?urn=<linkedin urn>
//   → { lead: { jobPostingTitle, adText, landingPageToken },
//       role: null | { title, locked, drafts, docs } }
// POST { urn, jobPostingTitle, adText }
//   → saves both on the lead (direct to Dataverse, not via the flow), and
//     if the prospect already has a DRAFT role (opened the link, not yet
//     created anything) updates that draft too. A set (locked) role is
//     left alone — the response says so.

const { dataverseRequest } = require("./dataverse-client");

const CORS = {
  "Access-Control-Allow-Origin": "https://www.linkedin.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-prospect-key",
};
const json = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

const URN_RE = /^urn:li:[A-Za-z_]+:[A-Za-z0-9_-]{4,120}$/;

// Same rules as the extension's cleanJobTitle(): LinkedIn job cards read as
// "Title (Verified job) Title Company Location View job Benefits…".
function cleanJobTitle(raw) {
  let t = String(raw || "");
  t = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";
  t = t.split(/\(?\s*verified job\s*\)?/i)[0];
  t = t.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s+/g, " ").trim();
  return t.slice(0, 197);
}

async function load(urn) {
  const r = await dataverseRequest(
    "GET",
    `cre5b_knowhashleadses?$filter=cre5b_linkedinurn eq '${urn}'&$select=cre5b_knowhashleadsid,cre5b_jobpostingtitle,cre5b_ad_text,cre5b_landing_page_token,cre5b_search_role&$top=1`
  );
  const lead = r.value?.[0];
  if (!lead) return { lead: null, role: null };
  const q = await dataverseRequest(
    "GET",
    `cre5b_knowhashpositionqualifiers?$filter=_cre5b_owner_lead_value eq ${lead.cre5b_knowhashleadsid}&$select=cre5b_knowhashpositionqualifierid,cre5b_role_title,cre5b_title_locked_at,cre5b_generated_questions,cre5b_generated_pd,cre5b_generated_ad_copy,cre5b_generation_count&$orderby=createdon asc&$top=1`
  );
  return { lead, role: q.value?.[0] || null };
}

function view({ lead, role }) {
  return {
    lead: lead && {
      jobPostingTitle: lead.cre5b_jobpostingtitle || "",
      suggestedTitle: cleanJobTitle(lead.cre5b_jobpostingtitle || lead.cre5b_search_role || ""),
      adText: lead.cre5b_ad_text || "",
      landingPageToken: lead.cre5b_landing_page_token || null,
    },
    role: role && {
      title: role.cre5b_role_title || "",
      locked: !!role.cre5b_title_locked_at || !!role.cre5b_generated_questions,
      drafts: role.cre5b_generation_count || 0,
      docs: {
        questions: !!role.cre5b_generated_questions,
        pd: !!role.cre5b_generated_pd,
        ad: !!role.cre5b_generated_ad_copy,
      },
    },
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  try {
    const key = event.headers["x-prospect-key"] || event.headers["X-Prospect-Key"];
    if (!process.env.PROSPECT_KEY || key !== process.env.PROSPECT_KEY) return json(401, { error: "unauthorised" });

    if (event.httpMethod === "GET") {
      const urn = event.queryStringParameters?.urn;
      if (!URN_RE.test(urn || "")) return json(400, { error: "invalid_urn" });
      const found = await load(urn);
      if (!found.lead) return json(404, { error: "lead_not_found" });
      return json(200, view(found));
    }

    if (event.httpMethod === "POST") {
      const { urn, jobPostingTitle, adText } = JSON.parse(event.body || "{}");
      if (!URN_RE.test(urn || "")) return json(400, { error: "invalid_urn" });
      const title = cleanJobTitle(jobPostingTitle);
      if (!title) return json(400, { error: "title_required" });
      const text = typeof adText === "string" ? adText.slice(0, 20000) : null;

      const found = await load(urn);
      if (!found.lead) return json(404, { error: "lead_not_found" });

      const leadPatch = { cre5b_jobpostingtitle: title };
      if (text !== null) leadPatch.cre5b_ad_text = text;
      await dataverseRequest("PATCH", `cre5b_knowhashleadses(${found.lead.cre5b_knowhashleadsid})`, leadPatch);
      Object.assign(found.lead, leadPatch);

      let roleUpdated = false;
      const r = found.role;
      if (r && !r.cre5b_title_locked_at && !r.cre5b_generated_questions) {
        const rolePatch = { cre5b_role_title: title };
        if (text !== null) rolePatch.cre5b_position_text = text;
        await dataverseRequest("PATCH", `cre5b_knowhashpositionqualifiers(${r.cre5b_knowhashpositionqualifierid})`, rolePatch);
        Object.assign(r, rolePatch);
        roleUpdated = true;
      }
      return json(200, { ...view(found), roleUpdated });
    }
    return json(405, { error: "method_not_allowed" });
  } catch (err) {
    console.error("prospect-role error:", err);
    return json(500, { error: "Something went wrong", detail: err.message });
  }
};
