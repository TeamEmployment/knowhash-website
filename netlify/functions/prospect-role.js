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

// LinkedIn job cards read as "Title (Verified job) Title Company Location
// View job Benefits…", or sometimes "Title Title Company Location…".
// splitJobCard() separates the clean TITLE from the rest of the card's
// DETAIL (company, location, benefits) — the title is stamped on every
// document so it must be clean, but the detail is usually key to the role,
// so it's kept and moved into the role's text instead of being dropped.
// (1 Oct 2026)
function splitJobCard(raw) {
  const lines = String(raw || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  let t = lines.join(" ");
  const verified = /\(?\s*verified job\s*\)?/i;
  let title, rest;
  if (verified.test(t)) {
    const parts = t.split(verified);
    title = parts[0];
    rest = parts.slice(1).join(" ");
  } else if (lines.length > 1) {
    title = lines[0];
    rest = lines.slice(1).join(" ");
  } else {
    title = t;
    rest = "";
  }
  const tidy = (x) => x.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s+/g, " ").trim();
  title = tidy(title);
  rest = tidy(rest);
  // Repeated title: the shortest leading run of words immediately repeated is
  // the title, everything after the repeat is detail.
  const w = title.split(" ");
  for (let k = 1; k * 2 <= w.length; k++) {
    if (w.slice(0, k).join(" ").toLowerCase() === w.slice(k, 2 * k).join(" ").toLowerCase()) {
      rest = tidy(w.slice(2 * k).join(" ") + " " + rest);
      title = w.slice(0, k).join(" ");
      break;
    }
  }
  // The detail often starts with the title again — drop that repeat.
  if (rest.toLowerCase().startsWith(title.toLowerCase())) rest = tidy(rest.slice(title.length));
  rest = tidy(rest.replace(/\bview job\b/gi, " ").replace(/\bverified job\b/gi, " "));
  return { title: title.slice(0, 197), detail: rest.slice(0, 400) };
}
function cleanJobTitle(raw) { return splitJobCard(raw).title; }
// LinkedIn truncates long posts with "… more" — drop it from captured text.
function cleanAdText(raw) {
  return String(raw || "").replace(/\s*(?:…|\.\.\.)\s*(?:see\s+)?more\s*$/i, "").trim();
}
// Text for a role: the job card's detail as a first line (unless already
// there), then the post itself.
function roleTextWithDetail(rawTitle, adText) {
  const { detail } = splitJobCard(rawTitle);
  const text = cleanAdText(adText);
  if (!detail || text.includes("From the job post:") || text.includes(detail)) return text;
  return `From the job post: ${detail}${text ? "\n\n" + text : ""}`;
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
      adText: roleTextWithDetail(lead.cre5b_jobpostingtitle || "", lead.cre5b_ad_text || ""), // detail kept, not dropped
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
      const text = typeof adText === "string" ? cleanAdText(adText).slice(0, 20000) : null;

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
