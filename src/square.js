// ============================================================
// Square API client — minimal, native fetch, zero deps.
// Talks to Square's Customers, Cards, and Subscriptions APIs
// to turn a signup's card token into a real trial subscription.
// SQUARE_API_BASE defaults to Sandbox — swap the env var (not
// this code) to go live with Production credentials later.
// ============================================================
const crypto = require("node:crypto");

const SQUARE_API_BASE = process.env.SQUARE_API_BASE || "https://connect.squareupsandbox.com";
const SQUARE_VERSION = "2026-08-19";

async function squareRequest(path, body) {
  const res = await fetch(`${SQUARE_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const message = (data.errors && data.errors[0] && data.errors[0].detail) || "Square request failed";
    const err = new Error(message);
    err.squareErrors = data.errors;
    throw err;
  }
  return data;
}

async function createCustomer({ studioName, email }) {
  const data = await squareRequest("/v2/customers", {
    idempotency_key: crypto.randomUUID(),
    given_name: studioName,
    email_address: email,
  });
  return data.customer.id;
}

async function createCard({ cardToken, customerId }) {
  const data = await squareRequest("/v2/cards", {
    idempotency_key: crypto.randomUUID(),
    source_id: cardToken,
    card: { customer_id: customerId },
  });
  return data.card.id;
}

async function createSubscription({ customerId, cardId, planVariationId }) {
  const data = await squareRequest("/v2/subscriptions", {
    idempotency_key: crypto.randomUUID(),
    location_id: process.env.SQUARE_LOCATION_ID,
    customer_id: customerId,
    plan_variation_id: planVariationId,
    card_id: cardId,
  });
  return data.subscription;
}

// Orchestrates all three calls in order. Throws on any failure —
// the caller (POST /api/signup) decides what to do, and currently
// does NOT create a tenant row if this throws, so there's never
// a trial account with broken/missing billing behind it.
async function createTrialSubscription({ studioName, email, cardToken, tier }) {
  const planVariationId =
    tier === "instructor"
      ? process.env.SQUARE_PLAN_VARIATION_INSTRUCTOR
      : process.env.SQUARE_PLAN_VARIATION_STUDIO;
  if (!planVariationId) {
    throw new Error("Billing is not fully configured for this plan yet.");
  }

  const customerId = await createCustomer({ studioName, email });
  const cardId = await createCard({ cardToken, customerId });
  const subscription = await createSubscription({ customerId, cardId, planVariationId });

  return {
    squareCustomerId: customerId,
    squareSubscriptionId: subscription.id,
  };
}

module.exports = { createTrialSubscription };
