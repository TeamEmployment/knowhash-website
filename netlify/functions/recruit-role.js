// recruit-role.js
// Netlify Function — knowhash Role inside knowhash Recruit (1 Oct 2026).
// A Recruit install can have up to 5 ACTIVE roles, each belonging to one
// of its Opportunities. Roles live in the same knowhash Position Qualifier
// table as free roles, owned by the install's recruiterId instead of a
// prospect lead, with their own private role-page token.
//
// POST { recruiterId, action: "list" }
//   → { roles: [...], active, cap }
// POST { recruiterId, action: "create", opportunityRef, title, positionText? }
//   → { role }   (returns the existing role if this Opportunity has one)
//   → 429 { error: "role_cap" } when 5 roles are already active
// POST { recruiterId, action: "archive", opportunityRef }
//   → { archived: true }  (frees the slot; the role page stops working)
//
// Licence: checked server-to-server with kSIP's check-status — active
// subscribers and installs in their free month both count as licensed.

const { dataverseRequest } = require("./dataverse-client");
const crypto = require("crypto");

const CAP = Number(process.env.RECRUIT_ROLE_CAP || 5);
const CHECK_STATUS_URL = "https://ksip.knowhash.com/.netlify/functions/check-status";
const SITE = "https://knowhash.com";

const CORS = {
  "Access-Control-Allow-Origin": "https://www.linkedin.com",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

const RID_RE = /^[a-zA-Z0-9-]{6,64}$/;
const OPP_RE = /^[A-Za-z0-9_-]{3,64}$/;

const FIELDS = [
  "cre5b_knowhashpositionqualifierid", "cre5b_role_title", "cre5b_opportunity_ref",
  "cre5b_role_token", "cre5b_candidate_link_token", "cre5b_title_locked_at",
  "cre5b_generated_questions", "cre5b_generated_pd", "cre5b_generated_ad_copy",
  "cre5b_generation_count", "createdon",
].join(",");

function parse(s) { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } }

// What the extension needs to build its links table and template chips.
function view(q) {
  const t = q.cre5b_candidate_link_token;
  const ads = (parse(q.cre5b_generated_ad_copy)?.ads || []).map((a) => a.board);
  return {
    roleId: q.cre5b_knowhashpositionqualifierid,
    opportunityRef: q.cre5b_opportunity_ref,
    title: q.cre5b_role_title || "",
    locked: !!q.cre5b_title_locked_at,
    drafts: q.cre5b_generation_count || 0,
    links: {
      rolePage: `${SITE}/position-qualifier/?token=${q.cre5b_role_token}`, // private — the recruiter's own
      questions: q.cre5b_generated_questions ? `${SITE}/position-qualifier/apply/?token=${t}` : null,
      pd: q.cre5b_generated_pd ? `${SITE}/position-qualifier/doc/?t=${t}&d=pd` : null,
      ads: Object.fromEntries(ads.map((b) => [b, `${SITE}/position-qualifier/doc/?t=${t}&d=ad&b=${encodeURIComponent(b)}`])),
    },
  };
}

async function isLicensed(recruiterId) {
  try {
    const res = await fetch(CHECK_STATUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://www.linkedin.com" },
      body: JSON.stringify({ recruiterId }),
    });
    if (!res.ok) return false;
    const s = await res.json();
    return s.status === "active"; // includes the free month
  } catch (e) {
    console.error("recruit-role: licence check failed", e);
    return false;
  }
}

async function activeRoles(recruiterId) {
  const r = await dataverseRequest(
    "GET",
    `cre5b_knowhashpositionqualifiers?$filter=cre5b_owner_recruiter_id eq '${recruiterId}' and (cre5b_archived eq false or cre5b_archived eq null)&$select=${FIELDS}&$orderby=createdon asc`
  );
  return r.value || [];
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
  try {
    const { recruiterId, action, opportunityRef, title, positionText } = JSON.parse(event.body || "{}");
    if (!RID_RE.test(recruiterId || "")) return json(400, { error: "invalid_recruiter_id" });

    if (action === "list") {
      const roles = await activeRoles(recruiterId);
      return json(200, { roles: roles.map(view), active: roles.length, cap: CAP });
    }

    if (!OPP_RE.test(opportunityRef || "")) return json(400, { error: "invalid_opportunity" });

    if (action === "create") {
      if (!(await isLicensed(recruiterId))) return json(403, { error: "not_licensed" });
      const cleanTitle = String(title || "").replace(/\s+/g, " ").trim().slice(0, 197);
      if (!cleanTitle) return json(400, { error: "title_required" });

      const roles = await activeRoles(recruiterId);
      const existing = roles.find((q) => q.cre5b_opportunity_ref === opportunityRef);
      if (existing) return json(200, { role: view(existing), active: roles.length, cap: CAP });
      if (roles.length >= CAP) return json(429, { error: "role_cap", active: roles.length, cap: CAP });

      const created = await dataverseRequest("POST", `cre5b_knowhashpositionqualifiers?$select=${FIELDS}`, {
        cre5b_role_title: cleanTitle,
        cre5b_position_text: typeof positionText === "string" ? positionText.slice(0, 20000) : null,
        cre5b_detail_level: 342840001, // Standard
        cre5b_job_boards: "General",
        cre5b_generation_count: 0,
        cre5b_owner_recruiter_id: recruiterId,
        cre5b_opportunity_ref: opportunityRef,
        cre5b_role_token: crypto.randomBytes(16).toString("hex"),
        cre5b_candidate_link_token: crypto.randomBytes(16).toString("hex"),
        cre5b_archived: false,
      });
      return json(200, { role: view(created), active: roles.length + 1, cap: CAP });
    }

    if (action === "archive") {
      const roles = await activeRoles(recruiterId);
      const q = roles.find((x) => x.cre5b_opportunity_ref === opportunityRef);
      if (q) await dataverseRequest("PATCH", `cre5b_knowhashpositionqualifiers(${q.cre5b_knowhashpositionqualifierid})`, { cre5b_archived: true });
      return json(200, { archived: !!q });
    }

    return json(400, { error: "unknown_action" });
  } catch (err) {
    console.error("recruit-role error:", err);
    return json(500, { error: "Something went wrong", detail: err.message });
  }
};
