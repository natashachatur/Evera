/* Plain-Node test for the core send/validation logic in functions/index.js — no Firebase Functions
 * Framework, no real network calls, no emulator required. Run with: node functions/test/send.test.js
 * Uses the dependency-injected sendEmailBatch/sendSmsBatch/validateSendRequest exported as
 * exports._internal specifically so this is possible — see the comment in index.js. */
const assert = require('assert');
const { validateSendRequest, sendEmailBatch, sendSmsBatch, MAX_RECIPIENTS_PER_CALL } = require('../index.js')._internal;

let passed = 0, failed = 0;
function check(label, fn) {
  try { fn(); console.log('PASS -', label); passed++; }
  catch (e) { console.log('FAIL -', label, '-', e.message); failed++; }
}
async function checkAsync(label, fn) {
  try { await fn(); console.log('PASS -', label); passed++; }
  catch (e) { console.log('FAIL -', label, '-', e.message); failed++; }
}

(async () => {
  // --- validateSendRequest ---
  check('rejects missing recipients', () => {
    assert.throws(() => validateSendRequest({ body: 'hi' }), /HttpsError|No recipients/);
  });
  check('rejects empty recipients array', () => {
    assert.throws(() => validateSendRequest({ recipients: [], body: 'hi' }));
  });
  check('rejects missing body', () => {
    assert.throws(() => validateSendRequest({ recipients: [{ email: 'a@b.com' }] }));
  });
  check('rejects whitespace-only body', () => {
    assert.throws(() => validateSendRequest({ recipients: [{ email: 'a@b.com' }], body: '   ' }));
  });
  check('rejects over the max-recipients cap', () => {
    const recipients = Array.from({ length: MAX_RECIPIENTS_PER_CALL + 1 }, (_, i) => ({ email: `g${i}@example.com` }));
    assert.throws(() => validateSendRequest({ recipients, body: 'hi' }));
  });
  check('accepts and trims a valid request', () => {
    const { recipients, body } = validateSendRequest({ recipients: [{ email: 'a@b.com' }], body: '  hello there  ' });
    assert.strictEqual(body, 'hello there');
    assert.strictEqual(recipients.length, 1);
  });

  // --- sendEmailBatch ---
  await checkAsync('sendEmailBatch sends to all valid emails and reports counts', async () => {
    const sent = [];
    const mockSgMail = { async send(msg) { sent.push(msg); } };
    const recipients = [{ label: 'Alice', email: 'alice@example.com' }, { label: 'Bob', email: 'bob@example.com' }];
    const result = await sendEmailBatch(mockSgMail, recipients, 'Save the Date', 'See you there!');
    assert.strictEqual(result.sent, 2);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[0].to, 'alice@example.com');
    assert.strictEqual(sent[0].subject, 'Save the Date');
    assert.strictEqual(sent[0].from.email, 'hello@mail.evera-planning.ca');
  });

  await checkAsync('sendEmailBatch skips recipients with no/invalid email, does not call send for them', async () => {
    const sent = [];
    const mockSgMail = { async send(msg) { sent.push(msg); } };
    const recipients = [{ label: 'No Email', email: '' }, { label: 'Bad Email', email: 'not-an-email' }, { label: 'Good', email: 'good@example.com' }];
    const result = await sendEmailBatch(mockSgMail, recipients, 'Subj', 'Body');
    assert.strictEqual(result.sent, 1);
    assert.strictEqual(result.skipped, 2);
    assert.strictEqual(sent.length, 1);
  });

  await checkAsync('sendEmailBatch reports per-recipient failures without crashing the whole batch', async () => {
    const mockSgMail = {
      async send(msg) {
        if (msg.to === 'fails@example.com') throw new Error('simulated SendGrid rejection');
        return { ok: true };
      }
    };
    const recipients = [{ email: 'ok@example.com' }, { email: 'fails@example.com' }];
    const result = await sendEmailBatch(mockSgMail, recipients, 'Subj', 'Body');
    assert.strictEqual(result.sent, 1);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.failures[0].email, 'fails@example.com');
    assert.ok(result.failures[0].error.includes('simulated SendGrid rejection'));
  });

  await checkAsync('sendEmailBatch returns all-skipped when nobody has an email', async () => {
    const mockSgMail = { async send() { throw new Error('should never be called'); } };
    const result = await sendEmailBatch(mockSgMail, [{ email: '' }, { phone: '+14165550134' }], 'Subj', 'Body');
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(result.skipped, 2);
  });

  // --- sendSmsBatch ---
  await checkAsync('sendSmsBatch sends to all valid phone numbers and reports counts', async () => {
    const sent = [];
    const mockClient = { messages: { async create(opts) { sent.push(opts); return { sid: 'SM1' }; } } };
    const recipients = [{ label: 'Alice', phone: '+1 416 555 0134' }, { label: 'Bob', phone: '6475550121' }];
    const result = await sendSmsBatch(mockClient, '+15555550100', recipients, 'See you Saturday!');
    assert.strictEqual(result.sent, 2);
    assert.strictEqual(sent[0].from, '+15555550100');
    assert.strictEqual(sent[0].body, 'See you Saturday!');
  });

  await checkAsync('sendSmsBatch skips recipients with no/short phone number', async () => {
    const sent = [];
    const mockClient = { messages: { async create(opts) { sent.push(opts); return {}; } } };
    const recipients = [{ phone: '' }, { phone: '555' }, { phone: '+14165550134' }];
    const result = await sendSmsBatch(mockClient, '+15555550100', recipients, 'Body');
    assert.strictEqual(result.sent, 1);
    assert.strictEqual(result.skipped, 2);
  });

  await checkAsync('sendSmsBatch reports per-recipient Twilio failures', async () => {
    const mockClient = {
      messages: {
        async create(opts) {
          if (opts.to === '+10000000000') throw new Error('simulated Twilio rejection');
          return { sid: 'SM_ok' };
        }
      }
    };
    const recipients = [{ phone: '+14165550134' }, { phone: '+10000000000' }];
    const result = await sendSmsBatch(mockClient, '+15555550100', recipients, 'Body');
    assert.strictEqual(result.sent, 1);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.failures[0].phone, '+10000000000');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
