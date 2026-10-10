const nodemailer = require('nodemailer');

// Sending order of preference:
//   1. Brevo's HTTP API, when BREVO_API_KEY is set (the recommended setup)
//   2. Any SMTP server, when SMTP_HOST is set
//   3. Nothing: emails are skipped and logged
// A mail problem must never break an order or a sign-in, so sendMail never throws.
let transport = null; // set by tests, or built from SMTP settings
const pending = new Set();

// "Market Square <me@example.com>" -> { name, email }
function parseFrom(value) {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value || '');
  if (match) return { name: match[1].trim() || 'Square Market', email: match[2].trim() };
  return { name: 'Square Market', email: (value || 'no-reply@squaremarket.ng').trim() };
}

function smtpTransport() {
  if (transport) return transport;
  if (!process.env.SMTP_HOST) return null;
  const port = Number(process.env.SMTP_PORT) || 587;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

async function sendViaBrevo({ to, subject, text, html }) {
  const sender = parseFrom(process.env.MAIL_FROM);
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
    body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

function sendMail({ to, subject, text, html }) {
  const viaBrevo = !transport && process.env.BREVO_API_KEY;
  const smtp = viaBrevo ? null : smtpTransport();
  if (!to || (!viaBrevo && !smtp)) {
    console.log(`[mail skipped] ${to ?? '(no recipient)'}: ${subject}`);
    return Promise.resolve({ skipped: true });
  }

  const job = (viaBrevo
    ? sendViaBrevo({ to, subject, text, html })
    : smtp.sendMail({ from: process.env.MAIL_FROM || 'Square Market <no-reply@squaremarket.ng>', to, subject, text, html })
  )
    .then(() => ({ sent: true }))
    .catch((err) => {
      console.error('Email failed:', subject, err.message);
      return { failed: true };
    })
    .finally(() => pending.delete(job));
  pending.add(job);
  return job;
}

// Tests swap in a fake transport, and wait for in-flight mail with idle().
const setTransport = (t) => {
  transport = t;
};
const idle = () => Promise.all([...pending]);

module.exports = { sendMail, setTransport, idle, parseFrom };
