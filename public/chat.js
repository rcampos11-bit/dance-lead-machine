/* ============================================================
   DANCE LEAD MACHINE — customer-facing chat only.
   Talks to /api/chat. No leads/sequences/roster UI here —
   that lives in the password-protected admin dashboard.
   ============================================================ */

let sessionId = null;
let lastDone = false;
// Which tenant this chat belongs to, read once from ?t=<slug> in the URL.
// Empty string means "no slug given" — the server falls back to tenant 1
// (this studio's own account) to keep existing links working unchanged.
const tenantSlug = new URLSearchParams(window.location.search).get("t") || "";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function addMessage(text, cls) {
  const el = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "msg " + cls;
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
function botSay(t) { addMessage(t, "bot"); }
function userSay(t) { addMessage(t, "user"); }

function addLeadCard(lead) {
  const el = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "lead-card";
  const nextStepLine = `<tr><td class="k">Next Step</td><td>${escapeHtml(lead.assignedInstructor)} will reach out to schedule with you.</td></tr>`;
  const prefLine = lead.timePreference
    ? `<tr><td class="k">Best Time</td><td>${escapeHtml(lead.timePreference.charAt(0).toUpperCase() + lead.timePreference.slice(1))}</td></tr>`
    : "";
  div.innerHTML = `
    <h4>✅ Thanks, ${escapeHtml(lead.name)}!</h4>
    <table>
      <tr><td class="k">Interest</td><td>${escapeHtml(lead.danceInterest)}</td></tr>
      ${nextStepLine}
      ${prefLine}
    </table>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// Renders the SMS consent card with two real, clickable buttons.
// This is the ONLY place consent can be given — never inferred from
// typed text. Both buttons disable immediately on click so a double
// click or slow network can't fire the request twice.
function addConsentCard(consent) {
  const el = document.getElementById("messages");
  const div = document.createElement("div");
  div.className = "consent-card";
  div.innerHTML = `
    <p class="consent-question">${escapeHtml(consent.question)}</p>
    <p class="consent-disclosure">${escapeHtml(consent.disclosure)}</p>
    <div class="consent-actions">
      <button class="consent-btn yes" type="button">${escapeHtml(consent.yesLabel)}</button>
      <button class="consent-btn no" type="button">${escapeHtml(consent.noLabel)}</button>
    </div>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;

  const yesBtn = div.querySelector(".consent-btn.yes");
  const noBtn = div.querySelector(".consent-btn.no");
  const handleClick = (agreed) => {
    yesBtn.disabled = true;
    noBtn.disabled = true;
    sendConsent(agreed);
  };
  yesBtn.addEventListener("click", () => handleClick(true));
  noBtn.addEventListener("click", () => handleClick(false));
}

async function sendConsent(agreed) {
  try {
    const res = await fetch("/api/chat/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, consent: agreed }),
    });
    const data = await res.json();
    if (!res.ok) {
      botSay("⚠️ Sorry, something went wrong recording that. Please try again in a moment.");
      return;
    }
    lastDone = !!data.done;
    userSay(agreed ? "Yes, text me" : "No thanks");
    if (data.lead) {
      addLeadCard(data.lead);
    }
  } catch (err) {
    botSay("⚠️ Couldn't reach the server. Please check your connection and try again.");
  }
}

function newConversation() {
  sessionId = null;
  lastDone = false;
  document.getElementById("messages").innerHTML = "";
  botSay("Hi there! 👋 Thanks for reaching out to Dance Lead Machine™ Studio. I'm here to help — what brings you in today?");
}

async function sendMessage(text) {
  userSay(text);
  const sendBtn = document.getElementById("sendBtn");
  sendBtn.disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: text, tenantSlug }),
    });
    const data = await res.json();
    if (!res.ok) {
      botSay("⚠️ Sorry, something went wrong on our end. Please try again in a moment.");
      return;
    }
    sessionId = data.sessionId;
    lastDone = !!data.done;
    botSay(data.reply);
    if (data.awaitingConsent) {
      addConsentCard(data.awaitingConsent);
    } else if (data.done && data.lead) {
      addLeadCard(data.lead);
    }
  } catch (err) {
    botSay("⚠️ Couldn't reach the server. Please check your connection and try again.");
  } finally {
    sendBtn.disabled = false;
  }
}

document.getElementById("sendBtn").addEventListener("click", () => {
  const input = document.getElementById("input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  if (lastDone) {
    newConversation();
    setTimeout(() => sendMessage(text), 400);
  } else {
    sendMessage(text);
  }
});
document.getElementById("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("sendBtn").click();
});
document.getElementById("resetBtn").addEventListener("click", newConversation);

// ---- init ----
newConversation();
