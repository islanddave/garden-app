// Harness-only @clerk/react stand-in. Aliased in vite.harness.config.mjs so the harness can mount
// authed pages WITHOUT a Clerk session — the in-app Browser pane is not Dave's signed-in Chrome, so
// loading the real app there always lands on the auth gate and nothing can be measured.
// NOTHING in src/ imports this; the alias exists only inside the harness vite config.
import React from 'react'

const USER = { id: 'harness_user', firstName: 'Harness', fullName: 'Harness User', primaryEmailAddress: { emailAddress: 'harness@example.invalid' } }

// STABLE IDENTITIES ARE LOAD-BEARING, not tidiness. useApiFetch memoizes on [getToken]; a fresh
// function per render makes apiFetch a new identity every render, which is a dep of EventNew's load
// effects — the first version of this stub returned a literal and produced an infinite
// fetch/setState loop (10 duplicate /api/plants before the page even settled). Real Clerk returns
// stable references, so a stub that does not is measuring a bug the app does not have.
const getToken = async () => 'harness-token'
const signOut = async () => {}
const AUTH = { isLoaded: true, isSignedIn: true, userId: USER.id, sessionId: 'harness_session', getToken, signOut }
const USER_STATE = { isLoaded: true, isSignedIn: true, user: USER }

export function useAuth() { return AUTH }
export function useUser() { return USER_STATE }
const CLERK = { signOut, openSignIn: () => {} }
const SESSION = { isLoaded: true, session: { id: 'harness_session' } }
export function useClerk() { return CLERK }
export function useSession() { return SESSION }
export function ClerkProvider({ children }) { return <>{children}</> }
export function SignedIn({ children }) { return <>{children}</> }
export function SignedOut() { return null }
export function RedirectToSignIn() { return null }
export function SignIn() { return null }
export function SignUp() { return null }
export function UserButton() { return null }
export function AuthenticateWithRedirectCallback() { return null }
