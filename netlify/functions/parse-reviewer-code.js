// netlify/functions/parse-reviewer-code.js
//
// Receives the SendGrid Inbound Parse webhook for reviewer@knowhash.com.
// SendGrid POSTs as multipart/form-data with fields including "subject",
// "from", "to", "text". We pull the 6-digit code out of the subject line
// (matches "123456 is your knowhash verification code") and store it,
// along with a display message, in Netlify Blobs for the public status
// page to read.
//
// Configure in SendGrid: Settings -> Inbound Parse -> Add Host & URL
//   Subdomain: reviewer   Domain: knowhash.com
//   Destination URL: https://knowhash.com/.netlify/functions/parse-reviewer-code

const Busboy = require('busboy');
const { getStore } = require('@netlify/blobs');

// See get-reviewer-code.js for why this fallback exists.
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

// Only accept mail actually addressed to the reviewer alias, and only
// from our own verification sender, so this can't be triggered by
// random inbound spam to the subdomain.
const EXPECTED_TO = 'reviewer.knowhash.com';
const EXPECTED_FROM = 'noreply@knowhash.com';

const EXPIRY_DAYS = 30;

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const fields = {};

    const contentType =
      event.headers['content-type'] || event.headers['Content-Type'];

    if (!contentType) {
      reject(new Error('Missing content-type header'));
      return;
    }

    const busboy = Busboy({ headers: { 'content-type': contentType } });

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    // Inbound Parse can also include file parts (attachments). We don't
    // need them, so just drain and discard.
    busboy.on('file', (name, stream) => {
      stream.resume();
    });

    busboy.on('finish', () => resolve(fields));
    busboy.on('error', reject);

    const body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body || '', 'utf8');

    busboy.end(body);
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let fields;
  try {
    fields = await parseMultipart(event);
  } catch (err) {
    console.error('Failed to parse inbound email payload', err);
    return { statusCode: 400, body: 'Bad request' };
  }

  const to = (fields.to || '').toLowerCase();
  const from = (fields.from || '').toLowerCase();
  const subject = fields.subject || '';

  if (!to.includes(EXPECTED_TO) || !from.includes(EXPECTED_FROM)) {
    // Not the email we're looking for — accept and ignore, so SendGrid
    // doesn't retry, but don't touch stored state.
    console.log('Ignoring inbound email', { to, from, subject });
    return { statusCode: 200, body: 'Ignored' };
  }

  // Subject is formatted "123456 is your knowhash verification code"
  const match = subject.match(/\b(\d{6})\b/);
  if (!match) {
    console.error('No 6-digit code found in subject', subject);
    return { statusCode: 200, body: 'No code found' };
  }

  const code = match[1];
  const now = new Date();
  const expires = new Date(now.getTime() + EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const record = {
    code,
    message:
      'This code was generated for Chrome Web Store review. This facility ' +
      'will be closed once approval is complete, or within 30 days.',
    updated: now.toISOString(),
    expires: expires.toISOString(),
  };

  try {
    const store = getReviewerCodeStore();
    await store.setJSON('current', record);
  } catch (err) {
    console.error('Failed to write to Blobs', err);
    return { statusCode: 500, body: 'Storage error' };
  }

  return { statusCode: 200, body: 'OK' };
};
