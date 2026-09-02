/**
 * Decides whether a rejected response may end the stored session.
 *
 * The server sets X-Auth-Error on every request it refuses, including ones that
 * arrived with no token at all. Treating all of them as "the session is over"
 * clears tokens that the response has nothing to say about:
 *
 * - a request sent with no token (a provider mounted above the auth gate, or
 *   any call issued before login) is always refused, and
 * - a request that left before login carries a token that is no longer the
 *   stored one by the time its response lands.
 *
 * Both land after login on a slow connection and wipe the token the user has
 * just been issued. Only the request that carried the token still in storage
 * says anything about the session held right now.
 */
export const shouldExpireSession = (
  hasAuthError: boolean,
  sentToken: string | null | undefined,
  storedToken: string | null | undefined,
): boolean => Boolean(hasAuthError) && Boolean(sentToken) && sentToken === storedToken;
