// qualifier-stats.js
// Mission Control: knowhash Role usage for a chosen window (30 Sep 2026,
// rewritten for the knowhash Role flow). GET ?days=1|7|30|365
//
// Public-by-obscurity like the rest of Mission Control, so it NEVER
// returns private role links or contact details — titles, sources and
// counts only. The private links live in the morning digest email.

const { roleActivity } = require("./role-activity");

exports.handler = async (event) => {
  try {
    const days = Math.min(365, Math.max(1, Number(event.queryStringParameters?.days) || 7));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { totals, roles } = await roleActivity(since);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        days,
        totals,
        roles: roles.map(({ title, source, company, isNew, locked, drafts, docs, email, answers }) =>
          ({ title, source, company, isNew, locked, drafts, docs, email, answers })),
      }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Something went wrong" }) };
  }
};
