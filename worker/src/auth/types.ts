export type Role = 'user' | 'moderator' | 'admin';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: 'active' | 'suspended' | 'deleted';
}

const RANK: Record<Role, number> = { user: 0, moderator: 1, admin: 2 };

export function roleAtLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

export function isStaff(user: Pick<AuthUser, 'role'>): boolean {
  return user.role === 'admin' || user.role === 'moderator';
}

export function isAdmin(user: Pick<AuthUser, 'role'>): boolean {
  return user.role === 'admin';
}

/** Row shape returned by `users` queries in this module set. */
export interface UserRow {
  id: string;
  email: string;
  email_normalized: string;
  display_name: string;
  role: Role;
  status: 'active' | 'suspended' | 'deleted';
  password_hash?: string;
  created_at: string;
  last_login_at?: string | null;
}

export function toAuthUser(row: Pick<UserRow, 'id' | 'email' | 'display_name' | 'role' | 'status'>): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
  };
}
