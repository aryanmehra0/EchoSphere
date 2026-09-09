"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { UserProfile } from "./types";
import { DEV_PERSONAS, DEFAULT_USER, findPersonaById } from "./auth-personas";
import { fetchSessionUser, persistSessionUser } from "./delta-socket";

interface AuthContextValue {
  user: UserProfile;
  availableUsers: readonly UserProfile[];
  switchUser: (userId: string) => Promise<void>;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserProfile>(DEFAULT_USER);
  const [loading, setLoading] = useState(true);

  // Sync with /api/auth/me on mount via approved Zone 1 egress module (delta-socket)
  useEffect(() => {
    let mounted = true;
    async function loadUser() {
      try {
        const fetched = await fetchSessionUser();
        if (mounted && fetched) {
          setUser(fetched);
        }
      } catch {
        // Fallback to DEFAULT_USER on offline/error
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void loadUser();
    return () => {
      mounted = false;
    };
  }, []);

  const switchUser = useCallback(async (userId: string) => {
    const localMatch = findPersonaById(userId);
    if (localMatch) {
      setUser(localMatch);
    }
    try {
      const persisted = await persistSessionUser(userId);
      if (persisted) {
        setUser(persisted);
      }
    } catch (err) {
      console.warn("[auth] Failed to persist user switch to server", err);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        availableUsers: DEV_PERSONAS,
        switchUser,
        loading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}
