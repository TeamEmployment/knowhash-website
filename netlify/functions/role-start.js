// role-start.js
// Netlify Function — start a free knowhash Role from the website.
// 30 Sep 2026 (v2): NO email up front. The visitor types a role title,
// passes reCAPTCHA, and goes straight to their role page. We ask for an
// email later, on the role page, when it's obviously useful ("email me my
// link", candidates' answers, copies of documents).
//
// POST { title, recaptchaToken } → { token }
//
// Safe to return the token: it's for a brand-new lead that only this
// visitor knows about. (The old claim-free gap was returning EXISTING
// leads' tokens for a typed email — nothing here looks anyone up.)
//
// Cost protection: reCAPTCHA, plus a site-wide hourly cap on new anonymous
// roles (ROLE_START_HOURLY_CAP, default 30), so a determined bot can't run
// up the AI bill. Each role is still capped at 10 drafts.

const { dataverseRequest } = require("./dataverse-client");
const crypto = require("crypto");
const { verifyRecaptcha } = require("./role-format");

const HOURLY_CAP = Number(process.env.ROLE_START_HOURLY_CAP || 30);
const WEBSITE_SOURCE = 342840001; // Website - Position Qualifier

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
    const { title, recaptchaToken } = JSON.parse(event.body || "{}");

    if (!(await verifyRecaptcha(recaptchaToken, "role_start"))) {
      return json(403, { error: "We couldn\u2019t confirm you\u2019re not a robot \u2014 please refresh the page and try again." });
    }
    const cleanTitle = String(title || "").replace(/\s+/g, " ").trim().slice(0, 197);
    if (!cleanTitle) return json(400, { error: "Enter the role you're hiring for" });

    // Site-wide hourly cap on anonymous starts.
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const recent = await dataverseRequest(
      "GET",
      `cre5b_knowhashleadses?$filter=cre5b_lead_source eq ${WEBSITE_SOURCE} and createdon ge ${since}&$select=cre5b_knowhashleadsid&$top=${HOURLY_CAP + 1}`
    );
    if ((recent.value || []).length >= HOURLY_CAP) {
      console.warn("role-start: hourly cap reached");
      return json(429, { error: "We\u2019re very busy right now \u2014 please try again in a little while." });
    }

    const token = crypto.randomBytes(16).toString("hex");
    const label = `Website visitor \u2014 ${cleanTitle}`.slice(0, 100);
    await dataverseRequest("POST", "cre5b_knowhashleadses", {
      cre5b_name: label,
      cre5b_newcolumn: label,
      cre5b_search_role: cleanTitle,
      cre5b_lead_source: WEBSITE_SOURCE,
      cre5b_landing_page_token: token,
    });
    return json(200, { token });
  } catch (err) {
    console.error("role-start error:", err);
    return json(500, { error: "Something went wrong \u2014 please try again shortly." });
  }
};
