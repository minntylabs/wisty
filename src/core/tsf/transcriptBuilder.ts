/**
 * Turns parsed subtitle cues into the transcript text that goes inside a .tsf:
 * speaker-labelled lines with an inline time marker introducing each cue.
 *
 *     ALICE: ⟦734.12–736.80⟧So we walked down. ⟦736.80–740.15⟧And then it rained.
 *
 *     BOB: ⟦742.90–745.30⟧Did you?
 *
 * Two rules from the format, both load-bearing:
 *
 *   - A marker sits flush against the first character of the cue it
 *     introduces, never with a space between. Hiding a marker then leaves no
 *     orphaned gap, and "immediately preceding, zero whitespace" is the test
 *     transcript tidy mode uses to decide a marker travels with its sentence.
 *
 *   - A turn's first marker follows the speaker label, never starts the line.
 *     transcriptParser's LABEL_PATTERN would otherwise read the marker as part
 *     of the speaker name, reject it for containing a full stop, and quietly
 *     stop treating the line as a turn.
 *
 * Consecutive cues from one speaker join into a single line, matching how
 * diarized transcripts are already written and what transcriptParser expects.
 */

import { formatMarker } from "../editor/markers/markerParser";
import type { Cue } from "./vtt";

/** Blocks are separated by a blank line, as diarized transcripts already are. */
const BLOCK_SEPARATOR = "\n\n";

/**
 * The transcript text for `cues`.
 *
 * Cue times are used exactly as given: this does not split, merge or re-time
 * anything. Whoever produced the file decided the granularity, and one marker
 * per cue is the whole of the mapping.
 */
export const buildTranscript = (cues: readonly Cue[]): string => {
  const blocks: string[] = [];
  let currentSpeaker: string | undefined;
  let parts: string[] = [];

  const flush = () => {
    if (parts.length === 0) {
      return;
    }
    const body = parts.join(" ");
    blocks.push(currentSpeaker ? `${currentSpeaker}: ${body}` : body);
    parts = [];
  };

  for (const cue of cues) {
    if (cue.speaker !== currentSpeaker) {
      flush();
      currentSpeaker = cue.speaker;
    }
    // Flush against the text, hence no separator between marker and cue.
    parts.push(`${formatMarker(cue.start, cue.end)}${cue.text}`);
  }
  flush();

  return blocks.join(BLOCK_SEPARATOR);
};
