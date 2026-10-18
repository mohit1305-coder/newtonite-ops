export const STATUSES = ["OPEN", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE", "CANCELLED"] as const;
export type Status = (typeof STATUSES)[number];
export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type Priority = (typeof PRIORITIES)[number];
export type Role = "viewer" | "member" | "lead";

/** Which status changes are structurally possible. */
export const TRANSITIONS: Record<Status, Status[]> = {
  OPEN: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "IN_REVIEW", "CANCELLED"],
  BLOCKED: ["IN_PROGRESS", "CANCELLED"],
  IN_REVIEW: ["DONE", "IN_PROGRESS"],
  DONE: ["OPEN"],
  CANCELLED: ["OPEN"],
};

export type TransitionProblem = { kind: "invalid" | "forbidden"; message: string };

/**
 * Pure rule check for a status change. Returns null when allowed.
 *  - the move must exist in TRANSITIONS
 *  - work in progress/review needs an owner
 *  - completing (approval) and reopening are lead-only
 *  - everything else: the assignee or a lead
 */
export function checkTransition(p: {
  from: Status;
  to: Status;
  role: Role;
  isAssignee: boolean;
  hasAssignee: boolean;
}): TransitionProblem | null {
  if (p.role === "viewer") return { kind: "forbidden", message: "Viewers cannot change status" };
  if (!TRANSITIONS[p.from].includes(p.to))
    return { kind: "invalid", message: `Cannot move from ${p.from} to ${p.to}` };
  if ((p.to === "IN_PROGRESS" || p.to === "IN_REVIEW") && !p.hasAssignee)
    return { kind: "invalid", message: "Assign the item before starting or reviewing it" };

  const lead = p.role === "lead";
  if (p.to === "DONE" || p.from === "DONE" || p.from === "CANCELLED") {
    if (!lead)
      return { kind: "forbidden", message: "Only a team lead can approve completion or reopen an item" };
  } else if (!lead && !p.isAssignee) {
    return { kind: "forbidden", message: "Only the assignee or a team lead can change status" };
  }
  return null;
}

export function allowedTransitions(p: {
  from: Status;
  role: Role;
  isAssignee: boolean;
  hasAssignee: boolean;
}): Status[] {
  return TRANSITIONS[p.from].filter((to) => checkTransition({ ...p, to }) === null);
}
