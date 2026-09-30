// qualifier-role.js
// Netlify Function — the "role" endpoint behind the Position Qualifier page
// (29 Sep 2026). Replaces the generate-on-first-visit behaviour of
// qualifier-generate-or-fetch.js (left in place until the new page ships).
//
// PRINCIPLES
//   - Full functionality for everyone; usage is limited, not features.
//   - The unit of usage is ONE ROLE = ONE ROLE TITLE. The title is shown on
//     every document and locks at the FIRST GENERATION (after a warning),
//     not at creation — so prospects can fix a scraped title first.
//   - The server owns the title: every generation uses the stored title,
//     never a title sent by the browser, and the title is stamped onto each
//     document here, not left to the AI.
//   - AI drafts documents. It never scores, ranks or rejects candidates
//     (see knowhash.com/ai).
//
// API (all calls carry ?token=<landing page token> for now; Recruit's
// op- ids and web accounts become further "owner" types later):
//   GET                               → role (created as an unlocked draft on first visit)
//   POST { action: "save", title?, positionText?, detailLevel?, jobBoards?, notifyEmail? }
//   POST { action: "email", doc: "pd"|"ad", board? }  → emails a copy to the notify address
//                                     → saves draft fields (title only while unlocked)
//   POST { action: "generate", doc: "qualifier"|"pd"|"ad", board?, confirmLock? }  (board: ads only, one per draft)
//        - unlocked + no confirmLock  → 409 { needsConfirm: true, title } (page shows the warning)
//        - otherwise                  → locks title (first time), generates that one document

const { dataverseRequest } = require("./dataverse-client");
const crypto = require("crypto");
const { shareUrl, docToText, docToHtml, sendEmail, cleanEmail, NAMES } = require("./role-format");

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_GENERATIONS_PER_ROLE = Number(process.env.QUALIFIER_MAX_GENERATIONS || 10);
const OWNER_LEAD_BIND = "cre5b_owner_lead@odata.bind";

const DETAIL = { brief: 342840000, standard: 342840001, detailed: 342840002 };
const DETAIL_BY_VALUE = Object.fromEntries(Object.entries(DETAIL).map(([k, v]) => [v, k]));
// Order matters: it's the order shown on the page. Seek last — vital in
// Australia, small worldwide.
const BOARDS = ["General", "LinkedIn", "Indeed", "Seek"];

const QUALIFIER_FIELDS = [
  "cre5b_knowhashpositionqualifierid", "cre5b_role_title", "cre5b_position_text",
  "cre5b_detail_level", "cre5b_job_boards", "cre5b_generated_questions",
  "cre5b_generated_pd", "cre5b_generated_ad_copy", "cre5b_title_locked_at",
  "cre5b_generation_count", "cre5b_candidate_link_token", "cre5b_notify_email", "createdon",
].join(",");

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});

function isValidToken(t) {
  return typeof t === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(t); // also keeps it safe inside OData filters
}
function cleanTitle(t) {
  return String(t || "").replace(/\s+/g, " ").trim().slice(0, 197);
}

// Legacy roles (generated before 29 Sep 2026) have questions but no lock
// timestamp — they count as locked.
function isLocked(q) {
  return !!q.cre5b_title_locked_at || !!q.cre5b_generated_questions;
}

// Same priority as qualifier-generate-or-fetch.js: captured job posting
// title > the role typed into Prospect's panel > nothing. Never the
// contact's own headline (cre5b_title).
function proposedTitle(lead) {
  return cleanTitle(lead.cre5b_jobpostingtitle || lead.cre5b_search_role || "");
}

function parseMaybe(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) { return null; }
}

function rolePayload(lead, q, responses) {
  const locked = isLocked(q);
  const used = q.cre5b_generation_count || (q.cre5b_generated_questions ? 1 : 0);
  return {
    title: q.cre5b_role_title || "",
    titleLocked: locked,
    positionText: q.cre5b_position_text || "",
    detailLevel: DETAIL_BY_VALUE[q.cre5b_detail_level] || "standard",
    jobBoards: (q.cre5b_job_boards || "General").split(",").map((s) => s.trim()).filter(Boolean),
    documents: {
      qualifier: parseMaybe(q.cre5b_generated_questions),
      pd: parseMaybe(q.cre5b_generated_pd),
      ad: parseMaybe(q.cre5b_generated_ad_copy),
    },
    generations: { used, max: MAX_GENERATIONS_PER_ROLE },
    candidateLinkToken: q.cre5b_candidate_link_token,
    // Only ever an address this person gave us: their notify email, or the
    // email a website visitor signed up with. Never an enriched Prospect
    // email — a stranger's page showing an address they never gave would
    // feel like surveillance.
    notifyEmail: q.cre5b_notify_email || (lead.cre5b_lead_source === 342840001 ? lead.cre5b_email || "" : ""),
    brand: { colour: lead.cre5b_brand_colour || null, logoUrl: lead.cre5b_brand_logo_url || null },
    isWebsiteLead: lead.cre5b_lead_source === 342840001,
    responses: responses || [],
  };
}

// ── AI prompts ──────────────────────────────────────────────────────────
// Shared rule for all three: the stored title IS the role.
const TITLE_RULE = `The role title given is authoritative. Write only for that role. If the position text describes a different job, follow the title and use only the parts of the text that fit it.`;
const NO_INVENTION = `Never invent facts the user hasn't given: no company name, salary, location, benefits or dates. Where one would naturally go, use a bracketed placeholder such as [Company name] or [Location] so the user can fill it in.`;

const DETAIL_GUIDE = {
  brief: "Keep it short: the essentials only.",
  standard: "Moderate length: thorough but easy to read.",
  detailed: "Comprehensive: cover the role in depth.",
};

const QUALIFIER_PROMPT = `You are building a short, low-pressure candidate experience survey for a recruiter to send to candidates before interview.

${TITLE_RULE}
If position text is provided, base the requirements on it; otherwise use general domain knowledge for this role.

Rules:
- Group requirements into themed sections (Brief: 2-3 sections of 2-3 items; Standard: 3-4 sections; Detailed: 4 sections with fuller coverage). Split by "domain-specific expertise" (skills/tools/experience unique to this exact role's industry) versus "generic/portable" (tooling, certifications, or competencies that would transfer to a similar role elsewhere) as the primary grouping axis - not surface topic similarity. Keep incident-ownership/leadership-style requirements together as their own section if the role has them.
- Never include logistics or working-conditions items (location, days in office, shift pattern).
- Each screening item is Yes/No with one short, plain-English subtext line underneath explaining what it's really asking.
- Include exactly one open-ended scenario question near the end, phrased as "describe a time you..." — note in the survey copy that this is the one the recruiter reads most closely.
- Include one direct willingness/fit question only if the role commonly has a working-condition trade-off candidates might resist (e.g. hands-on vs. purely managerial, on-call, shift work).
- Tone: reassuring, no pass/fail framing, explicit permission to skip what's not their area.
- Section headers get a one-line tagline, not a restatement of the section name.

Respond ONLY with JSON in this exact shape, no other text:
{
  "sections": [
    { "title": "...", "tagline": "...", "items": [
      { "question": "...", "subtext": "...", "type": "yesno" }
    ]}
  ]
}
The final section's final item(s) should have "type": "open" for the scenario question and "type": "yesno" for any willingness check.`;

const PD_PROMPT = `You are drafting a formal position description (PD) that a hiring manager can send internally or attach to a job requisition.

${TITLE_RULE}
${NO_INVENTION}
If position text is provided, base the PD on it; otherwise use general domain knowledge for this role.
Plain, professional English. No hype.

Respond ONLY with JSON in this exact shape, no other text:
{
  "purpose": "one paragraph on why the role exists",
  "sections": [
    { "heading": "Key responsibilities", "items": ["..."] },
    { "heading": "Essential skills and experience", "items": ["..."] },
    { "heading": "Desirable", "items": ["..."] }
  ],
  "reportingLine": "short line, or a placeholder such as [Reports to]"
}
You may add further sections (e.g. "Key relationships", "Qualifications") where they genuinely fit the role.`;

const AD_PROMPT = `You are writing job advertisement copy for the job boards listed.

${TITLE_RULE}
${NO_INVENTION}
If position text is provided, base the ad on it; otherwise use general domain knowledge for this role.
Write to the candidate ("you"), warm and specific, no clichés ("rockstar", "fast-paced environment", "wear many hats").

Per board:
- General: headline, a short opening paragraph, 3-6 bullet points, closing line.
- Seek: include exactly 3 short "selling points" (max ~80 characters each) as well as the body.
- LinkedIn: conversational, slightly shorter body.
- Indeed: plain, scannable, clear responsibilities and requirements.

Respond ONLY with JSON in this exact shape, no other text:
{
  "ads": [
    { "board": "General", "headline": "...", "sellingPoints": [], "intro": "...", "bullets": ["..."], "closing": "..." }
  ]
}
One entry per requested board, in the order given. "sellingPoints" is only filled for Seek (empty array otherwise).`;

async function callClaude(system, userText, maxTokens) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 35000);
  let response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: userText }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Generation timed out after 35s");
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) throw new Error(`Generation failed (${response.status}): ${await response.text()}`);
  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  const cleaned = textBlock.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(cleaned);
}

function briefFor(q, extra) {
  const detail = DETAIL_BY_VALUE[q.cre5b_detail_level] || "standard";
  return [
    `Role title: ${q.cre5b_role_title}`,
    `Detail level: ${detail} — ${DETAIL_GUIDE[detail]}`,
    extra || "",
    q.cre5b_position_text ? `Position text:\n${q.cre5b_position_text}` : "No position text provided.",
  ].filter(Boolean).join("\n\n");
}

async function generateDoc(doc, q, opts = {}) {
  if (doc === "qualifier") {
    return callClaude(QUALIFIER_PROMPT, briefFor(q), 2000);
  }
  if (doc === "pd") {
    const out = await callClaude(PD_PROMPT, briefFor(q), 2500);
    return { title: q.cre5b_role_title, ...out }; // server-stamped title
  }
  if (doc === "ad") {
    // ONE board per generation (30 Sep 2026) — each board's ad costs one
    // draft, and ads for other boards are kept alongside, not replaced.
    const board = BOARDS.includes(opts.board) ? opts.board : "General";
    const out = await callClaude(AD_PROMPT, briefFor(q, `Job boards: ${board}`), 1900);
    const fresh = { ...((out.ads || [])[0] || {}), board, roleTitle: q.cre5b_role_title };
    const prev = parseMaybe(q.cre5b_generated_ad_copy);
    const others = (prev?.ads || []).filter((a) => a.board !== board);
    const ads = [...others, fresh].sort((a, b) => BOARDS.indexOf(a.board) - BOARDS.indexOf(b.board));
    // Server-stamped title on every ad, whatever headline the AI wrote.
    return { title: q.cre5b_role_title, ads };
  }
  throw new Error("unknown_doc");
}
const DOC_COLUMN = { qualifier: "cre5b_generated_questions", pd: "cre5b_generated_pd", ad: "cre5b_generated_ad_copy" };

// ── handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  try {
    const token = event.queryStringParameters?.token;
    if (!isValidToken(token)) return json(400, { error: "invalid_token" });

    const leadResult = await dataverseRequest(
      "GET",
      `cre5b_knowhashleadses?$filter=cre5b_landing_page_token eq '${token}'&$select=cre5b_knowhashleadsid,cre5b_jobpostingtitle,cre5b_search_role,cre5b_brand_colour,cre5b_brand_logo_url,cre5b_ad_text,cre5b_lead_source,cre5b_email`
    );
    const lead = leadResult.value?.[0];
    if (!lead) return json(404, { error: "Link not recognised" });

    // The lead's one free role (step 3 adds Recruit/web owners with more).
    const existing = await dataverseRequest(
      "GET",
      `cre5b_knowhashpositionqualifiers?$filter=_cre5b_owner_lead_value eq ${lead.cre5b_knowhashleadsid}&$select=${QUALIFIER_FIELDS}&$orderby=createdon asc&$top=1`
    );
    let q = existing.value?.[0];

    if (!q) {
      // First visit: create an UNLOCKED draft — no AI call yet.
      q = await dataverseRequest("POST", `cre5b_knowhashpositionqualifiers?$select=${QUALIFIER_FIELDS}`, {
        cre5b_role_title: proposedTitle(lead),
        cre5b_position_text: lead.cre5b_ad_text || null,
        cre5b_detail_level: DETAIL.standard,
        cre5b_job_boards: "General",
        cre5b_generation_count: 0,
        cre5b_candidate_link_token: crypto.randomBytes(16).toString("hex"),
        [OWNER_LEAD_BIND]: `/cre5b_knowhashleadses(${lead.cre5b_knowhashleadsid})`,
      });
    }
    const qid = q.cre5b_knowhashpositionqualifierid;

    const loadResponses = async () => (await dataverseRequest(
      "GET",
      `cre5b_knowhashqualifierresponses?$filter=_cre5b_position_qualifier_value eq ${qid}&$select=cre5b_candidate_name,cre5b_candidate_email,cre5b_answers,createdon&$orderby=createdon desc`
    )).value;

    if (event.httpMethod === "GET") {
      return json(200, rolePayload(lead, q, await loadResponses()));
    }
    if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

    const body = JSON.parse(event.body || "{}");

    // ── save draft fields ──
    if (body.action === "save") {
      const patch = {};
      if (typeof body.title === "string") {
        if (isLocked(q)) {
          if (cleanTitle(body.title) !== q.cre5b_role_title) return json(403, { error: "title_locked" });
        } else {
          const t = cleanTitle(body.title);
          if (!t) return json(400, { error: "title_required" });
          patch.cre5b_role_title = t;
        }
      }
      if (typeof body.positionText === "string") patch.cre5b_position_text = body.positionText.slice(0, 20000);
      if (body.detailLevel && DETAIL[body.detailLevel]) patch.cre5b_detail_level = DETAIL[body.detailLevel];
      if (Array.isArray(body.jobBoards)) {
        const b = body.jobBoards.filter((x) => BOARDS.includes(x));
        patch.cre5b_job_boards = (b.length ? b : ["General"]).join(", ");
      }
      if (typeof body.notifyEmail === "string") {
        if (body.notifyEmail.trim() === "") {
          patch.cre5b_notify_email = null;
        } else {
          const e = cleanEmail(body.notifyEmail);
          if (!e) return json(400, { error: "invalid_email" });
          patch.cre5b_notify_email = e;
          // Populate the lead record if we don't have an address for them yet.
          if (!lead.cre5b_email) {
            await dataverseRequest("PATCH", `cre5b_knowhashleadses(${lead.cre5b_knowhashleadsid})`, { cre5b_email: e });
            lead.cre5b_email = e;
          }
        }
      }
      if (Object.keys(patch).length) {
        await dataverseRequest("PATCH", `cre5b_knowhashpositionqualifiers(${qid})`, patch);
        q = { ...q, ...patch };
      }
      return json(200, rolePayload(lead, q, await loadResponses()));
    }

    // ── generate one document ──
    if (body.action === "generate") {
      const doc = body.doc;
      if (!DOC_COLUMN[doc]) return json(400, { error: "unknown_doc" });
      if (!q.cre5b_role_title) return json(400, { error: "title_required" });

      if (!isLocked(q) && body.confirmLock !== true) {
        // The page shows: "Your free role will be locked to '<title>'…"
        return json(409, { needsConfirm: true, title: q.cre5b_role_title });
      }
      const used = q.cre5b_generation_count || (q.cre5b_generated_questions ? 1 : 0);
      if (used >= MAX_GENERATIONS_PER_ROLE) {
        return json(429, { error: "generation_limit", used, max: MAX_GENERATIONS_PER_ROLE });
      }

      const generated = await generateDoc(doc, q, { board: body.board });
      const patch = {
        [DOC_COLUMN[doc]]: JSON.stringify(generated),
        cre5b_generation_count: used + 1,
      };
      if (!q.cre5b_title_locked_at) patch.cre5b_title_locked_at = new Date().toISOString();
      if (doc === "ad" && BOARDS.includes(body.board)) patch.cre5b_job_boards = body.board; // last board used
      await dataverseRequest("PATCH", `cre5b_knowhashpositionqualifiers(${qid})`, patch);
      q = { ...q, ...patch };
      return json(200, rolePayload(lead, q, await loadResponses()));
    }

    // ── email a copy of one document to the notify address ──
    if (body.action === "email") {
      const doc = body.doc;
      if (doc !== "pd" && doc !== "ad") return json(400, { error: "unknown_doc" });
      const to = q.cre5b_notify_email || (lead.cre5b_lead_source === 342840001 ? cleanEmail(lead.cre5b_email) : null);
      if (!to) return json(400, { error: "no_email" });
      const stored = parseMaybe(q[DOC_COLUMN[doc]]);
      const board = doc === "ad" ? body.board : null;
      if (!stored || (doc === "ad" && !(stored.ads || []).some((a) => a.board === board))) return json(404, { error: "no_document" });
      const title = q.cre5b_role_title;
      const link = shareUrl(q.cre5b_candidate_link_token, doc, board);
      const label = doc === "ad" ? `${NAMES.ad} (${board})` : NAMES[doc];
      await sendEmail({
        to,
        subject: `${label} — ${title}`,
        text: `${docToText(doc, title, stored, board)}\n\n—\nShare this ${label.toLowerCase()}: ${link}\nMade with knowhash Role — https://knowhash.com/position-qualifier/`,
        html: `${docToHtml(doc, title, stored, board)}
<p style="font-family:-apple-system,Segoe UI,sans-serif;font-size:13px;color:#58595b;margin-top:24px;border-top:1px solid #E5E8EE;padding-top:14px">
Share it: <a href="${link}" style="color:#0D5C63;font-weight:600">${link}</a><br>
<span style="color:#9aa3b0">Made with <a href="https://knowhash.com/position-qualifier/" style="color:#9aa3b0">knowhash Role</a></span></p>`,
      });
      return json(200, { sent: true, to });
    }

    return json(400, { error: "unknown_action" });
  } catch (err) {
    console.error("qualifier-role error:", err);
    return json(500, { error: "Something went wrong", detail: err.message });
  }
};
