const { dataverseRequest } = require("./dataverse-client");

// Same navigation-property caveat as qualifier-generate-or-fetch.js — verify
// this against the real Schema Name on first live test.
const POSITION_QUALIFIER_BIND = "cre5b_Position_Qualifier@odata.bind";

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
        `cre5b_knowhashpositionqualifiers?$filter=cre5b_candidate_link_token eq '${token}'&$select=cre5b_knowhashpositionqualifierid,cre5b_role_title,cre5b_generated_questions`
      );

      if (!result.value || result.value.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ error: "Link not recognised" }) };
      }
      const qualifier = result.value[0];

      return {
        statusCode: 200,
        body: JSON.stringify({
          roleTitle: qualifier.cre5b_role_title,
          questions: JSON.parse(qualifier.cre5b_generated_questions),
        }),
      };
    }

    if (event.httpMethod === "POST") {
      // Candidate submitting their answers.
      const { token, candidateName, candidateEmail, answers } = JSON.parse(event.body || "{}");
      if (!token || !answers) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing token or answers" }) };
      }

      const result = await dataverseRequest(
        "GET",
        `cre5b_knowhashpositionqualifiers?$filter=cre5b_candidate_link_token eq '${token}'&$select=cre5b_knowhashpositionqualifierid`
      );
      if (!result.value || result.value.length === 0) {
        return { statusCode: 404, body: JSON.stringify({ error: "Link not recognised" }) };
      }
      const qualifierId = result.value[0].cre5b_knowhashpositionqualifierid;

      await dataverseRequest("POST", "cre5b_knowhashqualifierresponses", {
        cre5b_candidate_name: candidateName || null,
        cre5b_candidate_email: candidateEmail || null,
        cre5b_answers: JSON.stringify(answers),
        [POSITION_QUALIFIER_BIND]: `/cre5b_knowhashpositionqualifiers(${qualifierId})`,
      });

      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Something went wrong" }) };
  }
};
