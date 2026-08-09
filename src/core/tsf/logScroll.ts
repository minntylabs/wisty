/**
 * Whether a scrolling log should keep following what is being written to it.
 *
 * Following is for people watching output go by. Someone who has scrolled up
 * is reading, and pulling them back to the bottom every time a line arrives
 * takes the output away faster than they can read it — so the view follows
 * only while it is already at the end.
 */

/** Within this many pixels of the bottom still counts as at the end. */
export const PINNED_SLACK_PX = 24;

export type ScrollPosition = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export const isPinnedToBottom = (position: ScrollPosition): boolean =>
  position.scrollHeight - position.scrollTop - position.clientHeight <= PINNED_SLACK_PX;
