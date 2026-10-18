import { describe, expect, it } from "vitest";
import { allowedTransitions, checkTransition } from "../src/workflow";
import { can } from "../src/authz";

const base = { role: "member" as const, isAssignee: true, hasAssignee: true };

describe("workflow rules", () => {
  it("rejects moves that are not in the state machine", () => {
    const r = checkTransition({ ...base, from: "OPEN", to: "DONE" });
    expect(r?.kind).toBe("invalid");
  });

  it("requires an owner before work starts or goes to review", () => {
    const r = checkTransition({ ...base, hasAssignee: false, isAssignee: false, role: "lead", from: "OPEN", to: "IN_PROGRESS" });
    expect(r?.kind).toBe("invalid");
  });

  it("only leads can approve completion, even the assignee cannot", () => {
    expect(checkTransition({ ...base, from: "IN_REVIEW", to: "DONE" })?.kind).toBe("forbidden");
    expect(checkTransition({ ...base, role: "lead", isAssignee: false, from: "IN_REVIEW", to: "DONE" })).toBeNull();
  });

  it("only leads can reopen closed items", () => {
    expect(checkTransition({ ...base, from: "DONE", to: "OPEN" })?.kind).toBe("forbidden");
    expect(checkTransition({ ...base, role: "lead", from: "CANCELLED", to: "OPEN", hasAssignee: false })).toBeNull();
  });

  it("members who are not the assignee cannot move an item", () => {
    expect(checkTransition({ ...base, isAssignee: false, from: "IN_PROGRESS", to: "BLOCKED" })?.kind).toBe("forbidden");
  });

  it("viewers can never change status", () => {
    expect(checkTransition({ ...base, role: "viewer", from: "IN_PROGRESS", to: "BLOCKED" })?.kind).toBe("forbidden");
  });

  it("lists only the transitions the user could actually perform", () => {
    expect(allowedTransitions({ from: "IN_REVIEW", role: "member", isAssignee: true, hasAssignee: true })).toEqual(["IN_PROGRESS"]);
    expect(allowedTransitions({ from: "IN_REVIEW", role: "lead", isAssignee: false, hasAssignee: true })).toEqual(["DONE", "IN_PROGRESS"]);
  });
});

describe("permission table", () => {
  it("viewers are read-only", () => {
    for (const a of ["create", "comment", "claim", "edit", "assign", "transition"] as const)
      expect(can("viewer", a, { isAssignee: true, isReporter: true })).toBe(false);
  });
  it("members can edit only items they are involved in", () => {
    expect(can("member", "edit")).toBe(false);
    expect(can("member", "edit", { isReporter: true })).toBe(true);
  });
  it("only leads assign", () => {
    expect(can("member", "assign")).toBe(false);
    expect(can("lead", "assign")).toBe(true);
  });
  it("no role means no access", () => {
    expect(can(null, "comment")).toBe(false);
  });
});
