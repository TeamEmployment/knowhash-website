// role-doc.js
// Netlify Function — public, read-only view of one knowhash Role document
// (30 Sep 2026), for the share links on /position-qualifier/doc/.
//
// GET ?t=<candidate link token>&d=pd|ad&b=<board>
//
// Uses the role's PUBLIC candidate token (already shared with candidates),
// never the private landing-page token — so a shared document never opens
// the role page or anyone's answers.

const { dataverseRequest } = require("./dataverse-client");

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  try {
    const { t, d, b } = event.queryStringParameters || {};
    if (typeof t !== "string" || !/^[a-f0-9]{16,64}$/.test(t)) return json(400, { error: "invalid_link" });
    if (d !== "pd" && d !== "ad") return json(400, { error: "invalid_link" });

    const r = await dataverseRequest(
      "GET",
      `cre5b_knowhashpositionqualifiers?$filter=cre5b_candidate_link_token eq '${t}'&$select=cre5b_role_title,cre5b_generated_pd,cre5b_generated_ad_copy&$top=1`
    );
    const q = r.value?.[0];
    if (!q) return json(404, { error: "not_found" });

    let doc = null;
    try { doc = JSON.parse(d === "pd" ? q.cre5b_generated_pd : q.cre5b_generated_ad_copy); } catch (_) {}
    if (!doc) return json(404, { error: "not_found" });

    if (d === "ad") {
      const ad = (doc.ads || []).find((a) => a.board === b) || (doc.ads || [])[0];
      if (!ad) return json(404, { error: "not_found" });
      return json(200, { title: q.cre5b_role_title, kind: "ad", board: ad.board, ad });
    }
    return json(200, { title: q.cre5b_role_title, kind: "pd", pd: doc });
  } catch (err) {
    console.error("role-doc error:", err);
    return json(500, { error: "Something went wrong" });
  }
};
