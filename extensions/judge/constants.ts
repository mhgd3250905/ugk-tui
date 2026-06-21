/**
 * Judge module constants.
 *
 * Centralizes magic numbers that were previously scattered across
 * judge-state.ts, judge-driver.ts, and delivery.ts so they can be tuned
 * in one place.
 */

/** Default maximum number of steering interventions before Judge escalates. */
export const DEFAULT_MAX_STEER = 5;

/** Maximum transcript events retained in the driver's ring buffer. */
export const TRANSCRIPT_RING_BUFFER_LIMIT = 200;
