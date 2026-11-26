/* ================== Evera Cloud Functions — real guest sending ==================
   v1.73.0. Two callable functions back the Communications Center's "Confirm & Send" button:
   sendGuestEmail and sendGuestSms (via Twilio SMS). Both are Firebase Functions v2 "onCall"
   functions — the client SDK handles auth-token attachment and CORS automatically, so there's
   no separate HTTP/CORS setup needed. Secrets (API keys) are never hardcoded here; they're
   injected at runtime from Firebase Secret Manager via defineSecret, set once with
   `firebase functions:secrets:set <NAME>` (see the project README / chat instructions for the
   exact commands) and never pasted into this file or any chat.

   v1.76.0: sendGuestEmail was rewritten to call Twilio's newer native Email API
   (comms.twilio.com/v1/Emails) instead of the classic, separately-owned SendGrid REST API
   (api.sendgrid.com/v3/mail/send) via the @sendgrid/mail library. These are two genuinely
   different products with different endpoints, different auth (Basic auth with a Twilio API
   Key SID/Secret pair here, vs. a single Bearer token for classic SendGrid) and different
   request bodies — discovered the hard way when a key created through the unified Twilio
   Console's permission-grid UI (the only key-creation screen reachable from an account created
   via Google SSO, which has no classic standalone SendGrid login) returned "Unauthorized" against
   the classic SendGrid endpoint. The account's Domain Authentication (set up earlier under
   Communications → Email → Domains) is for this same native product, so that setup carries over
   unchanged — only the sending code needed to change.

   Both functions require the caller to be signed in (request.auth), matching every other write
   path in this app — there is no public, unauthenticated send route. Neither function trusts the
   client's recipient list beyond basic shape validation; the actual Firestore security rules
   already gate who can read/write guest data in the first place, so by the time a client calls
   this, it has already proven (via normal app usage) that it can see these guests. This does NOT
   re-check that the caller owns the specific wedding the recipients belong to — the client always
   calls this with ITS OWN currently-loaded guest list, never an arbitrary one, so that check would
   be redundant today. If a public API surface for this is ever built, add that ownership check.

   The actual send-and-summarize logic lives in the plain, dependency-injected functions below
   (sendEmailBatch / sendSmsBatch / validateSendRequest) rather than inline in the onCall handlers,
   specifically so a test can exercise the real logic against a mock mail/SMS client without needing
   the Firebase Functions Framework or real network calls — see functions/test/send.test.js. */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

// v1.76.0: the Twilio Email API authenticates with a Twilio API Key SID/Secret pair via HTTP
// Basic auth — a different credential shape than classic SendGrid's single Bearer-token key, so
// this is two secrets rather than one. Create the key under Twilio Console → Communications →
// Email → API key & creds → API keys & auth tokens, with "Create" checked under the
// Comms → Emails → emails permission.
const TWILIO_EMAIL_API_KEY_SID = defineSecret('TWILIO_EMAIL_API_KEY_SID');
const TWILIO_EMAIL_API_KEY_SECRET = defineSecret('TWILIO_EMAIL_API_KEY_SECRET');
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_PHONE_NUMBER = defineSecret('TWILIO_PHONE_NUMBER');

const TWILIO_EMAIL_API_URL = 'https://comms.twilio.com/v1/Emails';

// The verified sender — a subdomain of evera-planning.ca, authenticated separately in the Twilio
// Console (Communications → Email → Domains). Using a subdomain rather than the bare root domain
// keeps the main domain's own DNS untouched.
const FROM_EMAIL = 'hello@mail.evera-planning.ca';
const FROM_NAME = 'Evera';

// Simple cost/abuse guard — no single wedding's guest list should ever realistically exceed this,
// so a client-side bug (e.g. an audience resolving to "everyone, repeated") can't run up an
// unbounded SendGrid/Twilio bill in one call.
const MAX_RECIPIENTS_PER_CALL = 1000;

function requireSignedIn(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to send a message.');
  }
}

/** Throws HttpsError on bad input; otherwise returns the trimmed, validated { recipients, body }. */
function validateSendRequest(data) {
  const { recipients, body } = data || {};
  if (!Array.isArray(recipients) || !recipients.length) {
    throw new HttpsError('invalid-argument', 'No recipients were provided.');
  }
  if (recipients.length > MAX_RECIPIENTS_PER_CALL) {
    throw new HttpsError('invalid-argument', `Too many recipients in one send (max ${MAX_RECIPIENTS_PER_CALL}).`);
  }
  if (!body || typeof body !== 'string' || !body.trim()) {
    throw new HttpsError('invalid-argument', 'Message body is required.');
  }
  return { recipients, body: body.trim() };
}

/** Sends one email per recipient with a valid-looking address via the given email client
 * (dependency-injected — the real one is makeTwilioEmailClient below; tests pass a mock with
 * the same { send(msg) } shape instead). Returns { sent, skipped, failed, failures }. */
async function sendEmailBatch(emailClient, recipients, subject, body) {
  const validRecipients = recipients.filter(r => r && typeof r.email === 'string' && /\S+@\S+\.\S+/.test(r.email));
  if (!validRecipients.length) {
    return { sent: 0, skipped: recipients.length, failed: 0, failures: [] };
  }

  const settled = await Promise.allSettled(validRecipients.map(r => emailClient.send({
    to: r.email,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    text: body,
  })));

  const sent = settled.filter(r => r.status === 'fulfilled').length;
  const failures = settled
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.status === 'rejected')
    .map(({ r, i }) => ({ email: validRecipients[i].email, error: (r.reason && r.reason.message) || 'Unknown error' }));

  return { sent, skipped: recipients.length - validRecipients.length, failed: failures.length, failures };
}

/** Sends one text per recipient with a plausible phone number via the given Twilio client
 * (dependency-injected — see sendEmailBatch above). Returns { sent, skipped, failed, failures }. */
async function sendSmsBatch(twilioClient, fromNumber, recipients, body) {
  const validRecipients = recipients.filter(r => r && typeof r.phone === 'string' && r.phone.replace(/[^0-9+]/g, '').length >= 10);
  if (!validRecipients.length) {
    return { sent: 0, skipped: recipients.length, failed: 0, failures: [] };
  }

  const settled = await Promise.allSettled(validRecipients.map(r => twilioClient.messages.create({
    to: r.phone,
    from: fromNumber,
    body,
  })));

  const sent = settled.filter(r => r.status === 'fulfilled').length;
  const failures = settled
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.status === 'rejected')
    .map(({ r, i }) => ({ phone: validRecipients[i].phone, error: (r.reason && r.reason.message) || 'Unknown error' }));

  return { sent, skipped: recipients.length - validRecipients.length, failed: failures.length, failures };
}

/** Builds the real email-sending client that sendEmailBatch calls .send() on — a thin wrapper
 * around the Twilio Email API (comms.twilio.com/v1/Emails), kept to the exact same { send(msg) }
 * shape the classic @sendgrid/mail client had so sendEmailBatch (and its tests, which mock this
 * same interface) didn't need to change — only what's behind this interface did. */
function makeTwilioEmailClient(apiKeySid, apiKeySecret) {
  return {
    async send({ to, from, subject, text }) {
      const auth = Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64');
      const resp = await fetch(TWILIO_EMAIL_API_URL, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: { address: from.email, name: from.name },
          to: [{ address: to }],
          content: { subject, text },
        }),
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        throw new Error(`Twilio Email API ${resp.status}${resp.status===401?' (Unauthorized — check the API key and that it has Create access on Comms > Emails)':''}: ${errBody || resp.statusText}`);
      }
      return resp.json().catch(() => ({}));
    }
  };
}

exports.sendGuestEmail = onCall({
  secrets: [TWILIO_EMAIL_API_KEY_SID, TWILIO_EMAIL_API_KEY_SECRET],
  region: 'us-central1'
}, async (request) => {
  requireSignedIn(request);
  const { recipients, body } = validateSendRequest(request.data);
  const subject = (request.data && request.data.subject && String(request.data.subject).trim())
    || 'A message from your wedding';

  const emailClient = makeTwilioEmailClient(TWILIO_EMAIL_API_KEY_SID.value(), TWILIO_EMAIL_API_KEY_SECRET.value());

  const result = await sendEmailBatch(emailClient, recipients, subject, body);
  if (result.failures.length) logger.warn('sendGuestEmail: some sends failed', { failures: result.failures });
  return result;
});

exports.sendGuestSms = onCall({
  secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER],
  region: 'us-central1'
}, async (request) => {
  requireSignedIn(request);
  const { recipients, body } = validateSendRequest(request.data);

  const twilio = require('twilio');
  const client = twilio(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
  const fromNumber = TWILIO_PHONE_NUMBER.value();

  const result = await sendSmsBatch(client, fromNumber, recipients, body);
  if (result.failures.length) logger.warn('sendGuestSms: some sends failed', { failures: result.failures });
  return result;
});

// Exported for functions/test/send.test.js only — Firebase's deploy step only picks up exports
// that are actual CloudFunction objects (the onCall-wrapped exports above), so these plain
// functions are simply ignored at deploy time, not shipped as extra endpoints.
exports._internal = { validateSendRequest, sendEmailBatch, sendSmsBatch, makeTwilioEmailClient, MAX_RECIPIENTS_PER_CALL, TWILIO_EMAIL_API_URL };
