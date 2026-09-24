const { dataverseRequest } = require("./dataverse-client");
const crypto = require("crypto");

// Kept in sync with qualifier-generic-preview.js and the dropdown in
// position-qualifier/index.html. Server-side map only — never trust a
// client-supplied title string.
const GENERIC_ROLES = {
  csr: "Customer Service Representative",
  pm: "Project Manager",
  data: "Data Analyst",
  sales: "Sales Representative",
  admin: "Administrative Assistant",
  accountant: "Accountant",
  marketing: "Marketing Manager",
  ops: "Operations Manager",
  hr: "HR Generalist",
  nurse: "Registered Nurse",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function templateEmailFor(key) {
  return `template-${key}@internal.knowhash.com`;
}

// Pull the already-cached generic-preview content for this title, if it
// exists — so claiming a free link never pays for a second Claude call.
async function getCachedGenericQuestions(roleKey) {
  const templateLead = await dataverseRequest(
    "GET",
    `cre5b_knowhashleadses?$filter=cre5b_email eq '${templateEmailFor(roleKey)}'&$select=cre5b_knowhashleadsid`
  );
  if (!templateLead.value || templateLead.value.length === 0) return null;
  const q = await dataverseRequest(
    "GET",
    `cre5b_knowhashpositionqualifiers?$filter=_cre5b_owner_lead_value eq ${templateLead.value[0].cre5b_knowhashleadsid}&$select=cre5b_generated_questions`
  );
  if (!q.value || q.value.length === 0) return null;
  return q.value[0].cre5b_generated_questions; // already a JSON string
}

// Give this lead their own qualifier row if they don't already have one —
// cloning the cached content (no Claude call) rather than leaving it to be
// generated fresh (and billed) when the page reloads with their new token.
async function ensurePersonalQualifier(leadId, roleKey, title) {
  const existing = await dataverseRequest(
    "GET",
    `cre5b_knowhashpositionqualifiers?$filter=_cre5b_owner_lead_value eq ${leadId}&$select=cre5b_knowhashpositionqualifierid`
  );
  if (existing.value && existing.value.length > 0) return; // already has one — leave it alone

  const cachedJson = await getCachedGenericQuestions(roleKey);
  if (!cachedJson) return; // no cache yet (shouldn't happen — Generate always primes it first); the normal generate-or-fetch flow will generate fresh as a fallback

  await dataverseRequest("POST", "cre5b_knowhashpositionqualifiers", {
    cre5b_role_title: title,
    cre5b_generated_questions: cachedJson,
    cre5b_candidate_link_token: crypto.randomBytes(16).toString("hex"),
    "cre5b_owner_lead@odata.bind": `/cre5b_knowhashleadses(${leadId})`,
  });
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
    }

    const { email, roleKey } = JSON.parse(event.body || "{}");
    const title = GENERIC_ROLES[roleKey];
    if (!title) {
      return { statusCode: 400, body: JSON.stringify({ error: "Unknown role key" }) };
    }
    const cleanEmail = (email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Enter a valid email address" }) };
    }
    // The generic-preview endpoint's cache anchors live at this exact
    // address pattern — a real visitor could never legitimately submit one,
    // but block it explicitly rather than relying on that alone.
    if (cleanEmail.endsWith("@internal.knowhash.com")) {
      return { statusCode: 400, body: JSON.stringify({ error: "Enter a valid email address" }) };
    }

    // Case-insensitive match — same person, however they typed it. Covers a
    // LinkedIn-scraped Prospect independently finding the free page later:
    // they get updated, not duplicated.
    const existing = await dataverseRequest(
      "GET",
      `cre5b_knowhashleadses?$filter=tolower(cre5b_email) eq '${cleanEmail}'&$select=cre5b_knowhashleadsid,cre5b_landing_page_token,cre5b_lead_source`
    );

    let leadId, token;

    if (existing.value && existing.value.length > 0) {
      const lead = existing.value[0];
      leadId = lead.cre5b_knowhashleadsid;
      const updates = { cre5b_search_role: title };
      // Never overwrite how we first met them — only set it if it's genuinely unset.
      if (lead.cre5b_lead_source == null) {
        updates.cre5b_lead_source = 342840001; // Website - Position Qualifier
      }
      token = lead.cre5b_landing_page_token;
      if (!token) {
        token = crypto.randomBytes(16).toString("hex");
        updates.cre5b_landing_page_token = token;
      }
      await dataverseRequest("PATCH", `cre5b_knowhashleadses(${leadId})`, updates);
    } else {
      // Brand new person — nothing to reconcile against.
      token = crypto.randomBytes(16).toString("hex");
      const created = await dataverseRequest("POST", "cre5b_knowhashleadses", {
        cre5b_name: cleanEmail,
        cre5b_email: cleanEmail,
        cre5b_search_role: title,
        cre5b_lead_source: 342840001, // Website - Position Qualifier
        cre5b_landing_page_token: token,
      });
      leadId = created.cre5b_knowhashleadsid;
    }

    await ensurePersonalQualifier(leadId, roleKey, title);

    return { statusCode: 200, body: JSON.stringify({ token }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Something went wrong", detail: err.message }) };
  }
};
