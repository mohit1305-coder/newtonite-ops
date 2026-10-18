import type { PoolClient, Pool } from "pg";
import { forbidden, notFound } from "./errors";
import type { Role } from "./workflow";

const RANK: Record<Role, number> = { viewer: 1, member: 2, lead: 3 };

export type Action = "create" | "comment" | "claim" | "edit" | "assign" | "transition";

/**
 * Central permission table. Every mutation goes through `can` on the server;
 * the UI only mirrors these answers (see `permissions` in the item DTO).
 *  - viewer: read only
 *  - member: create, comment, claim; edit/transition items they are involved in
 *  - lead:   everything in their team (assign, edit, approve)
 */
export function can(
  role: Role | null | undefined,
  action: Action,
  ctx: { isAssignee?: boolean; isReporter?: boolean } = {},
): boolean {
  if (!role) return false;
  const rank = RANK[role];
  switch (action) {
    case "create":
    case "comment":
    case "claim":
      return rank >= RANK.member;
    case "edit":
      return rank >= RANK.lead || (rank >= RANK.member && !!(ctx.isAssignee || ctx.isReporter));
    case "assign":
      return rank >= RANK.lead;
    case "transition":
      return rank >= RANK.member;
  }
}

export function requireCan(
  role: Role | null | undefined,
  action: Action,
  ctx: { isAssignee?: boolean; isReporter?: boolean } = {},
) {
  if (!can(role, action, ctx)) throw forbidden(`Your role does not allow: ${action}`);
}

type Db = Pick<Pool | PoolClient, "query">;

export async function getRole(db: Db, userId: string, teamId: string): Promise<Role | null> {
  const r = await db.query("SELECT role FROM memberships WHERE user_id = $1 AND team_id = $2", [
    userId,
    teamId,
  ]);
  return (r.rows[0]?.role as Role) ?? null;
}

/** Non-members get 404 so the existence of other teams' data is not leaked. */
export async function requireTeamRole(db: Db, userId: string, teamId: string): Promise<Role> {
  const role = await getRole(db, userId, teamId);
  if (!role) throw notFound("Team");
  return role;
}
