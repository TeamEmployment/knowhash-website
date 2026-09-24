const { dataverseRequest } = require("./dataverse-client");
const crypto = require("crypto");

const CLAUDE_MODEL = "claude-sonnet-4-6";

// Never trust a client-supplied title string for this endpoint — it has no
// auth and no lead behind it, so only these ten keys are ever generated
// against. Keep in sync with the dropdown in position-qualifier/index.html.
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

// Same prompt as qualifier-generate-or-fetch.js's real pipeline, duplicated
// rather than shared — these functions are each self-contained, matching
// the rest of this folder.
const GENERATION_SYSTEM_PROMPT = `You are building a short, low-pressure candidate experience survey from a job title, for a recruiter to send to candidates before interview. No job description is available — use general domain knowledge for this role.

Rules:
- Group requirements into 3-4 themed sections. Split by "domain-specific expertise" (skills/tools/experience unique to this exact role's industry) versus "generic/portable" (tooling, certifications, or competencies that would transfer to a similar role elsewhere) as the primary grouping axis - not surface topic similarity. Keep incident-ownership/leadership-style requirements together as their own section if the role has them.
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

async function generateQuestions(roleTitle) {
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
        max_tokens: 1500,
        system: GENERATION_SYSTEM_PROMPT,
        messages: [{ role: "user", content: `Role title: ${roleTitle}` }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Generation call timed out after 35s — likely rate-limited or Anthropic API is slow right now");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Generation call failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  const cleaned = textBlock.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(cleaned);
}

// Each generic title gets one permanent, obviously-synthetic "template" lead
// that only exists to anchor the cached qualifier row — never a real prospect,
// never emailed, never shown in normal pipeline views (Withdrawn status, a
// reserved @internal.knowhash.com address no real visitor could ever submit).
function templateEmailFor(key) {
  return `template-${key}@internal.knowhash.com`;
}

async function findOrCreateTemplateLead(key, title) {
  const email = templateEmailFor(key);
  const existing = await dataverseRequest(
    "GET",
    `cre5b_knowhashleadses?$filter=cre5b_email eq '${email}'&$select=cre5b_knowhashleadsid`
  );
  if (existing.value && existing.value.length > 0) {
    return existing.value[0].cre5b_knowhashleadsid;
  }
  const created = await dataverseRequest("POST", "cre5b_knowhashleadses", {
    cre5b_name: `Template — ${title}`,
    cre5b_email: email,
    cre5b_search_role: title,
    cre5b_lead_source: 342840001, // Website - Position Qualifier
    cre5b_outreachstatus: 342840008, // Withdrawn — keeps it out of active pipeline views
    cre5b_notes: "Auto-created cache anchor for the free Position Qualifier preview. Not a real prospect — do not contact.",
  });
  return created.cre5b_knowhashleadsid;
}

exports.handler = async (event) => {
  try {
    const key = event.queryStringParameters && event.queryStringParameters.role;
    const title = GENERIC_ROLES[key];
    if (!title) {
      return { statusCode: 400, body: JSON.stringify({ error: "Unknown role key" }) };
    }

    const leadId = await findOrCreateTemplateLead(key, title);

    const existing = await dataverseRequest(
      "GET",
      `cre5b_knowhashpositionqualifiers?$filter=_cre5b_owner_lead_value eq ${leadId}&$select=cre5b_generated_questions`
    );

    if (existing.value && existing.value.length > 0) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          roleTitle: title,
          questions: JSON.parse(existing.value[0].cre5b_generated_questions),
          cached: true,
        }),
      };
    }

    // First person globally to preview this title — generate once, cache forever.
    const generated = await generateQuestions(title);
    await dataverseRequest("POST", "cre5b_knowhashpositionqualifiers", {
      cre5b_role_title: title,
      cre5b_generated_questions: JSON.stringify(generated),
      cre5b_candidate_link_token: crypto.randomBytes(16).toString("hex"), // unused — this row is never shared as a real link
      "cre5b_owner_lead@odata.bind": `/cre5b_knowhashleadses(${leadId})`,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ roleTitle: title, questions: generated, cached: false }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Something went wrong", detail: err.message }) };
  }
};
