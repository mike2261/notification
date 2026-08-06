// The versioned event contract (docs/design.md §2). Owned by tuni-noti,
// copied VERBATIM into robo-worker — the two repos' CIs cross-check each
// other's fixtures at a pinned SHA (docs/events/v1.md, docs/design.md §2).
// Do not hand-edit a copy in robo-worker; land the change here first.
//
// Additive-only within a major: consumers ignore unknown fields, so every
// `data` shape below is "+": "ignore" (arktype's default) rather than
// "+": "reject".

import { type } from "arktype";

const subject = type({
  parentId: "string > 0",
  childId: "string > 0",
  childName: "string > 0",
});

const envelopeFields = {
  specVersion: "'1.0'",
  eventId: "string > 0",
  occurredAt: "string > 0",
  producer: "string > 0",
  subject,
} as const;

// outcome ∈ achieved | almost | practice_more — mirrors
// deriveMissionOutcome() (robo-worker src/services/course/runtime/events.ts:454).
const outcome = "'achieved'|'almost'|'practice_more'";

export const identityChildUpserted = type({
  ...envelopeFields,
  type: "'identity.child.upserted'",
  data: { name: "string > 0", age: "number", stage: "string > 0" },
});

export const identityChildDeleted = type({
  ...envelopeFields,
  type: "'identity.child.deleted'",
  data: {},
});

// Defined in the contract, no producer yet (docs/design.md §1.5) — robo-worker
// has no account deletion. Included so the consumer's exhaustive type switch
// (docs/design.md §4.4) has a real branch to route to `ignored` rather than
// an unknown-type fallback, the day a producer for it appears.
export const identityParentDeleted = type({
  ...envelopeFields,
  type: "'identity.parent.deleted'",
  data: {},
});

export const learningLessonCompleted = type({
  ...envelopeFields,
  type: "'learning.lesson.completed'",
  data: { courseId: "string > 0", lessonId: "string > 0", outcome, durationS: "number" },
});

export const learningChallengeAchieved = type({
  ...envelopeFields,
  type: "'learning.challenge.achieved'",
  data: { courseId: "string > 0", challengeId: "string > 0", firstTime: "boolean" },
});

export const learningStarAwarded = type({
  ...envelopeFields,
  type: "'learning.star.awarded'",
  data: { courseId: "string > 0", challengeId: "string > 0", totalStars: "number" },
});

export const reportingWeekClosed = type({
  ...envelopeFields,
  type: "'reporting.week.closed'",
  data: {
    weekStart: "string > 0",
    weekEnd: "string > 0",
    lessons: "number",
    // stars and missionsAchieved are DIFFERENT numbers — one row in
    // child_challenge_awards is one mission, `stars` is that row's award
    // (1..100); COUNT(*) is not a star count (docs/design.md §3.4).
    stars: "number",
    missionsAchieved: "number",
  },
});

export const eventV1 = identityChildUpserted
  .or(identityChildDeleted)
  .or(identityParentDeleted)
  .or(learningLessonCompleted)
  .or(learningChallengeAchieved)
  .or(learningStarAwarded)
  .or(reportingWeekClosed);

export type EventV1 = typeof eventV1.infer;
