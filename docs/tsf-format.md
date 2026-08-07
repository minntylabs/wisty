# The `.tsf` transcript container

A `.tsf` file holds an interview transcript together with the recording it was
made from, so the two cannot be separated. Wisty opens one as an ordinary
document; clicking the speaker icon beside a sentence plays the audio that
sentence was transcribed from.

This document specifies the format and records the decisions behind it. It is
written so that a `.tsf` produced by other software will work, and so that a
`.tsf` produced by Wisty can be read by other software.

## Why it exists

A transcript is what a speech model heard, not what was said. Place names come
out garbled, words are missed, and a diarizer will sometimes give one speaker's
question to the other. Reading cannot settle any of that — only listening to
that passage can.

Doing so by hand means locating the moment in a separate audio player, for every
doubt, in a recording that may run half an hour. In practice the doubts go
unchecked. Two things have to hold to fix that: the editor must know which part
of the audio each sentence came from and still know it after the text has been
edited, and the transcript and its audio must travel together.

## Container layout

A `.tsf` is a zip archive. That choice is deliberate and worth keeping: when
something goes wrong, anyone can rename it to `.zip` and get their transcript
out. That property is worth more than any efficiency.

| Member | Required | Contents |
|---|---|---|
| `transcript.txt` | yes | UTF-8 text, with inline time markers |
| `meta.json` | yes | Format version and provenance |
| *audio member* | yes | The recording. Named by `meta.json`, not by convention |
| `words.json` | no | Per-word timings. Ignored by Wisty |

The audio member's name comes from `meta.json`'s `audio.file`. Wisty writes
`audio.m4a`, but a reader must use the name it is given rather than assume one.

That name is untrusted input — it is a string from the file being opened, and
`"../../etc/passwd"` is a legal string. Use it only as a name inside the archive
unless you have validated it.

`words.json` exists so that a producer with word-level timings can carry them.
Wisty never writes one and never reads one; the markers carry everything the
editor uses.

## `meta.json`

```json
{
  "tsf_version": 1,
  "audio": {
    "file": "audio.m4a",
    "codec": "aac",
    "duration": 1709.618
  },
  "source": {
    "recording": "interview-04.m4a",
    "recorded": "2025-03-11"
  },
  "generator": {
    "tool": "example-transcriber",
    "version": "1.2.0",
    "asr_model": "...",
    "diarization_model": "...",
    "generated": "2026-08-05T14:22:00Z"
  }
}
```

`tsf_version` is the only field a reader must understand. It moves for a
breaking change and not for an added field.

`audio` is an object rather than an array: one recording per container.
`duration` is in seconds and is a sanity check, never a source of truth — the
audio file is authoritative, and a decoder reports duration from the container
itself. A last marker beyond `duration` means something is wrong somewhere.
`codec` is informational, for a human who has unzipped the file.

`source.recording` names the file that was imported, which is not the same as
the member's name: the audio is converted on the way in, so this is the only
record of where it came from.

`generator` is pure provenance. No code reads it. It is deliberately generous,
because these recordings will outlive the tooling and "which model produced this
transcript" is otherwise unanswerable later.

### The unknown-key rule

**A reader must ignore keys it does not recognise.** This, rather than the shape
of the schema, is what lets the format grow: a producer can add fields freely,
and only a breaking change moves `tsf_version`. It is written down explicitly
because it is exactly the rule a strict deserializer violates by default — do
not deny unknown fields when parsing this.

## The audio member

Any format the reader can decode. Wisty decodes with
[symphonia](https://github.com/pdeljanov/symphonia), and writes **AAC-LC, mono,
64 kbps, in m4a**.

Two notes for anyone writing a producer:

**Avoid HE-AAC.** symphonia refuses it — its AAC decoder is LC-only and rejects
a stream whose configuration sets the SBR flag. Older versions silently decoded
the low-frequency core instead, which is arguably worse, since the file plays
but has quietly lost its high band.

**Convert on the way in, not on the way out.** Deciding the audio format when
the container is built moves the compatibility question to a machine where
somebody can see it fail, rather than to playback, later, as an error in the
middle of someone's work. It also decouples what a producer accepts from what
any particular decoder happens to support.

## The transcript

`transcript.txt` is plain text and remains meaningful without any of this
tooling. Open it in anything and the times are visible, if ugly.

### Speaker turns

One line per turn, introduced by a label:

```
ALICE: ⟦734.12–736.80⟧So we walked down to Bath. ⟦736.80–740.15⟧And then it rained.

BOB: ⟦742.90–745.30⟧Did you?
```

The label is a name, a colon, and the gap before the text. A leading `[...]`
timestamp before the name is tolerated and ignored.

A name may not contain a colon or sentence punctuation (`.!?,;`) and is capped
at 60 characters — otherwise it is not recognised as a label and the line is
treated as prose. A producer must sanitise names to fit rather than emit them
verbatim: `Dr. Smith` and `Interviewer: Jane` both break the parse, the first by
being rejected and the second by attributing the words to a speaker called
"Interviewer".

### Time markers

```
⟦734.12–736.80⟧
```

Start and end, in seconds from the beginning of the audio, two decimal places,
separated by an **en dash** (U+2013 — not a hyphen), wrapped in **mathematical
white square brackets** (U+27E6 and U+27E7).

The exact codepoints matter. Written as escapes rather than literals in the
implementation, because all three are easy to confuse with commoner lookalikes
and a mismatch between what a producer writes and what a reader matches would be
invisible on the page.

The grammar is deliberately strict — two digits after each point, exactly — so
that a damaged marker fails to match and appears as literal text, which is
obviously wrong at a glance, rather than matching loosely and pointing silently
at the wrong audio.

The characters were chosen so they cannot occur in transcribed speech, cannot
collide with the bracketed timestamp a label may carry, and are visibly wrong
when damaged.

**Each marker is self-describing.** Carrying both times, rather than a single
point per sentence, means playback never consults a neighbouring marker: nothing
about a snippet depends on what is still in the document around it. This removes
an entire class of problem — no nearest-enclosing search, no behaviour that
changes when the previous sentence is deleted.

**Placement.** A marker sits flush against the sentence it introduces, with no
space between, and never at the start of a line before the speaker label. Both
rules are load-bearing:

- A line-leading marker would be read as part of the speaker's name, and then
  rejected for containing a full stop.
- Flush placement is what makes "the marker introducing this sentence"
  unambiguous — it is the one touching the first word, with nothing between.
  Editors use that to decide whether a marker travels when a sentence is moved
  to another speaker.

**Granularity is free.** One marker per cue of whatever the producer emitted. A
tool with word-level timings can emit one per sentence; a tool with coarser
output can emit one per paragraph. Nothing downstream cares, because no marker
depends on another.

### Editing guarantees

Markers are characters in the document, not positions held alongside it. That is
what makes them survive: deleting a range of text cannot disturb a token outside
the range, order and identity are preserved because the tokens *are* the
document, and undo, dirty state and files edited elsewhere all work with no
special handling.

The price is that an edit can land *inside* a token. An editor implementing this
format must prevent that, because the failure is silent — a damaged marker
either parses as a different time or stops parsing and becomes prose. Wisty does
it in two layers: the caret steps over a marker rather than into it, and any
transaction that would leave a fragment behind is rejected whole rather than
repaired, since a partial repair would silently change what the user asked for.

Removing a marker entirely is fine. Deleting a speaker turn takes its markers
with it, which is ordinary editing.

## Where `.tsf` files come from

The input is **a timed transcript plus an audio file, and nothing else.**

The transcript is WebVTT or SRT. VTT is a W3C standard, it is what nearly every
captioning tool emits, and it carries everything the format needs — text, times,
and speakers via voice spans:

```
WEBVTT

00:12:14.120 --> 00:12:16.800
<v ALICE>So we walked down to Bath.

00:12:16.800 --> 00:12:20.150
<v ALICE>And then it rained.
```

One cue becomes one marker: its bounds become the marker's times, its voice span
becomes the speaker label. SRT is accepted as a degraded case — same cue
structure, no standard speaker mechanism, so an SRT-derived transcript has no
labels.

Cue timestamps are millisecond-precision and markers are two decimals, so times
round on import. That is harmless against word timings accurate to roughly
±150 ms.

**Why a standard format rather than a transcriber's own output.** The input
surface has to be something that can be specified, tested against files the
implementation did not produce, and explained to a stranger. A particular tool's
JSON is none of those: "Whisper JSON" is not one format — the reference
implementation, the OpenAI API and whisper.cpp all differ, and they drift with
their versions. Supporting that family means supporting a moving target.

It also keeps the importer small. No sentence splitting, no speaker assignment,
no alignment — those move to whoever produced the VTT, which is the only place
with the word-level timings needed to do them well.

## Playback

Wisty plays spans natively rather than through the webview, using symphonia to
decode and [rodio](https://github.com/RustAudio/rodio) to drive the device. The
audio member is read into memory when the container is opened and released when
it closes.

A span is decoded and handed to the device as a finished buffer, so its
boundaries are exact. A span stopped by a timer would drift, and the failure
would be inaudible until it was wrong by a word.

Spans are padded at both ends before playing — Wisty uses 0.25 s at the head and
0.35 s at the tail. Word timings from a speech model are accurate to roughly
±150 ms, and word *end* times in particular run short, so playing exactly to a
stored end time cuts off partway through the final word. The padding is applied
at playback and never baked into the stored times, which stay the truth of what
was said.

## Implementation notes

If you are reading the source rather than writing your own implementation:

| Concern | Where |
|---|---|
| Marker grammar, parsing, formatting | `src/core/tsf/markers.ts` |
| VTT/SRT parsing | `src/core/tsf/vtt.ts` |
| Building transcript text from cues | `src/core/tsf/transcriptBuilder.ts` |
| `meta.json` schema | `src/core/tsf/metaJson.ts` |
| Container read/write | `src-tauri/src/tsf.rs` |
| Playback | `src-tauri/src/playback.rs`, `src/core/audio/` |
| Rendering and edit protection | `src/core/editor/markers/` |

Building Wisty from source on Linux additionally requires the ALSA development
headers for playback; see the README's build prerequisites.

See also [WebKitGTK accessibility crash](webkitgtk-accessibility-crash.md) for a
browser bug this feature ran into, which is worth knowing about if you are
building anything with a rich-text editor on WebKitGTK.
