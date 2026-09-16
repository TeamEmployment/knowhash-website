// netlify/functions/get-reviewer-code.js
//
// Public, read-only endpoint. Returns the current reviewer verification
// code and display message as JSON, for the reviewer-code.html page to
// fetch and render. No auth — this is intentionally public, since it
// only ever exposes a single free-trial activation code with a 30-day
// self-expiry, never anything account- or payment-related.

const { getStore } = require('@netlify/blobs');

// CLI-based deploys don't always auto-inject the Blobs siteID/token into
// the function environment the way git-connected builds do. Fall back to
// explicit credentials from env vars if they're set (Site settings ->
// Environment variables -> NETLIFY_SITE_ID, NETLIFY_BLOBS_TOKEN).
function getReviewerCodeStore() {
  if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    return getStore({
      name: 'reviewer-code',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN,
    });
  }
  return getStore('reviewer-code');
}

exports.handler = async () => {
  try {
    const store = getReviewerCodeStore();
    const record = await store.get('current', { type: 'json' });

    if (!record) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: null,
          message: 'No code has been generated yet.',
        }),
      };
    }

    // Don't serve an expired code.
    if (record.expires && new Date(record.expires) < new Date()) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: null,
          message: 'This test facility has closed.',
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    };
  } catch (err) {
    console.error('Failed to read from Blobs', err);
    return { statusCode: 500, body: 'Storage error' };
  }
};
