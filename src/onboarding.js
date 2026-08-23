// ============================================================
// Onboarding — offer templates for the guided Quick Start wizard.
// Kept separate from pricing.js: these are marketing offers used
// to get a client's FIRST leads, not their full pricing catalog.
// ============================================================
const OFFER_TEMPLATES = [
  {
    key: "free_discovery",
    label: "Free 30-Minute Dance Experience",
    description: "A no-pressure free trial lesson — the easiest possible yes for someone who's never danced before.",
    value: "Reg. $45",
  },
  {
    key: "group_class_pass",
    label: "Free Group Class Pass",
    description: "One free drop-in to any regular group class — low commitment, shows off the studio's energy.",
    value: "Reg. $15",
  },
  {
    key: "wedding_consult",
    label: "Free Wedding Dance Consultation",
    description: "A free 20-minute consult for engaged couples to talk through their first dance — great for wedding-season leads.",
    value: "Reg. $50",
  },
  {
    key: "new_dancer_special",
    label: "$49 New Dancer Special",
    description: "A one-time 45-minute private lesson — for you solo or with a partner. The easiest way to get in the door and dancing fast.",
    value: "Reg. $90",
  },
  {
    key: "date_night_package",
    label: "Date Night Dance Package",
    description: "Two 45-minute private lessons for two — a fun night out, no experience needed, just an excuse to get close.",
    value: "$149 (Reg. $180)",
  },
];

function getOfferTemplates() {
  return OFFER_TEMPLATES;
}

function getOfferByKey(key) {
  return OFFER_TEMPLATES.find((o) => o.key === key) || null;
}

module.exports = { getOfferTemplates, getOfferByKey };
