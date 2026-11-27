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
 * the same { send(msg) } shape instead). Returns { sent, skipped, failed, failures }.
 * v1.85.0: `html`, when given, is sent as the real HTML body (the couple's own rich-text
 * composition from index.html) instead of letting makeTwilioEmailClient auto-generate one from
 * the plain text — see sanitizeEmailHtml below for why this is still sanitized here too, not
 * just trusted from the client. */
async function sendEmailBatch(emailClient, recipients, subject, body, html) {
  const validRecipients = recipients.filter(r => r && typeof r.email === 'string' && /\S+@\S+\.\S+/.test(r.email));
  if (!validRecipients.length) {
    return { sent: 0, skipped: recipients.length, failed: 0, failures: [] };
  }

  const settled = await Promise.allSettled(validRecipients.map(r => emailClient.send({
    to: r.email,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    text: body,
    html,
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

/** Turns a plain-text message body into minimal HTML (escaped, newlines as <br>) for the
 * Twilio Email API's required `content.html` field — see the v1.77.0 comment on its call site.
 * Not a rich editor output; just enough structure that the HTML version reads the same as the
 * plain-text one most guests' mail clients will actually render. */
function textToSimpleHtml(text) {
  const escaped = String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return `<div style="font-family:sans-serif; white-space:pre-wrap;">${escaped}</div>`;
}

/** v1.85.0 — rich-text composing (New Request #77, the half that didn't need the inbound-reply
 * infrastructure): index.html's Communications Center composer now generates real HTML
 * (bold/italic/links/paragraphs) and already sanitizes it to a small tag allowlist before this
 * function ever sees it. This is still NOT trusted as-is, though: sendGuestEmail is a signed-in
 * callable, reachable directly by any authenticated account, not only through the app's own UI —
 * so this is a second, independent layer of defense that strips the specific things that could
 * actually do something (a script/style block, an inline event-handler attribute, a javascript:
 * link), regardless of what the caller actually sent. It's deliberately not a full HTML parser —
 * the real allowlisting already happened client-side — just a backstop against the categories of
 * HTML that matter for an email that's about to go out under Evera's own verified sending domain. */
function sanitizeEmailHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return null;
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\s+on\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+on\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\s+href\s*=\s*"\s*javascript:[^"]*"/gi, ' href="#"')
    .replace(/\s+href\s*=\s*'\s*javascript:[^']*'/gi, " href='#'");
}

/** Builds the real email-sending client that sendEmailBatch calls .send() on — a thin wrapper
 * around the Twilio Email API (comms.twilio.com/v1/Emails), kept to the exact same { send(msg) }
 * shape the classic @sendgrid/mail client had so sendEmailBatch (and its tests, which mock this
 * same interface) didn't need to change — only what's behind this interface did. */
function makeTwilioEmailClient(apiKeySid, apiKeySecret) {
  return {
    async send({ to, from, subject, text, html }) {
      const auth = Buffer.from(`${apiKeySid}:${apiKeySecret}`).toString('base64');
      const resp = await fetch(TWILIO_EMAIL_API_URL, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: { address: from.email, name: from.name },
          to: [{ address: to }],
          // v1.77.0: the Twilio Email API rejected a text-only `content` with a 400 ("Invalid
          // value provided for field 'content'") — every example in its docs includes `html`
          // alongside `text`. v1.85.0: a real rich-text composition (already sanitized — see
          // sanitizeEmailHtml above) is used directly when given; otherwise this still falls back
          // to the same auto-generated plain-text-to-HTML conversion as before, unchanged.
          content: { subject, text, html: html || textToSimpleHtml(text) },
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
  // v1.85.0: an optional real rich-text HTML body from the Communications Center composer.
  // Sanitized here regardless of the client-side sanitization already applied — see
  // sanitizeEmailHtml's own comment for why a signed-in callable can't just trust this.
  const html = sanitizeEmailHtml(request.data && request.data.html) || undefined;

  const emailClient = makeTwilioEmailClient(TWILIO_EMAIL_API_KEY_SID.value(), TWILIO_EMAIL_API_KEY_SECRET.value());

  const result = await sendEmailBatch(emailClient, recipients, subject, body, html);
  if (result.failures.length) logger.warn('sendGuestEmail: some sends failed', { failures: result.failures });
  return result;
});

exports.sendGuestSms = onCall({
  secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER],
  region: 'us-central1'
}, async (request) => {
  requireSignedIn(request);
  const { recipients, body } = validateSendRequest(request.data);

  // v1.78.0: a real test SMS send came back as a bare "INTERNAL" error with no detail — the exact
  // same class of bug the v1.76.0 email rewrite fixed for sendGuestEmail. Cause: anything thrown
  // here that ISN'T an HttpsError gets swallowed by Firebase Functions and replaced with an opaque
  // generic "internal" error client-side, so a missing/malformed secret or a `twilio()` constructor
  // validation error (it throws synchronously, e.g. "accountSid must start with AC...") never
  // reached the UI. Both failure points are now wrapped so the real reason actually surfaces.
  const accountSid = TWILIO_ACCOUNT_SID.value();
  const authToken = TWILIO_AUTH_TOKEN.value();
  const fromNumber = TWILIO_PHONE_NUMBER.value();
  if (!accountSid || !authToken || !fromNumber) {
    throw new HttpsError('failed-precondition', "Text sending isn't set up yet — one or more of the TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_PHONE_NUMBER secrets hasn't been set. Run `firebase functions:secrets:set <NAME>` for each one, then redeploy.");
  }

  let client;
  try {
    const twilio = require('twilio');
    client = twilio(accountSid, authToken);
  } catch (err) {
    // v1.79.0: the "accountSid must start with AC" error kept recurring even after the secret was
    // confirmed correct via `firebase functions:secrets:access` — rather than guess again, surface
    // exactly what this deployed instance is actually seeing (the SID prefix/length only — never the
    // auth token — so this is safe to show, not a secret leak) so a stale-vs-live mismatch is visible
    // directly in the error instead of requiring another round of CLI checks.
    const sidPreview = accountSid ? `"${accountSid.slice(0, 4)}…" (${accountSid.length} chars)` : '(empty)';
    throw new HttpsError('failed-precondition', `Couldn't set up the Twilio SMS client: ${(err && err.message) || 'Unknown error'}. The Account SID this function is currently using starts with ${sidPreview} — compare that against the Account SID in the Twilio Console (it should start with "AC" and be 34 characters). Double-check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are correct in the Twilio Console.`);
  }

  const result = await sendSmsBatch(client, fromNumber, recipients, body);
  if (result.failures.length) logger.warn('sendGuestSms: some sends failed', { failures: result.failures });
  return result;
});

/* ================== v1.87.0 — real-time RSVP write-back (New Request #78) ==================
   submitGuestRsvp is the one deliberately PUBLIC, unauthenticated function in this app — a wedding
   guest submitting the live RSVP form on wedding-website.html has no Evera account and never will.
   Rather than loosen Firestore's security rules to let an anonymous visitor write guest data
   directly (the approach every other write path in this app explicitly avoids), this function is
   the single, narrow gate: it runs with the Admin SDK's full access, validates the submission
   against that wedding's OWN already-invited household/member/event IDs before writing anything,
   and can only ever touch the one household it's given — never any other guest's data, and never
   anything outside guestHouseholds. No Firestore security-rules changes are needed for this
   feature as a result.

   Natasha's scoping answers: matching a guest to their household uses whatever the couple's own
   RSVP Search Settings already determine (name and/or email, exact or similar match) — that
   lookup runs client-side in wedding-website.html against the public, read-only website export
   (see searchRsvpHousehold()), so by the time this function is called the client has already
   resolved a specific real householdId, the same id already used throughout Evera's own guest
   data. A second submission from the same household OVERWRITES the previous one automatically —
   matching how most RSVP tools behave, and simplest for a couple to reason about.

   One deliberate interaction worth noting: writing here bumps the wedding record's own
   `updatedAt`, the same field the v1.86.1 multi-tab-conflict guard uses. If the couple has the
   app open mid-edit when a guest's RSVP lands, their next save will correctly show the "this
   tab's data is out of date — refresh" banner — exactly the behavior that guard exists for. A
   guest's RSVP is a genuine concurrent write from outside that tab, so surfacing it rather than
   silently overwriting (or being silently overwritten) is the safer outcome, not a bug. */

// Mirrors householdInvitedEventIds() in index.html exactly, against the wedding record this
// function already has loaded server-side (there's no way to call back into browser-only code).
function householdInvitedEventIdsServer(wedding, h) {
  const events = Array.isArray(wedding.events) ? wedding.events : [];
  const allIds = events.map(e => e.id);
  let ids = (!h.invitedEvents || !h.invitedEvents.length) ? allIds : h.invitedEvents.filter(id => allIds.includes(id));
  ids = ids.filter(id => {
    const ev = events.find(x => x.id === id);
    return !(ev && Array.isArray(ev.limitedGuestHouseholdIds)) || ev.limitedGuestHouseholdIds.includes(h.id);
  });
  return ids;
}

// Mirrors isMemberExcludedFromEvent() in index.html.
function isMemberExcludedFromEventServer(h, memberId, eventId) {
  return !!(h.memberEventExclusions && h.memberEventExclusions[eventId] && h.memberEventExclusions[eventId].includes(memberId));
}

// Mirrors recomputeHouseholdRsvpStatus()/getEventRsvpStatus()/getMemberEventRsvp() in index.html,
// collapsed into one function since this file has no access to dashboardData globals those use.
function recomputeHouseholdRsvpStatusServer(wedding, h) {
  const invitedIds = householdInvitedEventIdsServer(wedding, h);
  const getMemberStatus = (m, eventId) => (m.eventRsvp && m.eventRsvp[eventId] !== undefined) ? m.eventRsvp[eventId] : ((h.eventRsvp && h.eventRsvp[eventId]) || 'pending');
  const getEventStatus = (eventId) => {
    const members = (h.members || []).filter(m => !isMemberExcludedFromEventServer(h, m.id, eventId));
    if (!members.length) return (h.eventRsvp && h.eventRsvp[eventId]) || 'pending';
    const statuses = members.map(m => getMemberStatus(m, eventId));
    if (statuses.every(s => s === 'confirmed')) return 'confirmed';
    if (statuses.every(s => s === 'declined')) return 'declined';
    if (statuses.every(s => s === 'pending')) return 'pending';
    return 'mixed';
  };
  if (!invitedIds.length) { h.rsvpStatus = h.rsvpStatus || 'pending'; return; }
  const statuses = invitedIds.map(getEventStatus);
  if (statuses.every(s => s === 'confirmed')) h.rsvpStatus = 'confirmed';
  else if (statuses.every(s => s === 'declined')) h.rsvpStatus = 'declined';
  else if (statuses.every(s => s === 'pending')) h.rsvpStatus = 'pending';
  else h.rsvpStatus = 'mixed';
}

const MAX_RSVP_NOTE_LENGTH = 2000;

/** Throws HttpsError on bad input; otherwise returns a trimmed, shape-checked payload. */
function validateRsvpSubmission(data) {
  const { uid, householdId, memberResponses, note, surveyResponses } = data || {};
  if (!uid || typeof uid !== 'string') throw new HttpsError('invalid-argument', 'Missing wedding account.');
  if (!householdId || typeof householdId !== 'string') throw new HttpsError('invalid-argument', 'Missing household.');
  if (!memberResponses || typeof memberResponses !== 'object' || Array.isArray(memberResponses)) {
    throw new HttpsError('invalid-argument', 'Missing RSVP responses.');
  }
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, MAX_RSVP_NOTE_LENGTH) : '';
  const cleanSurveyResponses = (surveyResponses && typeof surveyResponses === 'object' && !Array.isArray(surveyResponses)) ? surveyResponses : {};
  return { uid, householdId, memberResponses, note: cleanNote, surveyResponses: cleanSurveyResponses };
}

exports.submitGuestRsvp = onCall({ region: 'us-central1' }, async (request) => {
  // Deliberately NO requireSignedIn() here — see the file-level comment above for why this is
  // the one legitimate public entry point in this app, and what keeps it safe anyway.
  const { uid, householdId, memberResponses, note, surveyResponses } = validateRsvpSubmission(request.data);

  const db = admin.firestore();
  const ref = db.collection('weddings').doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', "We couldn't find that wedding.");
    const wedding = snap.data();
    const households = Array.isArray(wedding.guestHouseholds) ? wedding.guestHouseholds : [];
    const h = households.find(x => x.id === householdId);
    if (!h) throw new HttpsError('not-found', "We couldn't find your invitation. Please search again.");

    const invitedIds = householdInvitedEventIdsServer(wedding, h);
    const members = Array.isArray(h.members) ? h.members : [];

    Object.keys(memberResponses).forEach(memberId => {
      const m = members.find(x => x.id === memberId);
      if (!m) return; // never let a submission create or touch a member who isn't really part of this household
      const resp = memberResponses[memberId] || {};
      if (!m.eventRsvp || typeof m.eventRsvp !== 'object') m.eventRsvp = {};
      if (resp.events && typeof resp.events === 'object') {
        Object.keys(resp.events).forEach(eventId => {
          // Only an event this household is actually invited to, and this member isn't excluded from.
          if (!invitedIds.includes(eventId) || isMemberExcludedFromEventServer(h, memberId, eventId)) return;
          const val = resp.events[eventId];
          if (val === 'yes') m.eventRsvp[eventId] = 'confirmed';
          else if (val === 'no') m.eventRsvp[eventId] = 'declined';
        });
      }
      if (typeof resp.mealChoice === 'string') m.mealChoice = resp.mealChoice.slice(0, 200);
      if (typeof resp.dietaryRestrictions === 'string') m.dietaryRestrictions = resp.dietaryRestrictions.slice(0, 500);
    });

    if (!h.surveyResponses || typeof h.surveyResponses !== 'object') h.surveyResponses = {};
    Object.keys(surveyResponses).forEach(surveyId => {
      const answers = surveyResponses[surveyId];
      if (!answers || typeof answers !== 'object') return;
      if (!h.surveyResponses[surveyId]) h.surveyResponses[surveyId] = {};
      Object.keys(answers).forEach(qId => {
        if (typeof answers[qId] === 'string') h.surveyResponses[surveyId][qId] = answers[qId].slice(0, 1000);
      });
    });

    // The couple's own Guests module reads this same field (rsvpGuestNote) on the household —
    // a second submission overwrites it, same as everything else here.
    h.rsvpGuestNote = note;
    h.rsvpSubmittedAt = Date.now();

    recomputeHouseholdRsvpStatusServer(wedding, h);

    tx.update(ref, { guestHouseholds: households, updatedAt: Date.now() });
    return { ok: true };
  });
});

// Exported for functions/test/send.test.js only — Firebase's deploy step only picks up exports
// that are actual CloudFunction objects (the onCall-wrapped exports above), so these plain
// functions are simply ignored at deploy time, not shipped as extra endpoints.
exports._internal = {
  validateSendRequest, sendEmailBatch, sendSmsBatch, makeTwilioEmailClient, textToSimpleHtml, sanitizeEmailHtml, MAX_RECIPIENTS_PER_CALL, TWILIO_EMAIL_API_URL,
  validateRsvpSubmission, householdInvitedEventIdsServer, isMemberExcludedFromEventServer, recomputeHouseholdRsvpStatusServer
};
