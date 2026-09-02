import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginRequest, LoginResponse, SessionUser, Permission } from '@neem/contracts';
import { api, ApiError } from '@/lib/api-client';

/**
 * Session state for the web app.
 *
 * What this provides is *presentation* authority — which navigation items to
 * render, which buttons to show. It is never the security boundary. Every
 * permission below is independently enforced by the API on each request
 * (spec §92).
 */

export const sessionQueryKey = ['auth', 'session'] as const;

export function useSession() {
  const query = useQuery({
    queryKey: sessionQueryKey,
    queryFn: ({ signal }) => api.get<SessionUser | null>('/auth/me', signal),
    // The session is checked on every focus, so a suspension or a logout in
    // another tab is reflected quickly rather than after a stale cache expires.
    staleTime: 30_000,
    retry: (failureCount, error) =>
      error instanceof ApiError && error.isAuthError ? false : failureCount < 2,
  });

  const user = query.data ?? null;

  return {
    user,
    isLoading: query.isLoading,
    isAuthenticated: user !== null,
    /** Admins who have not yet enrolled TOTP cannot hold a session at all. */
    mustEnrollTwoFactor: user?.mustEnrollTwoFactor ?? false,
    can: (permission: Permission) => user?.permissions.includes(permission) ?? false,
    refetch: query.refetch,
  };
}

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: LoginRequest) => api.post<LoginResponse>('/auth/login', input),
    onSuccess: (result) => {
      if (result.status === 'AUTHENTICATED') {
        void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      }
    },
  });
}

export interface TwoFactorEnrollment {
  secret: string;
  keyUri: string;
  /** PNG data URI rendered by the API, so the web app needs no QR library. */
  qrDataUrl: string;
  challengeId: string;
}

export function useBeginTwoFactorEnrollment() {
  return useMutation({
    mutationFn: (challengeId: string) =>
      api.post<TwoFactorEnrollment>('/auth/2fa/enroll', { challengeId }),
  });
}

export interface TwoFactorResult extends Extract<LoginResponse, { status: 'AUTHENTICATED' }> {
  /** Returned exactly once, at enrolment. There is no route to fetch them again. */
  recoveryCodes?: string[];
}

export function useVerifyTwoFactor() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { challengeId: string; code: string }) =>
      api.post<TwoFactorResult>('/auth/2fa/verify', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<{ status: string }>('/auth/logout'),
    onSettled: () => {
      // Clear everything, not just the session: cached dashboard data belongs
      // to the account that just signed out.
      queryClient.clear();
    },
  });
}

/**
 * Asks for a reset link.
 *
 * The response is identical whether or not the address has an account —
 * `deliveryConfigured` says only whether Neem can send anything at all, which
 * is a property of the deployment, not of the account.
 */
export function useRequestPasswordReset() {
  return useMutation({
    mutationFn: (email: string) =>
      api.post<{ status: string; deliveryConfigured: boolean }>('/auth/password-reset/request', {
        email,
      }),
  });
}

export function useConfirmPasswordReset() {
  return useMutation({
    mutationFn: (input: { token: string; password: string }) =>
      api.post<{ status: string }>('/auth/password-reset/confirm', input),
  });
}
