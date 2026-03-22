"use client";

import { useSession } from "./session-context.tsx";

export function usePermission(permission: string): boolean {
  const { data } = useSession();
  return data?.permissions?.includes(permission) ?? false;
}

export function useRole(role: string): boolean {
  const { data } = useSession();
  return data?.user?.role === role;
}
