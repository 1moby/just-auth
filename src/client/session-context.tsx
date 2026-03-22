"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import type { SessionContextValue, SessionValidationResult } from "../types.ts";

const SessionContext = createContext<SessionContextValue>({
  data: null,
  status: "loading",
  update: async () => {},
});

export interface SessionProviderProps {
  children: ReactNode;
  basePath?: string;
  refetchOnWindowFocus?: boolean;
}

export function SessionProvider({
  children,
  basePath = "/api/auth",
  refetchOnWindowFocus = true,
}: SessionProviderProps) {
  const [data, setData] = useState<SessionContextValue["data"]>(null);
  const [status, setStatus] = useState<SessionContextValue["status"]>("loading");

  const fetchSession = useCallback(async () => {
    try {
      const res = await fetch(`${basePath}/session`, {
        credentials: "same-origin",
      });
      if (res.ok) {
        const json = await res.json() as Record<string, unknown>;
        if (json && json.user) {
          const d = json as { user: SessionValidationResult["user"]; session: SessionValidationResult["session"]; accounts?: { providerId: string }[]; permissions?: string[] };
          setData({ user: d.user, session: d.session, accounts: d.accounts, permissions: d.permissions });
          setStatus("authenticated");
        } else {
          setData(null);
          setStatus("unauthenticated");
        }
      } else {
        setData(null);
        setStatus("unauthenticated");
      }
    } catch {
      setData(null);
      setStatus("unauthenticated");
    }
  }, [basePath]);

  useEffect(() => {
    fetchSession();
  }, [fetchSession]);

  useEffect(() => {
    if (!refetchOnWindowFocus) return;
    const onFocus = () => fetchSession();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetchOnWindowFocus, fetchSession]);

  return (
    <SessionContext.Provider value={{ data, status, update: fetchSession }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  return useContext(SessionContext);
}
