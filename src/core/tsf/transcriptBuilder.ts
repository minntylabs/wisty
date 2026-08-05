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
 * Longest speaker name transcriptParser will recognise (LABEL_PATTERN caps the
 * name at 60 characters; a longer one stops the line being read as a turn).
 */
const MAX_SPEAKER_LENGTH = 60;

/**
 * A speaker name the transcript parser will actually accept as a label.
 *
 * The parser reads `NAME:` at the start of a line, rejects a name containing
 * sentence punctuation — so ordinary prose with a colon is not mistaken for a
 * turn — and caps the length. A name taken verbatim from a VTT voice span can
 * violate all three, and the failures are quiet:
 *
 *   `<v Interviewer: Jane>` would yield "Interviewer: Jane: …", which parses as
 *   a turn belonging to "Interviewer" with "Jane: …" as its words. The speaker
 *   is then simply wrong, which is the fault this whole feature exists to help
 *   someone correct.
 *
 *   `<v Dr. Smith>` would yield a line the parser declines to treat as a turn
 *   at all, because of the full stop, so tidy mode would do nothing on it.
 *
 * So the label is adjusted to fit, and the recording's own name is preserved
 * untouched in the cue data. Altering someone's speaker name is unwelcome, but
 * less so than attributing their words to the wrong person.
 */
export const speakerLabel = (speaker: string): string => {
  const cleaned = speaker
    // Colons end the label, so one inside it would split the name.
    .replace(/:/g, " -")
    // Sentence punctuation makes the parser reject the name outright.
    .replace(/[.!?,;]/g, "")
    // A marker in a label would render as an icon on the speaker's name and be
    // picked up as a real time by anything reading the document.
    .replace(/[⟦⟧]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, MAX_SPEAKER_LENGTH).trim();
};

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
    const label = currentSpeaker ? speakerLabel(currentSpeaker) : "";
    blocks.push(label ? `${label}: ${body}` : body);
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
