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
  },
  {
    key: "new_dancer_special",
    label: "$29 New Dancer Special",
    description: "A low-cost trial package (2-3 private lessons) that gets a prospect in the door and dancing fast.",
  },
  {
    key: "beginner_bootcamp",
    label: "Beginner Bootcamp",
    description: "A short group series (e.g. 4 weeks) aimed at total beginners who want structure, not a single class.",
  },
  {
    key: "wedding_consult",
    label: "Free Wedding Dance Consultation",
    description: "A free 20-minute consult for engaged couples to talk through their first dance — great for wedding-season leads.",
  },
  {
    key: "group_class_pass",
    label: "Free Group Class Pass",
    description: "One free drop-in to any regular group class — low commitment, shows off the studio's energy.",
  },
];

function getOfferTemplates() {
  return OFFER_TEMPLATES;
}

function getOfferByKey(key) {
  return OFFER_TEMPLATES.find((o) => o.key === key) || null;
}

module.exports = { getOfferTemplates, getOfferByKey };
