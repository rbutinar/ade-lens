"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { authEnabled, currentUser, signIn, signOut } from "@/lib/auth/browser";

/**
 * The chrome of a Report Lens-only deployment: the name and the Entra sign-in — the identity every
 * Power BI call is made as (OBO). With NEXT_PUBLIC_LENS_AUTH unset the page runs on the mock road
 * and the control is not shown.
 */
export function LensShell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!authEnabled()) return;
    let active = true;
    void currentUser()
      .then((u) => {
        if (active) setUser(u);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // popup dismissed / failed — keep the state the control shows
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-full">
      <nav className="bg-slate-800">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/app/lens" className="whitespace-nowrap text-lg font-bold tracking-tight text-white">
            ade<span className="text-sky-400">-lens</span>
          </Link>
          {authEnabled() && (
            <div className="flex items-center gap-3 text-sm">
              {user && <span className="hidden text-gray-300 sm:inline">{user}</span>}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    if (user) {
                      await signOut();
                      setUser(null);
                    } else {
                      setUser(await signIn());
                    }
                  })
                }
                className="rounded-md bg-sky-500 px-3 py-1.5 font-medium text-white hover:bg-sky-400 disabled:opacity-60"
              >
                {user ? "Sign out" : "Sign in to Power BI"}
              </button>
            </div>
          )}
        </div>
      </nav>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
