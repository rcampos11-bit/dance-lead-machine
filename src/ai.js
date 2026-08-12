// ============================================================
// Real AI integration — calls the Anthropic Messages API so the
// receptionist actually understands free-text messages instead
// of keyword-matching. Uses native fetch (Node 18+), no SDK.
//
// Design: the model drives the conversation naturally and calls
// the `capture_lead` tool exactly once, when it has enough info.
// Everything AFTER that tool call (which instructor, is the slot
// still open, generating follow-up messages) is handled by plain,
// deterministic code in logic.js — the AI's job is understanding
// language, not running the business logic.
// ============================================================
const { CATEGORIES, CATEGORY_KEYS } = require("./logic");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022";

const CAPTURE_LEAD_TOOL = {
  name: "capture_lead",
  description:
    "Call this exactly once, when you have enough information to hand the lead off to the studio: their name, their best contact info (phone or email), which category their inquiry falls into, and their response to the appointment time options (a slot number, or that none worked for them). Always also say a short, warm closing line in the same reply.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "The prospect's name." },
      contact: { type: "string", description: "Phone number or email address, whichever they gave." },
      category: {
        type: "string",
        enum: CATEGORY_KEYS,
        description: "Which kind of dance inquiry this is.",
      },
      notes: {
        type: "string",
        description: "A brief 1-2 sentence summary of what they want, in plain language, including their answer to your follow-up question.",
      },
      time_preference: {
        type: ["string", "null"],
        enum: ["morning", "afternoon", "evening", null],
        description: "Their preferred time of day for a callback, or null if they didn't give one.",
      },
    },
    required: ["name", "contact", "category", "notes"],
  },
};

function buildSystemPrompt({ studioName }) {
  const categoryList = CATEGORY_KEYS.map((k) => `- ${k}: ${CATEGORIES[k].label}`).join("\n");
  return `You are the AI Receptionist for ${studioName}, a dance studio. You are warm, concise, and efficient — you are texting with a prospective student, not writing an essay. Keep every reply to 1-3 short sentences, plain conversational language, no bullet points.

Your job in this conversation, one step at a time:
1. Figure out what kind of dance inquiry this is, from these categories:
${categoryList}
   If their first message is vague, ask ONE friendly clarifying question instead of guessing.
2. Ask exactly one smart, natural follow-up question relevant to their category (e.g. wedding date for a wedding inquiry, child's age for a kids inquiry, experience level for competitive). Don't ask more than one question per reply.
3. Collect their name and best contact info (phone number or email) — one at a time, not both in the same question.
4. Once you have their name and contact info, ask whether mornings, afternoons, or evenings tend to work best for a quick call — do not offer or mention any specific times, dates, or slots. This is just a general preference so a real person can follow up.
5. As soon as you have ALL of: their category, name, contact info, AND their time-of-day preference (or that they don't have one), call the capture_lead tool with everything you've learned, and say a short warm closing line in the same reply — something like "a real person will call you shortly to find a time that works." Never mention or imply a specific date, time, or booked appointment.

Never call capture_lead before you have all four pieces of information. Never ask about things you already know. Never state or imply a specific date or time — only ask for a general morning/afternoon/evening preference, and let a human confirm the actual time afterward. Stay natural and conversational throughout — you're a friendly human-sounding receptionist, not a form.`;
}

/**
 * Calls the Anthropic API for the next receptionist turn.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.studioName
 * @param {Array} opts.slots - [{id,label}] generated server-side for this conversation
 * @param {Array} opts.history - prior turns as [{role:'user'|'assistant', content: string | array}]
 * @param {string} opts.userMessage - the new user message to append
 * @param {function} [opts.fetchImpl] - injectable for tests
 * @returns {Promise<{reply: string, toolCall: object|null, rawAssistantContent: array}>}
 */
async function getReceptionistReply({ apiKey, studioName, slots, history, userMessage, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY. Set it as an environment variable before starting the server.");
  }

  const messages = [...history, { role: "user", content: userMessage }];

  const res = await doFetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 500,
      system: buildSystemPrompt({ studioName }),
      tools: [CAPTURE_LEAD_TOOL],
      messages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data.content || [];
  const textBlocks = content.filter((b) => b.type === "text").map((b) => b.text);
  const toolUse = content.find((b) => b.type === "tool_use" && b.name === "capture_lead");

  return {
    reply: textBlocks.join("\n").trim(),
    toolCall: toolUse ? toolUse.input : null,
    rawAssistantContent: content,
  };
}

module.exports = { getReceptionistReply, buildSystemPrompt, CAPTURE_LEAD_TOOL, DEFAULT_MODEL };
