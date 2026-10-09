const nodemailer = require('nodemailer');

// Works with any provider that offers SMTP (Brevo, Resend, Gmail, Zoho...). Set SMTP_HOST, SMTP_PORT,
// SMTP_USER, SMTP_PASS and MAIL_FROM in api/.env. Without SMTP_HOST, emails are skipped and logged.
let transport = null;
const pending = new Set();

function getTransport() {
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

// Sends one email. Never throws: a mail problem must not break an order or a sign-in.
function sendMail({ to, subject, text, html }) {
  const t = getTransport();
  if (!t || !to) {
    console.log(`[mail skipped] ${to ?? '(no recipient)'}: ${subject}`);
    return Promise.resolve({ skipped: true });
  }
  const job = t
    .sendMail({ from: process.env.MAIL_FROM || 'Square Market <no-reply@squaremarket.ng>', to, subject, text, html })
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

module.exports = { sendMail, setTransport, idle };
