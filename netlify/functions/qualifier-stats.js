const { dataverseRequest } = require("./dataverse-client");

// Simple aggregate view for Mission Control — how many Position Qualifier
// tests exist, how many candidates have actually responded, and who the
// most recent respondent was. Read-only, no auth beyond obscurity (same
// posture as the rest of Mission Control's linked pages).
exports.handler = async () => {
  try {
    const qualifiers = await dataverseRequest(
      "GET",
      `cre5b_knowhashpositionqualifiers?$select=cre5b_knowhashpositionqualifierid&$count=true`
    );
    const responses = await dataverseRequest(
      "GET",
      `cre5b_knowhashqualifierresponses?$select=cre5b_candidate_name,createdon,cre5b_position_qualifier&$orderby=createdon desc`
    );

    const responseList = responses.value || [];
    // Distinct qualifiers that have at least one response, to answer
    // "how many tests actually got used" rather than just raw reply count.
    const respondedTo = new Set(responseList.map((r) => r._cre5b_position_qualifier_value)).size;

    const mostRecent = responseList[0]
      ? { candidateName: responseList[0].cre5b_candidate_name || "Unnamed", date: responseList[0].createdon }
      : null;

    return {
      statusCode: 200,
      body: JSON.stringify({
        testsGenerated: qualifiers.value ? qualifiers.value.length : 0,
        totalResponses: responseList.length,
        testsWithAtLeastOneResponse: respondedTo,
        mostRecent,
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Something went wrong" }) };
  }
};
