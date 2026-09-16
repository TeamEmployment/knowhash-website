const { dataverseRequest } = require("./dataverse-client");
const crypto = require("crypto");

// NOTE ON NAVIGATION PROPERTY NAMES:
// The lookup fields below were created with display names "Owner Lead" and
// "Position Qualifier". Dataverse's auto-generated navigation property for a
// custom lookup normally matches the column's Schema Name, which — going by
// this org's existing pattern (e.g. cre5b_role_title, cre5b_candidate_link_token)
// — is expected to be "cre5b_Owner_Lead" and "cre5b_Position_Qualifier".
// This is the one piece of this file that hasn't been confirmed against a live
// call yet — if the very first test throws a 400 mentioning an unrecognized
// property, this is the first place to check (open the table in the maker
// portal, look at the lookup column's "Schema name" field, and correct below).
const OWNER_LEAD_BIND = "cre5b_Owner_Lead@odata.bind";
const POSITION_QUALIFIER_BIND = "cre5b_Position_Qualifier@odata.bind";

const CLAUDE_MODEL = "claude-sonnet-4-6";

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
  const response = await fetch("https://api.anthropic.com/v1/messages", {
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
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Generation call failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  const textBlock = data.content.find((b) => b.type === "text");
  return JSON.parse(textBlock.text);
}

exports.handler = async (event) => {
  try {
    const token = event.queryStringParameters && event.queryStringParameters.token;
    if (!token) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing token" }) };
    }

    // 1. Look up the lead by their landing-page token.
    const leadResult = await dataverseRequest(
      "GET",
      `cre5b_knowhashleadses?$filter=cre5b_landing_page_token eq '${token}'&$select=cre5b_knowhashleadsid,cre5b_title,cre5b_jobpostingtitle,cre5b_company,cre5b_brand_colour,cre5b_brand_logo_url`
    );

    if (!leadResult.value || leadResult.value.length === 0) {
      return { statusCode: 404, body: JSON.stringify({ error: "Link not recognised" }) };
    }
    const lead = leadResult.value[0];

    // 2. Has a qualifier already been generated for this lead? If so, return it
    // as-is — never regenerate on repeat visits.
    const existing = await dataverseRequest(
      "GET",
      `cre5b_knowhashpositionqualifiers?$filter=_cre5b_owner_lead_value eq ${lead.cre5b_knowhashleadsid}`
    );

    let qualifier;
    if (existing.value && existing.value.length > 0) {
      qualifier = existing.value[0];
    } else {
      // 3. First visit: generate now.
      const roleTitle = lead.cre5b_jobpostingtitle || lead.cre5b_title || "the role";
      const generated = await generateQuestions(roleTitle);
      const candidateToken = crypto.randomBytes(16).toString("hex");

      qualifier = await dataverseRequest("POST", "cre5b_knowhashpositionqualifiers", {
        cre5b_role_title: roleTitle,
        cre5b_generated_questions: JSON.stringify(generated),
        cre5b_candidate_link_token: candidateToken,
        [OWNER_LEAD_BIND]: `/cre5b_knowhashleadses(${lead.cre5b_knowhashleadsid})`,
      });
    }

    // 4. Pull any responses already received, for the table view.
    const responses = await dataverseRequest(
      "GET",
      `cre5b_knowhashqualifierresponses?$filter=_cre5b_position_qualifier_value eq ${qualifier.cre5b_knowhashpositionqualifierid}&$select=cre5b_candidate_name,cre5b_candidate_email,createdon&$orderby=createdon desc`
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        roleTitle: qualifier.cre5b_role_title,
        questions: JSON.parse(qualifier.cre5b_generated_questions),
        candidateLinkToken: qualifier.cre5b_candidate_link_token,
        brand: {
          colour: lead.cre5b_brand_colour || null,
          logoUrl: lead.cre5b_brand_logo_url || null,
        },
        responses: responses.value || [],
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Something went wrong" }) };
  }
};
