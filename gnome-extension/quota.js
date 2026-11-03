/* Smart quota refresh: decides when to start a new session window. The 5-hour session
 * limit's window only starts with the first message after the last one ended, so
 * starting it as soon as the last one ends brings the next reset sooner. Kept apart from
 * extension.js so that dev/test-quota.js can run it outside GNOME Shell.
 *
 * Written for GNOME 45+ (ES modules). dev/build-legacy.sh converts it for GNOME 42-44,
 * so export only functions and constants. */

export const SESSION_SECONDS = 5 * 60 * 60;
// How long to wait after a try before trying again, should it fail.
export const RETRY_SECONDS = 30 * 60;

// Whether to start a new session window now.
// session: the newest session reading, {used_percentage, resets_at}, or null.
// readAt: when that reading was taken. tries: {started_at, tried_at} of the last window
// this started and of its last try. All times are epoch seconds.
export function smartRefreshDue(session, readAt, tries, now) {
    if (!session) return false;
    // A window is running.
    if (session.resets_at && session.resets_at > now) return false;
    // So is the one started last, unless a reading since then says otherwise.
    if (tries.started_at && !(readAt > tries.started_at) && now < tries.started_at + SESSION_SECONDS) return false;
    if (tries.tried_at && now < tries.tried_at + RETRY_SECONDS) return false;
    return true;
}
