/* ============================================================
   DANCE LEAD MACHINE — customer-facing chat only.
   Talks to /api/chat. No leads/sequences/roster UI here —
   that lives in the password-protected admin dashboard.
   ============================================================ */

let sessionId = null;
let lastDone = false;

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
  const apptLine = lead.appointment
    ? `<tr><td class="k">Your Appointment</td><td>${escapeHtml(lead.appointment)} with ${escapeHtml(lead.assignedInstructor)}</td></tr>`
    : `<tr><td class="k">Next Step</td><td>${escapeHtml(lead.assignedInstructor)} will reach out to schedule with you.</td></tr>`;
  div.innerHTML = `
    <h4>✅ You're all set, ${escapeHtml(lead.name)}!</h4>
    <table>
      <tr><td class="k">Interest</td><td>${escapeHtml(lead.danceInterest)}</td></tr>
      ${apptLine}
    </table>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
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
      body: JSON.stringify({ sessionId, message: text }),
    });
    const data = await res.json();
    if (!res.ok) {
      botSay("⚠️ Sorry, something went wrong on our end. Please try again in a moment.");
      return;
    }
    sessionId = data.sessionId;
    lastDone = !!data.done;
    botSay(data.reply);
    if (data.done && data.lead) {
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
