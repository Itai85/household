/**
 * Auth context — manages user session via Supabase Auth.
 * When Supabase isn't configured, provides a "local mode" that skips auth entirely.
 */
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { isSupabaseConfigured, getSupabase } from '../platform/supabase';
import type { User, Session } from '@supabase/supabase-js';

interface AuthState {
  /** Current user, or null if not logged in / local mode */
  user: User | null;
  /** Whether auth is still loading */
  loading: boolean;
  /** Whether we're in cloud mode (Supabase configured) */
  isCloudMode: boolean;
  /** Sign in with Google OAuth */
  signInWithGoogle: () => Promise<void>;
  /** Sign in with magic link (email) */
  signInWithEmail: (email: string) => Promise<{ error?: string }>;
  /** Sign out */
  signOut: () => Promise<void>;
  /** Delete account and all data */
  deleteAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      // Local mode — no auth needed
      setLoading(false);
      return;
    }

    const supabase = getSupabase();

    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
      },
    );

    return () => subscription.unsubscribe();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    const supabase = getSupabase();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
    if (error) throw error;
  }, []);

  const signInWithEmail = useCallback(async (email: string) => {
    if (!isSupabaseConfigured) return { error: 'Not in cloud mode' };
    const supabase = getSupabase();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) return { error: error.message };
    return {};
  }, []);

  const signOut = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    const supabase = getSupabase();
    await supabase.auth.signOut();
    setUser(null);
  }, []);

  const deleteAccount = useCallback(async () => {
    if (!isSupabaseConfigured || !user) return;
    const supabase = getSupabase();

    // Delete all user data (RLS ensures we only delete our own)
    await supabase.from('files').delete().eq('user_id', user.id);
    await supabase.from('documents').delete().eq('user_id', user.id);
    await supabase.from('bills').delete().eq('user_id', user.id);
    await supabase.from('services').delete().eq('user_id', user.id);

    // Sign out (actual user record deletion requires admin/edge function)
    await supabase.auth.signOut();
    setUser(null);
  }, [user]);

  const value: AuthState = {
    user,
    loading,
    isCloudMode: isSupabaseConfigured,
    signInWithGoogle,
    signInWithEmail,
    signOut,
    deleteAccount,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
