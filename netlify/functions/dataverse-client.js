// Shared helper: authenticate to Dataverse via Entra ID client-credentials flow,
// then make Web API calls. No Power Automate involved — this talks to Dataverse directly.

const DATAVERSE_URL = "https://orga8253c22.crm6.dynamics.com";

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  // Reuse a cached token until shortly before it expires, so we're not
  // authenticating on every single request.
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry - 60000) {
    return cachedToken;
  }

  const tenantId = process.env.DATAVERSE_TENANT_ID;
  const clientId = process.env.DATAVERSE_CLIENT_ID;
  const clientSecret = process.env.DATAVERSE_CLIENT_SECRET;

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: `${DATAVERSE_URL}/.default`,
    grant_type: "client_credentials",
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dataverse auth failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = now + data.expires_in * 1000;
  return cachedToken;
}

// path is relative to /api/data/v9.2/, e.g. "cre5b_knowhashleadses?$filter=..."
async function dataverseRequest(method, path, body) {
  const token = await getAccessToken();
  const response = await fetch(`${DATAVERSE_URL}/api/data/v9.2/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "OData-MaxVersion": "4.0",
      "OData-Version": "4.0",
      // Ask Dataverse to return the created/updated record's representation,
      // so we don't need a second round-trip to read it back.
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Dataverse request failed (${response.status}) on ${path}: ${text}`);
  }

  if (response.status === 204) return null; // no content, e.g. some updates
  return response.json();
}

module.exports = { dataverseRequest };
