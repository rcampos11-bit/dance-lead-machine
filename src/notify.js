// ============================================================
// Notify — actually sends the messages that sequence_steps only
// used to schedule. Twilio for SMS, SendGrid for email. Both via
// native fetch — no SDK dependencies, matching the rest of this
// codebase's zero-deps philosophy.
// ============================================================

async function sendSms({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    throw new Error("Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER)");
  }
  if (!to) throw new Error("No phone number on file for this lead");

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const params = new URLSearchParams({ To: to, From: from, Body: body });

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Twilio send failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  return res.json();
}

async function sendEmail({ to, subject, body }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.SENDGRID_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error("SendGrid is not configured (SENDGRID_API_KEY / SENDGRID_FROM_EMAIL)");
  }
  if (!to) throw new Error("No email address on file for this lead");

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject: subject || "A message from your studio",
      content: [{ type: "text/plain", value: body }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`SendGrid send failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  return true;
}

module.exports = { sendSms, sendEmail };
