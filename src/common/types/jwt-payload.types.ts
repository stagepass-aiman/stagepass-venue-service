/**
 * JWT payload types for StagePass.
 *
 * The Auth Service signs RS256 JWTs. Every service validates them locally
 * via the JWKS endpoint (ADR-003). No per-request call to Auth Service.
 *
 * These types must stay in sync with the Auth Service's token generation.
 * If the Auth Service payload shape changes, update this file and
 * regenerate tokens in integration tests.
 */

export enum UserRole {
  CUSTOMER = 'CUSTOMER',
  ORGANISER = 'ORGANISER',
  VENUE = 'VENUE',
  ADMIN = 'ADMIN',
}

export interface JwtPayload {
  /** userId — UUID. The stable identifier for the authenticated actor. */
  sub: string;
  email: string;
  role: UserRole;
  displayName: string;
  /** JWT ID — used for revocation check against the Redis JTI blocklist in Auth Service. */
  jti: string;
  iat: number;
  exp: number;
}

/** Minimal shape attached to every request after JWT validation. */
export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: UserRole;
  displayName: string;
  jti: string;
}
