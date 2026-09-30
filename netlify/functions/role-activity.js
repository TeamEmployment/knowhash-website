// role-activity.js
// Shared helper (no handler): knowhash Role activity for a time window.
// Used by role-digest.js (morning email) and qualifier-stats.js (Mission
// Control page). 30 Sep 2026.

const { dataverseRequest } = require("./dataverse-client");

const WEBSITE = 342840001;
const SITE = "https://knowhash.com";

// Internal rows (cache templates, test leads) never count as activity.
function isInternal(lead) {
  const e = (lead?.cre5b_email || "").toLowerCase();
  const n = lead?.cre5b_name || "";
  return e.endsWith("@internal.knowhash.com") || /^TEST\b/i.test(n);
}

function parse(s) { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } }

async function getAll(path) {
  let out = [];
  let next = path;
  while (next) {
    const r = await dataverseRequest("GET", next);
    out = out.concat(r.value || []);
    const link = r["@odata.nextLink"];
    next = link ? link.slice(link.indexOf("/api/data/v9.2/") + "/api/data/v9.2/".length) : null;
  }
  return out;
}

async function roleActivity(sinceIso) {
  // Answers first: a candidate answering doesn't modify the role record,
  // so roles whose only activity is new answers must be fetched by id.
  const answers = await getAll(
    `cre5b_knowhashqualifierresponses?$filter=createdon ge ${sinceIso}&$select=_cre5b_position_qualifier_value,createdon`
  );
  const answersByRole = {};
  answers.forEach((a) => { const k = a._cre5b_position_qualifier_value; answersByRole[k] = (answersByRole[k] || 0) + 1; });
  const answeredIds = Object.keys(answersByRole).filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 50);

  // Any role touched in the window (new, drafted, email given, edited) or answered.
  const filter = [`modifiedon ge ${sinceIso}`, ...answeredIds.map((id) => `cre5b_knowhashpositionqualifierid eq ${id}`)].join(" or ");
  const roles = await getAll(
    `cre5b_knowhashpositionqualifiers?$filter=${filter}` +
    `&$select=cre5b_knowhashpositionqualifierid,cre5b_role_title,cre5b_generation_count,cre5b_title_locked_at,cre5b_generated_questions,cre5b_generated_pd,cre5b_generated_ad_copy,cre5b_notify_email,createdon,modifiedon` +
    `&$expand=cre5b_owner_lead($select=cre5b_name,cre5b_email,cre5b_lead_source,cre5b_landing_page_token,cre5b_company)` +
    `&$orderby=modifiedon desc`
  );

  const list = roles
    .filter((q) => !isInternal(q.cre5b_owner_lead))
    .map((q) => {
      const lead = q.cre5b_owner_lead || {};
      const ad = parse(q.cre5b_generated_ad_copy);
      return {
        id: q.cre5b_knowhashpositionqualifierid,
        title: q.cre5b_role_title || "(no title yet)",
        source: lead.cre5b_lead_source === WEBSITE ? "Website" : "Prospect",
        who: lead.cre5b_lead_source === WEBSITE ? null : (lead.cre5b_name || null),
        company: lead.cre5b_company || null,
        isNew: q.createdon >= sinceIso,
        lockedInWindow: !!q.cre5b_title_locked_at && q.cre5b_title_locked_at >= sinceIso,
        locked: !!q.cre5b_title_locked_at || !!q.cre5b_generated_questions,
        drafts: q.cre5b_generation_count || 0,
        docs: {
          questions: !!q.cre5b_generated_questions,
          pd: !!q.cre5b_generated_pd,
          ads: (ad?.ads || []).map((a) => a.board),
        },
        email: !!(q.cre5b_notify_email || (lead.cre5b_lead_source === WEBSITE && lead.cre5b_email)),
        answers: answersByRole[q.cre5b_knowhashpositionqualifierid] || 0,
        // Private link — only ever included in Mike's own digest email.
        privateLink: lead.cre5b_landing_page_token ? `${SITE}/position-qualifier/?token=${lead.cre5b_landing_page_token}` : null,
      };
    });

  const totals = {
    newRoles: list.filter((r) => r.isNew).length,
    newWebsite: list.filter((r) => r.isNew && r.source === "Website").length,
    newProspect: list.filter((r) => r.isNew && r.source === "Prospect").length,
    lockedInWindow: list.filter((r) => r.lockedInWindow).length,
    activeRoles: list.length,
    withEmail: list.filter((r) => r.email).length,
    answers: list.reduce((n, r) => n + r.answers, 0), // excludes internal test roles
  };
  return { since: sinceIso, totals, roles: list };
}

module.exports = { roleActivity };
