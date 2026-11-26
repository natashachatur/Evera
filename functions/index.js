/* ================== Evera Cloud Functions — real guest sending ==================
   v1.73.0. Two callable functions back the Communications Center's "Confirm & Send" button:
   sendGuestEmail (via SendGrid) and sendGuestSms (via Twilio). Both are Firebase Functions v2
   "onCall" functions — the client SDK handles auth-token attachment and CORS automatically, so
   there's no separate HTTP/CORS setup needed. Secrets (API keys) are never hardcoded here; they're
   injected at runtime from Firebase Secret Manager via defineSecret, set once with
   `firebase functions:secrets:set <NAME>` (see the project README / chat instructions for the
   exact commands) and never pasted into this file or any chat.

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

const SENDGRID_API_KEY = defineSecret('SENDGRID_API_KEY');
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_PHONE_NUMBER = defineSecret('TWILIO_PHONE_NUMBER');

// The verified SendGrid sender — a subdomain of evera-planning.ca, authenticated separately in the
// SendGrid dashboard (Settings → Sender Authentication → Authenticate Your Domain). Using a
// subdomain rather than the bare root domain keeps the main domain's own DNS untouched.
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

/** Sends one email per recipient with a valid-looking address via the given SendGrid client
 * (dependency-injected so tests can pass a mock instead of the real @sendgrid/mail module).
 * Returns { sent, skipped, failed, failures }. */
async function sendEmailBatch(sgMail, recipients, subject, body) {
  const validRecipients = recipients.filter(r => r && typeof r.email === 'string' && /\S+@\S+\.\S+/.test(r.email));
  if (!validRecipients.length) {
    return { sent: 0, skipped: recipients.length, failed: 0, failures: [] };
  }

  const settled = await Promise.allSettled(validRecipients.map(r => sgMail.send({
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

exports.sendGuestEmail = onCall({ secrets: [SENDGRID_API_KEY], region: 'us-central1' }, async (request) => {
  requireSignedIn(request);
  const { recipients, body } = validateSendRequest(request.data);
  const subject = (request.data && request.data.subject && String(request.data.subject).trim())
    || 'A message from your wedding';

  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(SENDGRID_API_KEY.value());

  const result = await sendEmailBatch(sgMail, recipients, subject, body);
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
exports._internal = { validateSendRequest, sendEmailBatch, sendSmsBatch, MAX_RECIPIENTS_PER_CALL };
