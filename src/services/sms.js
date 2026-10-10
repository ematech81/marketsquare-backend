// SMS through BulkSMS Nigeria (SMS_PROVIDER=bulksms). Without a token, messages are skipped and logged.
// Like email, a failed SMS never breaks an order, so sendSms never throws.
const pending = new Set();
let sender = null; // tests swap this

// +2348031234567, 2348031234567 and 08031234567 all become 2348031234567.
function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('234')) return digits;
  return `234${digits.replace(/^0/, '')}`;
}

// Carriers only deliver alphanumeric sender IDs: letters and digits, no spaces or symbols, at most 11 characters,
// and not digits only. Anything else is cleaned up here; if nothing usable is left, the message is not sent.
function cleanSenderId(value) {
  const id = String(value ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 11);
  return /[A-Za-z]/.test(id) ? id : '';
}

async function sendViaBulkSms({ to, message }) {
  const from = cleanSenderId(process.env.BULKSMS_SENDER_ID);
  if (!from) throw new Error('BULKSMS_SENDER_ID must be letters and numbers only, up to 11 characters, with at least one letter');
  const base = process.env.BULKSMS_BASE_URL || 'https://www.bulksmsnigeria.com/api/v2';
  const res = await fetch(`${base}/sms`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.BULKSMS_API_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ from, to, body: message }),
  });
  if (!res.ok) throw new Error(`BulkSMS ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

function configured() {
  return sender || (process.env.SMS_PROVIDER === 'bulksms' && process.env.BULKSMS_API_TOKEN && process.env.BULKSMS_SENDER_ID);
}

function sendSms({ to, message }) {
  if (!to || !configured()) {
    console.log(`[sms skipped] ${to ?? '(no number)'}: ${message}`);
    return Promise.resolve({ skipped: true });
  }
  const number = normalizePhone(to);
  const job = (sender ? sender({ to: number, message }) : sendViaBulkSms({ to: number, message }))
    .then(() => ({ sent: true }))
    .catch((err) => {
      console.error('SMS failed:', err.message);
      return { failed: true };
    })
    .finally(() => pending.delete(job));
  pending.add(job);
  return job;
}

const setSender = (fn) => {
  sender = fn;
};
const idle = () => Promise.all([...pending]);

module.exports = { sendSms, normalizePhone, cleanSenderId, setSender, idle };
