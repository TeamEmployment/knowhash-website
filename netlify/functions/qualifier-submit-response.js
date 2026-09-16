const { dataverseRequest } = require("./dataverse-client");

// Confirmed directly against Dataverse's own metadata — navigation property
// matches the logical name exactly, lowercase with underscores.
const POSITION_QUALIFIER_BIND = "cre5b_position_qualifier@odata.bind";

async function sendNotificationEmail(toEmail, candidateName, landingPageToken, roleTitle) {
  if (!toEmail || !landingPageToken) return; // nothing to notify, or nowhere to send them
  const landingUrl = `https://knowhash.com/position-qualifier/?token=${landingPageToken}`;

  await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail }] }],
      from: { email: "notifications@knowhash.com", name: "knowhash" },
      subject: `New response — ${roleTitle}`,
      content: [{
        type: "text/plain",
        value: `${candidateName || "A candidate"} just completed your Position Qualifier for ${roleTitle}.\n\nView it here: ${landingUrl}`,
      }],
    }),
  });
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") {
      // Candidate loading the page: fetch the qualifier's questions by their token.
      const token = event.queryStringParameters && event.queryStringParameters.token;
      if (!token) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing token" }) };
      }

      const result = await dataverseRequest(
        "GET",
        `cre5b_knowhashpositionqualifiers?$filter=cre5b_candidate_link_token eq '${token}'&$select=cre5b_knowhashpositionqualifierid,cre5b_role_title,cre5b_generated_questions,_cre5b_owner_lead_value`
      );

      if (!result.value || result.value.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ error: "Link not recognised" }) };
      }
      const qualifier = result.value[0];

      // Pull who this is actually from, so the candidate can reconcile it
      // against whoever they connected with.
      let recruiterName = null;
      let company = null;
      const leadId = qualifier._cre5b_owner_lead_value;
      if (leadId) {
        const leadResult = await dataverseRequest(
          "GET",
          `cre5b_knowhashleadses(${leadId})?$select=cre5b_name,cre5b_company`
        );
        recruiterName = leadResult.cre5b_name || null;
        company = leadResult.cre5b_company || null;
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          roleTitle: qualifier.cre5b_role_title,
          questions: JSON.parse(qualifier.cre5b_generated_questions),
          recruiterName,
          company,
        }),
      };
    }

    if (event.httpMethod === "POST") {
      // Candidate submitting their answers.
      const { token, candidateName, candidateEmail, answers } = JSON.parse(event.body || "{}");
      if (!token || !answers) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing token or answers" }) };
      }

      // Pull the qualifier plus enough to notify its owner afterwards.
      const result = await dataverseRequest(
        "GET",
        `cre5b_knowhashpositionqualifiers?$filter=cre5b_candidate_link_token eq '${token}'&$select=cre5b_knowhashpositionqualifierid,cre5b_role_title,_cre5b_owner_lead_value`
      );
      if (!result.value || result.value.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ error: "Link not recognised" }) };
      }
      const qualifier = result.value[0];

      await dataverseRequest("POST", "cre5b_knowhashqualifierresponses", {
        cre5b_candidate_name: candidateName || null,
        cre5b_candidate_email: candidateEmail || null,
        cre5b_answers: JSON.stringify(answers),
        [POSITION_QUALIFIER_BIND]: `/cre5b_knowhashpositionqualifiers(${qualifier.cre5b_knowhashpositionqualifierid})`,
      });

      // Notify the recruiter — best-effort, never block the candidate's success on this.
      try {
        const leadId = qualifier._cre5b_owner_lead_value;
        if (leadId) {
          const leadResult = await dataverseRequest(
            "GET",
            `cre5b_knowhashleadses(${leadId})?$select=cre5b_email,cre5b_landing_page_token`
          );
          await sendNotificationEmail(
            leadResult.cre5b_email,
            candidateName,
            leadResult.cre5b_landing_page_token,
            qualifier.cre5b_role_title
          );
        }
      } catch (notifyErr) {
        console.error("Notification email failed (response was still saved):", notifyErr);
      }

      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Something went wrong" }) };
  }
};
