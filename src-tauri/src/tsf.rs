//! Writing .tsf transcript containers.
//!
//! A .tsf is a zip archive holding the transcript, the recording it was made from, and
//! a little metadata. Zip is chosen so that when something goes wrong, someone can
//! rename the file to .zip and get their transcript out — a property worth more here
//! than any efficiency.
//!
//! The split of responsibilities is deliberate. This side owns the container and the
//! audio: the archive, and bytes too large to send across the bridge. The frontend owns
//! the transcript text and the time-marker format, and hands it here as a finished
//! string. Nothing in this file knows what a marker looks like, which is what keeps the
//! marker format defined in exactly one place.

use std::fs::{File, Metadata, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::codecs::CodecParameters;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::Timestamp;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

/// The transcript member's name inside the archive. Fixed: a reader looks for it by
/// name, and meta.json names only the audio member, which can vary.
const TRANSCRIPT_MEMBER: &str = "transcript.txt";
const META_MEMBER: &str = "meta.json";
const WORDS_MEMBER: &str = "words.json";
const TEMPORARY_CREATE_ATTEMPTS: usize = 16;
static SAVE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize)]
pub struct CreateTsfResult {
    pub path: String,
    /// Seconds, as read from the audio itself rather than taken on trust.
    pub duration: f64,
    pub codec: String,
    pub bytes: u64,
}

/// What the audio file itself says about itself.
#[derive(Serialize)]
struct AudioFacts {
    duration: f64,
    codec: String,
    /// Whether the player can read it, or it has to be converted on the way in.
    ///
    /// Answered from the same probe as the rest: asking separately meant opening
    /// and parsing the recording twice for one dialog, which is a wait the user
    /// sits through on a large file.
    playable: bool,
}

/// Reads duration and codec from the recording.
///
/// meta.json carries both, but they are filled here rather than by the caller because
/// this is the side already opening the audio, and a value derived from the file cannot
/// disagree with the file. The caller's copy is only ever a convenience for readers.
fn probe_audio(path: &Path) -> Result<AudioFacts, String> {
    let file = File::open(path).map_err(|error| format!("Cannot open audio file: {error}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let reader = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|error| format!("Unrecognised audio format: {error}"))?;

    let track = reader
        .tracks()
        .iter()
        .find(|track| {
            track
                .codec_params
                .as_ref()
                .is_some_and(CodecParameters::is_audio)
        })
        .ok_or_else(|| "The audio file contains no audio track".to_string())?;

    // The container's stated duration is preferred over a count of frames: a track's
    // timebase is not always the reciprocal of the frame rate, so the two can disagree
    // slightly, and the container's figure is the one a player will agree with.
    let time_base = track
        .time_base
        .ok_or_else(|| "The audio track has no timebase".to_string())?;
    let ticks = track
        .duration
        .map(|duration| duration.get() as i64)
        .or_else(|| track.num_frames.map(|frames| frames as i64))
        .ok_or_else(|| "Cannot determine the audio duration".to_string())?;
    let duration = time_base
        .calc_time(Timestamp::new(ticks))
        .ok_or_else(|| "The audio duration does not fit in a time value".to_string())?
        .as_secs_f64();

    let codec = match track.codec_params.as_ref() {
        Some(CodecParameters::Audio(audio)) => symphonia::default::get_codecs()
            .get_audio_decoder(audio.codec)
            .map(|registered| registered.codec.info.short_name.to_string())
            .unwrap_or_else(|| "unknown".to_string()),
        _ => "unknown".to_string(),
    };

    // A codec the registry names is not necessarily one it can decode: HE-AAC
    // reports "aac" and is still refused, which is the whole reason conversion
    // exists. Only building the decoder settles it.
    let playable = match track.codec_params.as_ref() {
        Some(CodecParameters::Audio(audio)) => symphonia::default::get_codecs()
            .make_audio_decoder(audio, &AudioDecoderOptions::default())
            .is_ok(),
        _ => false,
    };

    Ok(AudioFacts {
        duration,
        codec,
        playable,
    })
}

/// Fills in the parts of meta.json this side is responsible for.
///
/// The draft arrives as free-form JSON and is augmented rather than reparsed into a
/// struct, so fields the frontend knows about and this side does not survive the trip.
/// That is the format's unknown-key rule applied to writing as well as reading: a
/// producer may add fields without every reader having to learn them first.
fn complete_meta(
    mut draft: serde_json::Value,
    facts: &AudioFacts,
    audio_member: &str,
) -> Result<Vec<u8>, String> {
    let object = draft
        .as_object_mut()
        .ok_or_else(|| "Metadata must be a JSON object".to_string())?;

    let audio = object
        .entry("audio")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "Metadata `audio` must be an object".to_string())?;

    audio.insert(
        "file".into(),
        serde_json::Value::String(audio_member.to_string()),
    );
    audio.insert(
        "codec".into(),
        serde_json::Value::String(facts.codec.clone()),
    );
    audio.insert(
        "duration".into(),
        serde_json::Number::from_f64(facts.duration)
            .map(serde_json::Value::Number)
            .ok_or_else(|| "Audio duration is not a finite number".to_string())?,
    );

    serde_json::to_vec_pretty(&draft).map_err(|error| format!("Cannot serialise metadata: {error}"))
}

/// Whether two paths name the same file, resolving symlinks and `..`.
///
/// The output usually does not exist yet, so it cannot be canonicalised
/// directly; its directory can be, which is enough to compare against a file
/// that does exist.
fn same_file(output: &Path, existing: &Path) -> bool {
    let Ok(existing) = existing.canonicalize() else {
        return false;
    };
    let resolved = match (output.parent(), output.file_name()) {
        (Some(parent), Some(name)) => parent
            .canonicalize()
            .map(|dir| dir.join(name))
            .unwrap_or_else(|_| output.to_path_buf()),
        _ => output.to_path_buf(),
    };
    resolved == existing
}

/// The audio member's filename, taken from the source recording.
///
/// The extension is kept because the audio is stored exactly as it arrived — there is
/// no transcode — so calling an m4a anything else would be a lie to whoever unzips it.
/// Whether the player could actually decode this recording, not merely read its
/// headers.
///
/// The distinction is the whole of §5.6. Probing a HE-AAC file succeeds and
/// reports its duration and codec quite happily; constructing a decoder for it
/// is what fails, because symphonia 0.6 refuses AAC with SBR. Nothing noticed
/// for a while precisely because this file only ever probed, and the first code
/// to build a decoder was playback — months after the container was written.
fn audio_is_playable(path: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let Ok(reader) = symphonia::default::get_probe().probe(
        &hint,
        mss,
        FormatOptions::default(),
        MetadataOptions::default(),
    ) else {
        return false;
    };
    let Some(track) = reader.tracks().iter().find(|track| {
        track
            .codec_params
            .as_ref()
            .is_some_and(CodecParameters::is_audio)
    }) else {
        return false;
    };
    let Some(CodecParameters::Audio(params)) = track.codec_params.as_ref() else {
        return false;
    };
    let decoder: Result<Box<dyn AudioDecoder>, _> = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default());
    decoder.is_ok()
}

/// The recording as it will be stored, and whether it had to be made first.
///
/// The conversion's output is deleted when this goes out of scope, on every
/// path out of the write including the failures.
struct PreparedAudio {
    path: PathBuf,
    temporary: bool,
}

impl PreparedAudio {
    fn path(&self) -> &Path {
        &self.path
    }

    /// Whether ffmpeg made this, and so whether it still has to prove itself.
    fn was_converted(&self) -> bool {
        self.temporary
    }
}

impl Drop for PreparedAudio {
    fn drop(&mut self) {
        if self.temporary {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Converts to something the player can read, when it has to.
///
/// §5.6 decided the conversion belongs at import time rather than at playback:
/// it moves the compatibility question to a moment where the user is choosing
/// files and can see it fail, instead of to a dialog months later in the middle
/// of a sentence. It also decouples what may be imported from what one Rust
/// decoder happens to accept, which is the difference between an input surface
/// that can be explained — "any audio file" — and one that cannot.
///
/// Anything symphonia can already decode is stored untouched, so the common
/// case needs no ffmpeg and loses nothing to a second lossy encode.
fn prepare_audio_for_container(
    source: &Path,
    state: Option<&ConversionState>,
) -> Result<PreparedAudio, String> {
    if audio_is_playable(source) {
        return Ok(PreparedAudio {
            path: source.to_path_buf(),
            temporary: false,
        });
    }
    Ok(PreparedAudio {
        path: convert_to_playable_audio(source, state)?,
        temporary: true,
    })
}

/// What a conversion in progress can be asked, and told, from elsewhere.
///
/// ffmpeg's own output is the progress report: it says what it is reading, what
/// it is writing and how far through it is, and inventing a summary of that
/// would be both more work and less true. The lines are buffered here for the
/// window to collect, rather than pushed to it, because polling needs no event
/// permission and no listener to unregister — and this lasts seconds.
#[derive(Default)]
pub struct ConversionState {
    inner: Mutex<Option<RunningConversion>>,
    /// Outlives the conversion it stopped.
    ///
    /// Converting is one step of an import, and packaging the container after
    /// it takes seconds more. A cancellation that only reached the running
    /// ffmpeg would be ignored if it arrived a moment later, and the import the
    /// user stopped would finish and open anyway. Cleared when an import
    /// starts, which is the only thing that makes a cancellation stale.
    cancelled: AtomicBool,
}

struct RunningConversion {
    /// Held so it can be killed from another thread. Taken out to be waited on.
    child: Option<std::process::Child>,
    /// Whether ffmpeg has finished.
    ///
    /// The record outlives the process. Clearing it away at the end discarded
    /// whatever had been said since the last collection — which is exactly the
    /// output that explains a failure, since it is printed immediately before
    /// exit, and the last collection happens after this point.
    finished: bool,
    lines: Vec<String>,
    /// The recording's length, as ffmpeg reports it before it starts.
    duration_secs: Option<f64>,
    /// How far into the recording it has got.
    position_secs: Option<f64>,
}

/// What the window shows: ffmpeg's words, and how far through it is.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConversionOutput {
    /// What it has said since this was last called.
    lines: Vec<String>,
    duration_secs: Option<f64>,
    position_secs: Option<f64>,
    /// Whether ffmpeg is still running.
    ///
    /// Building a container is two steps — converting, then packaging — and the
    /// window has to tell them apart. Judging by whether anything has been said
    /// would leave it claiming to convert long after ffmpeg had finished, with
    /// its bar stuck at the end.
    running: bool,
}

/// `HH:MM:SS.mmm`, which is how ffmpeg writes both a duration and a position.
fn parse_timestamp(value: &str) -> Option<f64> {
    let mut seconds = 0.0;
    let mut parts = 0;
    for field in value.trim().trim_end_matches(',').split(':') {
        let field: f64 = field.parse().ok()?;
        seconds = seconds * 60.0 + field;
        parts += 1;
    }
    (parts == 3).then_some(seconds)
}

/// Reported distinctly from a failure: the user asking for it to stop is not an
/// error, and the import that asked ends quietly rather than in a dialog.
const CONVERSION_CANCELLED: &str = "The import was cancelled.";

/// The fields `-progress` writes, which move the bar and are not shown.
///
/// Named rather than matched by shape. "Any lowercase word before an equals
/// sign" also describes things ffmpeg says in words, and a warning silently
/// filed as a progress reading would vanish from the output with nothing left
/// to say it had ever been printed.
const PROGRESS_FIELDS: [&str; 12] = [
    "frame",
    "fps",
    "bitrate",
    "total_size",
    "out_time_us",
    "out_time_ms",
    "out_time",
    "dup_frames",
    "drop_frames",
    "speed",
    "progress",
    // ffmpeg's own status line, which says what the bar says. `-nostats` stops
    // it being printed; this is here for an ffmpeg that ignores that.
    "size",
];

/// How much of ffmpeg's tail is kept to explain a failure with.
const FAILURE_LINES_KEPT: usize = 12;

/// Which of ffmpeg's last words actually says what went wrong.
///
/// Not simply the last one. ffmpeg signs off with `Conversion failed!` after a
/// line of encoder statistics, so the last line is reliably the least useful
/// thing it said: the cause — no space, no such file, invalid data — is several
/// lines above. Measured against a real failing conversion, not guessed at.
fn failure_reason(said: &[String]) -> String {
    // The one line ffmpeg always ends a failure with, and the only one that
    // says nothing at all. Its encoder statistics are thin, but they are a fact
    // about this conversion and this is the last resort.
    const SIGN_OFFS: [&str; 1] = ["Conversion failed!"];
    let explains = |line: &&String| {
        let lowered = line.to_lowercase();
        [
            "error",
            "invalid",
            "no space",
            "denied",
            "not found",
            "unable",
            "cannot",
            "failed to",
        ]
        .iter()
        .any(|word| lowered.contains(word))
    };

    if let Some(reason) = said.iter().rev().find(explains) {
        return reason.clone();
    }
    said.iter()
        .rev()
        .find(|line| !SIGN_OFFS.iter().any(|sign_off| line.contains(sign_off)))
        .cloned()
        .unwrap_or_else(|| {
            said.last()
                .cloned()
                .unwrap_or_else(|| "no output".to_string())
        })
}

fn is_progress_field(line: &str) -> bool {
    let Some((key, _)) = line.split_once('=') else {
        return false;
    };
    // `stream_0_0_q`, one per output stream, numbered by ffmpeg.
    let is_stream_quality = key
        .strip_prefix("stream_")
        .and_then(|rest| rest.strip_suffix("_q"))
        .is_some_and(|middle| {
            middle.split('_').count() == 2
                && middle.split('_').all(|part| {
                    !part.is_empty() && part.chars().all(|character| character.is_ascii_digit())
                })
        });
    PROGRESS_FIELDS.contains(&key) || is_stream_quality
}

/// Why building a container did not happen, by code rather than by message.
///
/// The frontend has to tell a cancellation from a failure — one closes the
/// window quietly, the other explains itself — and reading a message to decide
/// is how that goes wrong the first time someone rewords it.
#[derive(Serialize)]
pub struct CreateTsfError {
    code: &'static str,
    message: String,
}

const IMPORT_FAILED: &str = "IMPORT_FAILED";
const IMPORT_CANCELLED: &str = "IMPORT_CANCELLED";

impl CreateTsfError {
    fn failed(message: String) -> Self {
        Self {
            code: IMPORT_FAILED,
            message,
        }
    }
}

impl From<String> for CreateTsfError {
    fn from(message: String) -> Self {
        if message == CONVERSION_CANCELLED {
            return Self {
                code: IMPORT_CANCELLED,
                message,
            };
        }
        Self::failed(message)
    }
}

impl ConversionState {
    /// Hands the running ffmpeg over, or hands it back unstarted.
    ///
    /// The child comes back on failure because the caller is the only one left
    /// who can stop it: a process nobody holds carries on converting into a
    /// temporary file nobody will collect.
    fn begin(&self, child: std::process::Child) -> Result<(), (String, std::process::Child)> {
        let mut guard = match self.lock() {
            Ok(guard) => guard,
            Err(error) => return Err((error, child)),
        };
        // Refused rather than replaced. Dropping a `Child` neither kills it nor
        // waits for it, so overwriting a running conversion left ffmpeg
        // encoding into a temporary nobody holds — and the startup sweep will
        // not collect that either, because the pid that owns it is alive.
        if guard.as_ref().is_some_and(|running| !running.finished) {
            return Err(("A recording is already being converted.".to_string(), child));
        }
        *guard = Some(RunningConversion {
            child: Some(child),
            finished: false,
            lines: Vec::new(),
            duration_secs: None,
            position_secs: None,
        });
        Ok(())
    }

    /// Forgets a cancellation, because a new import is not the stopped one.
    ///
    /// The finished conversion's record goes with it. It is kept past the end so
    /// that ffmpeg's last words can still be collected; keeping it past the
    /// *next* import would show that import the previous one's output, and an
    /// import that converts nothing would inherit a bar and a length as well.
    fn begin_import(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
        if let Ok(mut guard) = self.inner.lock() {
            if guard.as_ref().is_some_and(|running| running.finished) {
                *guard = None;
            }
        }
    }

    /// Records the cancellation, then stops the ffmpeg it applies to. In that
    /// order, so the import cannot read the flag as unset in between.
    pub fn request_cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(child) = guard.as_mut().and_then(|running| running.child.as_mut()) {
                let _ = child.kill();
            }
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<RunningConversion>>, String> {
        self.inner
            .lock()
            .map_err(|error| format!("Cannot reach the running conversion: {error}"))
    }

    /// Files one line of ffmpeg's output: as progress, as words, or as both.
    ///
    /// `-progress` writes blocks of `key=value` into the same stream as the
    /// log. They are what moves the bar, and they are also unreadable — a dozen
    /// lines a second, most of them `N/A` — so they move it and are not shown.
    /// The line the length comes from is ffmpeg's own `Duration:` header, and
    /// that one is worth reading, so it counts and is shown.
    fn record(&self, line: String) {
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        let Some(running) = guard.as_mut() else {
            return;
        };

        if let Some(position) = line.strip_prefix("out_time=").and_then(parse_timestamp) {
            running.position_secs = Some(position);
            return;
        }
        // The first `Duration:` only, which is the input's. A second input, or
        // an output ffmpeg chooses to describe, would otherwise move the bar's
        // scale underneath it partway through.
        if running.duration_secs.is_none() {
            if let Some(duration) = line
                .split_once("Duration:")
                .and_then(|(_, rest)| rest.split(',').next())
                .and_then(parse_timestamp)
            {
                running.duration_secs = Some(duration);
            }
        }
        if is_progress_field(&line) {
            return;
        }
        running.lines.push(line);
    }

    fn was_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Marks the conversion over, and keeps what it said for one last look.
    fn finish(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(running) = guard.as_mut() {
                running.finished = true;
                running.child = None;
            }
        }
    }
}

/// The conversion's output since it was last collected, and where it has got to.
#[tauri::command]
pub fn take_conversion_output(
    state: tauri::State<'_, ConversionState>,
) -> Result<ConversionOutput, String> {
    let mut guard = state.lock()?;
    Ok(match guard.as_mut() {
        Some(running) => ConversionOutput {
            lines: std::mem::take(&mut running.lines),
            duration_secs: running.duration_secs,
            position_secs: running.position_secs,
            running: !running.finished,
        },
        None => ConversionOutput::default(),
    })
}

/// Stops the import: the conversion now, and the packaging that follows it.
///
/// Recorded before the running ffmpeg is killed, so the import cannot read the
/// flag as unset in the moment between the two.
#[tauri::command]
pub fn cancel_audio_conversion(state: tauri::State<'_, ConversionState>) -> Result<(), String> {
    state.request_cancel();
    Ok(())
}

/// AAC-LC, mono, in m4a — symphonia's existing features exactly, no more.
///
/// ffmpeg because Wisty cannot do this itself: the reason a file needs
/// converting is that Wisty's decoder cannot read it, so whatever converts it
/// needs a decoder Wisty does not have.
fn convert_to_playable_audio(
    source: &Path,
    state: Option<&ConversionState>,
) -> Result<PathBuf, String> {
    let output = std::env::temp_dir().join(format!(
        "{CONVERSION_PREFIX}{}-{}.m4a",
        std::process::id(),
        SAVE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));

    let spawned = std::process::Command::new("ffmpeg")
        .arg("-nostdin")
        .arg("-y")
        // The bar's readings, into the same stream as the log so there is one
        // pipe to read. `-nostats` drops ffmpeg's own status line, which says
        // the same thing by overwriting itself with a carriage return — and a
        // line that never ends is a line a reader of lines never sees.
        .arg("-nostats")
        .args(["-progress", "pipe:2"])
        .arg("-i")
        .arg(source)
        // No video, no cover art: an attached picture would otherwise become a
        // stream the encoder is asked to handle.
        .arg("-vn")
        .args(["-ac", "1"])
        .args(["-c:a", "aac"])
        .args(["-profile:a", "aac_low"])
        .args(["-b:a", "64k"])
        .arg(&output)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn();

    let mut child = match spawned {
        Ok(child) => child,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(format!(
                "This recording is in a format Wisty cannot play ({}), so it has to be \
                 converted when it is imported — and that needs ffmpeg, which was not found. \
                 Install ffmpeg, or choose a recording in WAV, FLAC or AAC-LC.",
                source.display()
            ));
        }
        Err(error) => {
            return Err(format!(
                "Cannot run ffmpeg to convert the recording: {error}"
            ))
        }
    };

    let stderr = child.stderr.take();
    // Handed over before a line is read, so a cancellation arriving early has
    // something to kill rather than missing the conversion entirely. With
    // nobody watching there is nothing to hand it to, and it stays here.
    let mut unwatched_child = None;
    match state {
        Some(state) => {
            if let Err((error, mut child)) = state.begin(child) {
                // Nobody is holding it now, so it is stopped here rather than
                // left converting into a file no one will collect.
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&output);
                return Err(error);
            }
            // A cancellation between the spawn and the hand-over found nothing
            // to kill, so it is applied here instead. Without this the whole
            // recording is converted — minutes of it — before anyone notices it
            // was stopped before it began.
            if state.was_cancelled() {
                state.request_cancel();
            }
        }
        None => unwatched_child = Some(child),
    }

    let mut said = Vec::new();
    if let Some(stderr) = stderr {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            if let Some(state) = state {
                state.record(line.clone());
            }
            if is_progress_field(&line) {
                continue;
            }
            // Only the tail is kept: a failing ffmpeg can repeat itself for as
            // long as it runs, and what explains the failure is near the end.
            said.push(line);
            if said.len() > FAILURE_LINES_KEPT {
                said.remove(0);
            }
        }
    }

    let status = match state {
        Some(state) => {
            let taken = state
                .lock()?
                .as_mut()
                .and_then(|running| running.child.take());
            let status = taken.map(|mut child| child.wait());
            let cancelled = state.was_cancelled();
            state.finish();
            if cancelled {
                let _ = std::fs::remove_file(&output);
                return Err(CONVERSION_CANCELLED.to_string());
            }
            status
        }
        None => unwatched_child.map(|mut child| child.wait()),
    };

    let status = match status {
        Some(Ok(status)) => status,
        Some(Err(error)) => {
            let _ = std::fs::remove_file(&output);
            return Err(format!("ffmpeg did not finish: {error}"));
        }
        None => {
            let _ = std::fs::remove_file(&output);
            return Err("The conversion was lost before it finished.".to_string());
        }
    };

    if !status.success() {
        let _ = std::fs::remove_file(&output);
        return Err(format!(
            "ffmpeg could not convert the recording: {}",
            failure_reason(&said)
        ));
    }

    // Not checked here. `write_tsf` probes what comes back from this — it needs
    // the duration and codec for meta.json — and that probe now answers whether
    // the player can read it too. Asking separately meant opening and decoding
    // the whole of a freshly written recording twice in a row.
    Ok(output)
}

fn audio_member_name(audio_path: &Path) -> String {
    match audio_path.extension().and_then(|value| value.to_str()) {
        Some(extension) => format!("audio.{extension}"),
        None => "audio".to_string(),
    }
}

/// Writes a .tsf, replacing any file at `output_path`.
///
/// Written to a temporary file beside the destination and renamed into place, so an
/// interrupted write cannot leave a half-formed archive where a valid one used to be.
pub fn write_tsf(
    output_path: &Path,
    transcript: &str,
    audio_path: &Path,
    meta_draft: serde_json::Value,
    words: Option<&str>,
    // `conversion` is where a conversion reports itself and how it is stopped.
    // `None` when nothing is watching: the tests, and any caller with no way to
    // show a step that usually does not happen at all.
    conversion: Option<&ConversionState>,
) -> Result<CreateTsfResult, String> {
    // Writing the container over the recording it is packaging would leave the
    // user without their recording where they left it. The bytes do survive
    // inside the archive, but a file silently ceasing to be what it was is not
    // something to do quietly.
    if same_file(output_path, audio_path) {
        return Err(
            "The container would be written over the recording it is packaging. Choose a different name."
                .to_string(),
        );
    }

    // Converted here if it has to be, so that everything below — the member
    // name, the metadata, the bytes copied in — describes what is actually
    // stored rather than what was chosen.
    let prepared = prepare_audio_for_container(audio_path, conversion)?;
    let audio_path = prepared.path();

    let facts = probe_audio(audio_path)?;
    // The check the conversion used to make on its own output, moved here so
    // the file is read once. It applies to a converted recording — one that has
    // just been re-encoded and still cannot be played is a conversion that
    // failed quietly — and never to one stored as it was, which was tested
    // before the decision to store it untouched was taken.
    if prepared.was_converted() && !facts.playable {
        return Err(
            "The converted recording still cannot be played, so it has not been stored."
                .to_string(),
        );
    }
    let audio_member = audio_member_name(audio_path);
    let meta = complete_meta(meta_draft, &facts, &audio_member)?;

    let parent = output_path
        .parent()
        .ok_or_else(|| "Output path has no parent directory".to_string())?;
    let (temporary, file) = create_temporary_file(parent, output_path)?;

    let result = write_archive(file, transcript, audio_path, &meta, &audio_member, words);
    if let Err(error) = result {
        abandon_partial(&temporary);
        return Err(error);
    }

    // The last moment a cancellation can be honoured, and the cheapest: the
    // container is still a temporary file, so stopping here leaves nothing
    // behind and nothing at the name the user chose. Packaging a long recording
    // takes seconds, and a Cancel clicked during them meant nothing before this.
    if conversion.is_some_and(|conversion| conversion.was_cancelled()) {
        abandon_partial(&temporary);
        return Err(CONVERSION_CANCELLED.to_string());
    }

    std::fs::rename(&temporary, output_path).map_err(|error| {
        abandon_partial(&temporary);
        format!("Cannot write {}: {error}", output_path.display())
    })?;
    // It is the container now, not a partial one.
    forget_partial(&temporary);

    let bytes = std::fs::metadata(output_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);

    Ok(CreateTsfResult {
        path: output_path.to_string_lossy().to_string(),
        duration: facts.duration,
        codec: facts.codec,
        bytes,
    })
}

fn write_archive(
    file: File,
    transcript: &str,
    audio_path: &Path,
    meta: &[u8],
    audio_member: &str,
    words: Option<&str>,
) -> Result<(), String> {
    let mut zip = ZipWriter::new(BufWriter::new(file));

    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    // Audio is already compressed; deflating it again costs seconds and saves
    // nothing. `large_file` is the zip64 header a member over 4GiB needs: without
    // it the writer aborts mid-copy with "Large file option has not been set",
    // after minutes of streaming, and a recording that big is exactly the one
    // nobody wants to import twice. A long WAV reaches it — around six hours.
    let stored = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(true);

    zip.start_file(TRANSCRIPT_MEMBER, deflated)
        .map_err(|error| format!("Cannot write {TRANSCRIPT_MEMBER}: {error}"))?;
    zip.write_all(transcript.as_bytes())
        .map_err(|error| format!("Cannot write {TRANSCRIPT_MEMBER}: {error}"))?;

    zip.start_file(audio_member, stored)
        .map_err(|error| format!("Cannot write {audio_member}: {error}"))?;
    let source = File::open(audio_path)
        .map_err(|error| format!("Cannot read {}: {error}", audio_path.display()))?;
    // Streamed rather than read into memory: the recording is tens of megabytes.
    let mut reader = BufReader::new(source);
    std::io::copy(&mut reader, &mut zip)
        .map_err(|error| format!("Cannot copy audio into the container: {error}"))?;

    zip.start_file(META_MEMBER, deflated)
        .map_err(|error| format!("Cannot write {META_MEMBER}: {error}"))?;
    zip.write_all(meta)
        .map_err(|error| format!("Cannot write {META_MEMBER}: {error}"))?;

    // Every member goes in before the archive is renamed into place. Appending
    // to a published container would rewrite its central directory, so an
    // interruption could corrupt a file that was already valid — and a failure
    // after the rename would leave meta.json naming a member that is not there.
    if let Some(words) = words {
        zip.start_file(WORDS_MEMBER, deflated)
            .map_err(|error| format!("Cannot write {WORDS_MEMBER}: {error}"))?;
        zip.write_all(words.as_bytes())
            .map_err(|error| format!("Cannot write {WORDS_MEMBER}: {error}"))?;
    }

    let mut writer = zip
        .finish()
        .map_err(|error| format!("Cannot finalise the container: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("Cannot flush the container: {error}"))?;
    Ok(())
}

/// The highest container version this build understands.
///
/// A file carrying a higher number was written by a newer Wisty and may use the
/// format in ways this one would misread, so it is refused rather than opened
/// hopefully. Additive changes do not move this — unknown *keys* are carried
/// through untouched, which is what lets the format grow without a bump.
const SUPPORTED_TSF_VERSION: u64 = 1;

/// A container the user currently has open.
///
/// The audio is held in memory for the document's lifetime: symphonia needs
/// something implementing Read + Seek, and a Cursor over these bytes satisfies
/// it, so playback needs no temp file to extract to and none to clean up after
/// a crash. Ten megabytes, against extracting to disk or shipping it across the
/// bridge.
// `path` and `audio_member` are recorded on open and consumed by the save and
// repack path, which does not exist yet. They are kept here rather than
// re-derived later because that is when they are known for certain.
#[derive(Clone)]
pub struct OpenTsf {
    /// Where it came from, for saving back to when repacking exists.
    pub path: PathBuf,
    pub transcript: String,
    /// Decoded from on every play, and written back verbatim on save.
    /// Shared rather than owned outright: playback builds a reader over these
    /// bytes on every span, and an `Arc` lets it hold a handle instead of a
    /// second copy of the whole recording. Nothing mutates it after the open.
    pub audio: Arc<[u8]>,
    /// The audio member's name, so a repack writes it under the same name.
    ///
    /// Comes from the container's own meta.json, so it is untrusted input. It
    /// is only ever used as a name *inside* a zip. The repack will be the first
    /// thing to use it for anything else, and must validate it first —
    /// "../../etc/passwd" is a legal string here.
    pub audio_member: String,
    pub meta: serde_json::Value,
    /// Optional word timings are not used by the editor, but saving must not
    /// discard them from a container created by the importer.
    pub words: Option<Vec<u8>>,
    source_metadata: Metadata,
    source_fingerprint: u64,
    unsupported_members: Vec<String>,
}

/// Deliberately hand-written rather than derived: a derived Debug would put the
/// transcript text and ten megabytes of audio into any panic message or log
/// line that formatted this. Sizes are all anyone debugging needs.
impl std::fmt::Debug for OpenTsf {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenTsf")
            .field("path", &self.path)
            .field("audio_member", &self.audio_member)
            .field("audio_bytes", &self.audio.len())
            .field("transcript_chars", &self.transcript.len())
            .field("has_words", &self.words.is_some())
            .field("unsupported_members", &self.unsupported_members)
            .finish()
    }
}

#[derive(Default)]
pub struct TsfState(pub Mutex<Option<OpenTsf>>, pub Mutex<()>);

#[derive(Debug, Serialize)]
pub struct OpenTsfResult {
    /// The document text, for the editor. The frontend never sees the archive.
    pub transcript: String,
    pub meta: serde_json::Value,
    pub audio_bytes: usize,
}

/// Largest member this will read into memory.
///
/// The audio is held in memory for the document's lifetime, so a container
/// beyond this could not be worked with anyway. Generous — a 28-minute
/// recording is about 10MB, so this allows for many hours — but bounded, so a
/// corrupt or hostile file fails with a message rather than by exhausting
/// memory.
const MAX_MEMBER_BYTES: u64 = 512 * 1024 * 1024;

/// How much to reserve up front for a member.
///
/// A zip's declared uncompressed size comes from its own header, so it is a
/// claim rather than a fact: a corrupt or crafted file can assert an enormous
/// one. Reserving it directly would attempt that allocation and abort the
/// process. The claim is only ever used as a hint, capped at something a real
/// transcript could reach, and `read_to_end` grows the buffer as the data
/// actually arrives.
fn reserve_for(declared: u64) -> usize {
    const HINT_LIMIT: u64 = 32 * 1024 * 1024;
    declared.min(HINT_LIMIT) as usize
}

/// Reads one member from an already-open archive.
fn read_member_from<R: std::io::Read + std::io::Seek>(
    zip: &mut ZipArchive<R>,
    name: &str,
) -> Result<Vec<u8>, String> {
    let mut member = zip
        .by_name(name)
        .map_err(|_| format!("The container has no {name}"))?;
    if member.size() > MAX_MEMBER_BYTES {
        return Err(format!(
            "{name} is {} bytes, larger than this can open ({MAX_MEMBER_BYTES})",
            member.size()
        ));
    }
    let mut contents = Vec::with_capacity(reserve_for(member.size()));
    member
        .read_to_end(&mut contents)
        .map_err(|error| format!("Cannot read {name}: {error}"))?;
    Ok(contents)
}

fn validate_member_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name == "."
        || name == ".."
        || Path::new(name).is_absolute()
    {
        return Err(format!(
            "The container has an unsafe audio member name: {name}"
        ));
    }
    Ok(())
}

fn fingerprint_file(path: &Path) -> Result<u64, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        if read == 0 {
            return Ok(hasher.finish());
        }
        buffer[..read].hash(&mut hasher);
    }
}

/// True when `path` begins with the zip signature.
///
/// Checked by content rather than by extension, so a file named .tsf that is
/// not a container is reported as what it is instead of failing later with
/// something less obvious.
pub fn looks_like_container(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut signature = [0u8; 4];
    file.read_exact(&mut signature).is_ok() && &signature == b"PK\x03\x04"
}

/// Reads a container: its transcript, its metadata and its audio.
///
/// Separate from the command so the reading can be tested without Tauri state,
/// the same split `write_tsf` and `create_tsf` already use.
pub fn read_tsf(archive: &Path) -> Result<OpenTsf, String> {
    if !archive.is_file() {
        return Err(format!("No such file: {}", archive.display()));
    }
    if !looks_like_container(archive) {
        return Err(format!(
            "{} is not a .tsf container (it does not start with a zip header)",
            archive.display()
        ));
    }

    // Opened once and read through: three separate opens would parse the
    // central directory three times, and could take the transcript from one
    // version of the file and the audio from another if it changed underneath.
    let file = File::open(archive)
        .map_err(|error| format!("Cannot open {}: {error}", archive.display()))?;
    let mut zip = ZipArchive::new(BufReader::new(file))
        .map_err(|error| format!("Not a readable .tsf container: {error}"))?;

    let meta: serde_json::Value = serde_json::from_slice(&read_member_from(&mut zip, META_MEMBER)?)
        .map_err(|error| format!("The container's meta.json is not valid JSON: {error}"))?;

    match meta.get("tsf_version").and_then(serde_json::Value::as_u64) {
        Some(version) if version > SUPPORTED_TSF_VERSION => {
            return Err(format!(
                "This transcript was written by a newer version of Wisty (format {version}); this build understands up to {SUPPORTED_TSF_VERSION}."
            ));
        }
        Some(_) => {}
        None => return Err("The container's meta.json has no tsf_version".to_string()),
    }

    let audio_member = meta
        .get("audio")
        .and_then(|audio| audio.get("file"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "The container's meta.json does not name its audio file".to_string())?
        .to_string();
    validate_member_name(&audio_member)?;

    let unsupported_members = (0..zip.len())
        .filter_map(|index| {
            zip.by_index(index)
                .ok()
                .map(|member| member.name().to_string())
        })
        .filter(|name| {
            name != TRANSCRIPT_MEMBER
                && name != META_MEMBER
                && name != &audio_member
                && name != WORDS_MEMBER
        })
        .collect();

    let transcript = String::from_utf8(read_member_from(&mut zip, TRANSCRIPT_MEMBER)?)
        .map_err(|_| format!("{TRANSCRIPT_MEMBER} is not valid UTF-8"))?;
    let audio: Arc<[u8]> = Arc::from(read_member_from(&mut zip, &audio_member)?.as_slice());
    let words = match zip.by_name(WORDS_MEMBER) {
        Ok(mut member) => {
            if member.size() > MAX_MEMBER_BYTES {
                return Err(format!("{WORDS_MEMBER} is too large"));
            }
            let mut contents = Vec::with_capacity(reserve_for(member.size()));
            member
                .read_to_end(&mut contents)
                .map_err(|error| format!("Cannot read {WORDS_MEMBER}: {error}"))?;
            Some(contents)
        }
        Err(_) => None,
    };
    let source_metadata = std::fs::metadata(archive)
        .map_err(|error| format!("Cannot stat {}: {error}", archive.display()))?;
    let source_fingerprint = fingerprint_file(archive)?;

    Ok(OpenTsf {
        // Absolute, so saving back later cannot be affected by the working
        // directory having changed since the file was opened.
        path: archive
            .canonicalize()
            .unwrap_or_else(|_| archive.to_path_buf()),
        transcript,
        audio,
        audio_member,
        meta,
        words,
        source_metadata,
        source_fingerprint,
        unsupported_members,
    })
}

/// Opens a .tsf: the transcript and metadata are returned, the audio is kept.
///
/// `async` for the same reason as `play_span`: reading the container pulls the
/// whole recording into memory, and it may then wait on an in-flight save. None
/// of that may happen on the thread drawing the window.
#[tauri::command(async)]
pub fn open_tsf(
    state: tauri::State<'_, TsfState>,
    playback: tauri::State<'_, crate::playback::PlaybackState>,
    path: String,
) -> Result<OpenTsfResult, String> {
    let container = read_tsf(Path::new(&path))?;
    let result = OpenTsfResult {
        transcript: container.transcript.clone(),
        meta: container.meta.clone(),
        audio_bytes: container.audio.len(),
    };

    // A save snapshots the active container before it writes. Do not replace
    // that container until the save has either finished or failed.
    let _save = state
        .1
        .lock()
        .map_err(|error| format!("Cannot take the container-save lock: {error}"))?;

    // Reject queued plays before replacing the audio. `play_span` locks playback
    // then reads the container, so never retain this mutex while calling arm(),
    // which takes the playback lock.
    playback.disarm();
    {
        let mut open = state
            .0
            .lock()
            .map_err(|error| format!("Cannot take the open-container lock: {error}"))?;
        *open = Some(container);
    }
    // Opening a container is what re-arms playback after a release, and what
    // discards any player still holding the previous recording. Playback owns
    // that state rather than the frontend, because the frontend forgets it
    // across a reload and this side does not.
    playback.arm()?;

    Ok(result)
}

/// Releases the open container, freeing the audio it was holding.
///
/// Called when the document is closed or replaced. Without it the bytes would
/// stay resident after the user moved on to an ordinary text file.
///
/// `async` because it waits for any in-flight save, and because dropping the
/// audio is not work for the event-loop thread.
#[tauri::command(async)]
pub fn close_tsf(
    state: tauri::State<'_, TsfState>,
    playback: tauri::State<'_, crate::playback::PlaybackState>,
) -> Result<(), String> {
    let _save = state
        .1
        .lock()
        .map_err(|error| format!("Cannot take the container-save lock: {error}"))?;
    // Symmetric with open_tsf's arm. The frontend releases playback before
    // calling this, but that call is fire-and-forget and its failure is
    // swallowed — so without this, a release that did not land would leave
    // playback live against a document that no longer exists.
    playback.disarm();
    let mut open = state
        .0
        .lock()
        .map_err(|error| format!("Cannot take the open-container lock: {error}"))?;
    *open = None;
    Ok(())
}

const SOURCE_CHANGED: &str = "The transcript container changed on disk after it was opened. Reopen it before saving so no changes are lost.";

/// A refused container save, with a code the frontend can act on.
///
/// The text saves have carried codes for a while, and the frontend turns
/// `SAVE_EXTERNAL_CHANGE` into the conflict banner — reload, overwrite, dismiss.
/// A container save reported the same situation as a bare sentence, so it
/// arrived as a generic "Unable to save file" dialog with no offer to do
/// anything about it, for the one document kind where being changed underneath
/// costs a recording rather than some text.
#[derive(serde::Serialize)]
pub struct TsfSaveError {
    code: &'static str,
    message: String,
}

impl From<String> for TsfSaveError {
    fn from(message: String) -> Self {
        // Matched against the constant rather than by wording, so rewording it
        // cannot silently downgrade every conflict into a generic failure.
        let code = if message == SOURCE_CHANGED {
            "SAVE_EXTERNAL_CHANGE"
        } else {
            "SAVE_FAILED"
        };
        Self { code, message }
    }
}

/// Length and modification time only — O(1), and wrong in one direction: an
/// edit that preserves both slips through. Use it to refuse a save early,
/// never to decide that publishing one is safe.
/// Whether the container this document was opened from is still as it was.
///
/// A source that has been *deleted* is not a conflict and does not stop a save.
/// The check exists to stop a repack mixing the recording held in memory into a
/// file some other writer has since changed; a path with no file at it has
/// nothing to mix into. Refusing there would leave the transcript unsaveable
/// anywhere — including back where it came from — while everything needed to
/// write it, the audio included, sits in `OpenTsf`.
fn source_metadata_is_unchanged(open: &OpenTsf) -> Result<(), String> {
    let current = match std::fs::metadata(&open.path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Cannot check {} before saving: {error}",
                open.path.display()
            ));
        }
    };
    if current.len() != open.source_metadata.len()
        || current.modified().ok() != open.source_metadata.modified().ok()
    {
        return Err(SOURCE_CHANGED.to_string());
    }
    Ok(())
}

/// The check that decides whether the rename may happen: same metadata *and*
/// same bytes, because a same-sized edit within a timestamp's resolution is
/// exactly the case the fingerprint exists to catch. Reads the whole container.
fn source_is_unchanged(open: &OpenTsf) -> Result<(), String> {
    source_metadata_is_unchanged(open)?;
    if !open.path.exists() {
        // Deleted, as above: nothing to fingerprint and nothing to conflict
        // with. The metadata check has already accepted it.
        return Ok(());
    }
    if fingerprint_file(&open.path)? != open.source_fingerprint {
        return Err(SOURCE_CHANGED.to_string());
    }
    Ok(())
}

fn temporary_save_path(parent: &Path, output: &Path) -> PathBuf {
    parent.join(format!(
        ".{}.{}.{}.partial",
        output
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("transcript.tsf"),
        std::process::id(),
        SAVE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}

/// The suffix every half-written container is named with.
const PARTIAL_SUFFIX: &str = ".partial";

/// Half-written containers this process has open, by path.
///
/// A container is built beside its destination and renamed into place, and
/// every path that can fail removes it on the way out. What none of them covers
/// is the process ending in the middle — which became reachable when the window
/// gained a way to close during an import. These are the size of the recording,
/// so leaving one behind is not a small thing.
static PARTIAL_FILES: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

fn remember_partial(path: &Path) {
    if let Ok(mut open) = PARTIAL_FILES.lock() {
        open.push(path.to_path_buf());
    }
}

fn forget_partial(path: &Path) {
    if let Ok(mut open) = PARTIAL_FILES.lock() {
        open.retain(|remembered| remembered != path);
    }
}

/// Removes a temporary that will not become a container, and stops tracking it.
fn abandon_partial(path: &Path) {
    let _ = std::fs::remove_file(path);
    forget_partial(path);
}

/// Deletes whatever half-written containers this process still has open.
///
/// For the window closing during a save or an import. Nothing waits for the
/// write to finish: the bytes are going nowhere useful, and the file being
/// removed is one this process created and has not yet renamed.
pub fn remove_partial_files() {
    remove_tracked_partials(None);
}

/// The work of `remove_partial_files`, narrowed to one directory for the tests.
///
/// The registry is process-wide, and the tests run in one process: a drain of
/// all of it would take away files the tests running alongside are still
/// writing. `None` is the whole of it, which is what closing means.
fn remove_tracked_partials(under: Option<&Path>) {
    let Ok(mut open) = PARTIAL_FILES.lock() else {
        return;
    };
    let (taken, left): (Vec<PathBuf>, Vec<PathBuf>) = open
        .drain(..)
        .partition(|path| under.is_none_or(|parent| path.starts_with(parent)));
    *open = left;
    for path in taken {
        let _ = std::fs::remove_file(path);
    }
}

/// The pid a `.partial` name carries, if it is one of ours.
///
/// The form is `.<container name>.<pid>.<sequence>.partial`, and the container
/// name has dots of its own, so it is read from the right.
fn partial_owner(file_name: &str) -> Option<u32> {
    let inner = file_name.strip_prefix('.')?.strip_suffix(PARTIAL_SUFFIX)?;
    let (rest, _sequence) = inner.rsplit_once('.')?;
    let (_name, pid) = rest.rsplit_once('.')?;
    pid.parse().ok()
}

/// Clears out abandoned containers beside one about to be written.
///
/// The startup sweep cannot find these: it knows where converted recordings go,
/// because this process chose that directory, but a container goes wherever the
/// user said and there is no record of where that was. Doing it here instead
/// means a directory is tidied the next time a container is written into it,
/// which also covers the process being killed outright — the one case the
/// registry above cannot.
///
/// Same rule as the conversion sweep: a live owner protects a file, unless it
/// is old enough that the pid must have been reused.
/// Directories already swept, so it is not done again on every save.
static SWEPT_DIRECTORIES: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

fn sweep_partial_files(parent: &Path) {
    // Once per directory for the life of the process. What it collects is what
    // an *earlier* process abandoned, so a second look finds nothing new — and
    // this is on the path of every save, where a directory listing plus a
    // `/proc` stat per candidate is a cost the save should not carry twice.
    {
        let Ok(mut swept) = SWEPT_DIRECTORIES.lock() else {
            return;
        };
        if swept.iter().any(|seen| seen == parent) {
            return;
        }
        swept.push(parent.to_path_buf());
    }
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(pid) = partial_owner(name) else {
            continue;
        };
        let owner_lives = Path::new(&format!("/proc/{pid}")).exists();
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > STALE_CONVERSION_AGE);
        if owner_lives && !stale {
            continue;
        }
        let _ = std::fs::remove_file(entry.path());
    }
}

fn create_temporary_file(parent: &Path, output: &Path) -> Result<(PathBuf, File), String> {
    sweep_partial_files(parent);
    for _ in 0..TEMPORARY_CREATE_ATTEMPTS {
        let path = temporary_save_path(parent, output);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                remember_partial(&path);
                return Ok((path, file));
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Cannot create {}: {error}", path.display())),
        }
    }
    Err(format!(
        "Cannot create a unique temporary file beside {}",
        output.display()
    ))
}

fn write_open_archive(file: File, transcript: &str, open: &OpenTsf) -> Result<(), String> {
    validate_member_name(&open.audio_member)?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    // As in `write_archive`: a container whose recording is over 4GiB has to be
    // rewritable, or saving it once would destroy it.
    let stored = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(true);

    zip.start_file(TRANSCRIPT_MEMBER, deflated)
        .map_err(|error| format!("Cannot write {TRANSCRIPT_MEMBER}: {error}"))?;
    zip.write_all(transcript.as_bytes())
        .map_err(|error| format!("Cannot write {TRANSCRIPT_MEMBER}: {error}"))?;
    zip.start_file(&open.audio_member, stored)
        .map_err(|error| format!("Cannot write {}: {error}", open.audio_member))?;
    zip.write_all(&open.audio)
        .map_err(|error| format!("Cannot write {}: {error}", open.audio_member))?;
    zip.start_file(META_MEMBER, deflated)
        .map_err(|error| format!("Cannot write {META_MEMBER}: {error}"))?;
    zip.write_all(
        &serde_json::to_vec_pretty(&open.meta)
            .map_err(|error| format!("Cannot serialise metadata: {error}"))?,
    )
    .map_err(|error| format!("Cannot write {META_MEMBER}: {error}"))?;
    if let Some(words) = &open.words {
        zip.start_file(WORDS_MEMBER, deflated)
            .map_err(|error| format!("Cannot write {WORDS_MEMBER}: {error}"))?;
        zip.write_all(words)
            .map_err(|error| format!("Cannot write {WORDS_MEMBER}: {error}"))?;
    }
    let writer = zip
        .finish()
        .map_err(|error| format!("Cannot finalise the container: {error}"))?;
    writer
        .into_inner()
        .map_err(|error| format!("Cannot flush the container: {error}"))?
        .sync_all()
        .map_err(|error| format!("Cannot sync the container: {error}"))
}

/// Rebuilds the open container with the edited transcript without routing audio
/// through the webview. The source snapshot must still match disk, and unknown
/// archive members are refused rather than silently discarded.
///
/// `async` so Tauri runs it on a worker rather than the event-loop thread. It
/// recompresses the transcript, restores the recording verbatim, syncs the
/// result to disk and fingerprints the container twice — on a 28-minute
/// recording that is seconds of work, and on the main thread it is seconds of
/// frozen window with no way to show save progress.
#[tauri::command(async)]
pub fn save_tsf(
    state: tauri::State<'_, TsfState>,
    path: String,
    transcript: String,
) -> Result<(), TsfSaveError> {
    // The frontend also blocks duplicate saves, but commands are independently
    // invokable. Keep the archive operation single-flight at the authority.
    let _save = state
        .1
        .lock()
        .map_err(|error| format!("Cannot take the container-save lock: {error}"))?;
    let open = state
        .0
        .lock()
        .map_err(|error| format!("Cannot take the open-container lock: {error}"))?
        .clone()
        .ok_or_else(|| "No transcript container is open".to_string())?;
    if !open.unsupported_members.is_empty() {
        return Err(format!(
            "This container has unsupported archive members that Wisty cannot preserve: {}",
            open.unsupported_members.join(", ")
        )
        .into());
    }
    // Cheap first: refusing here costs one stat instead of rezipping the whole
    // recording only to throw the result away. The full fingerprint runs after
    // the write, where it is what the rename actually depends on.
    source_metadata_is_unchanged(&open)?;
    let output = PathBuf::from(path);
    let parent = output
        .parent()
        .ok_or_else(|| "Output path has no parent directory".to_string())?;
    let (temporary, file) = create_temporary_file(parent, &output)?;
    if let Err(error) = write_open_archive(file, &transcript, &open) {
        abandon_partial(&temporary);
        return Err(error.into());
    }
    // Check again immediately before replacement. A timestamp/length check
    // alone misses same-sized edits, so source_is_unchanged also fingerprints.
    if let Err(error) = source_is_unchanged(&open) {
        abandon_partial(&temporary);
        return Err(error.into());
    }
    std::fs::rename(&temporary, &output).map_err(|error| {
        abandon_partial(&temporary);
        format!("Cannot write {}: {error}", output.display())
    })?;
    forget_partial(&temporary);
    let mut guard = state
        .0
        .lock()
        .map_err(|error| format!("Cannot take the open-container lock: {error}"))?;
    let current = guard
        .as_mut()
        .ok_or_else(|| "The transcript container was closed while saving".to_string())?;
    if current.path != open.path {
        return Err("A different transcript container was opened while saving"
            .to_string()
            .into());
    }
    current.path = output.canonicalize().unwrap_or(output);
    current.source_metadata = std::fs::metadata(&current.path)
        .map_err(|error| format!("Cannot stat saved container: {error}"))?;
    current.source_fingerprint = fingerprint_file(&current.path)?;
    Ok(())
}

/// What a recording is, before anything is written.
///
/// The importer asks so that it can check the transcript against the audio it
/// claims to describe — a last cue beyond the end of the recording is how a
/// mismatched pair of files announces itself — and so that it knows whether
/// this is audio the player can read.
///
/// `async` for the same reason as the rest: probing opens and parses the file.
#[tauri::command(async)]
pub fn probe_audio_file(path: String) -> Result<serde_json::Value, String> {
    // `playable` comes back with the rest: whether the player can read this
    // decides whether importing it means re-encoding the whole recording, and
    // the import says so before it asks where to put the container rather than
    // announcing it once the slow part has started. The codec name cannot
    // answer it — HE-AAC reports "aac" and is still refused — so the probe
    // settles it by building a decoder while it has the file open anyway.
    let facts = probe_audio(Path::new(&path))?;
    serde_json::to_value(facts).map_err(|error| format!("Cannot report audio facts: {error}"))
}

/// The prefix every temporary file a conversion writes is named with.
const CONVERSION_PREFIX: &str = "wisty-import-";

/// Past this, a leftover is litter whatever process now holds its number.
const STALE_CONVERSION_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Deletes converted recordings left behind by a Wisty that is no longer running.
///
/// A conversion cleans up after itself on every path it can reach, but the path
/// it cannot reach is the app being quit or killed while ffmpeg is working:
/// nothing runs after that, and a recording-sized file stays in the temporary
/// directory for good. They are matched by the process that made them — this is
/// Linux, so a process either has a `/proc` entry or does not exist — which
/// leaves a second Wisty's conversions alone.
pub fn sweep_conversion_leftovers() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(rest) = name.strip_prefix(CONVERSION_PREFIX) else {
            continue;
        };
        let Some((pid, _)) = rest.split_once('-') else {
            continue;
        };
        if pid.parse::<u32>().is_err() {
            continue;
        }
        // Owned by a live process, so left alone — unless it is old enough that
        // the pid must have been reused, since a conversion lasts minutes and
        // pids wrap. Without the age test a leftover whose number was taken by
        // something unrelated would be protected for good.
        let owner_lives = Path::new(&format!("/proc/{pid}")).exists();
        let age = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok());
        let stale = age.is_some_and(|age| age > STALE_CONVERSION_AGE);
        if owner_lives && !stale {
            continue;
        }
        let _ = std::fs::remove_file(entry.path());
    }
}

/// `async` for the same reason as `save_tsf`: probing, compressing and syncing
/// a whole recording is not work for the event-loop thread.
#[tauri::command(async)]
pub fn create_tsf(
    conversion: tauri::State<'_, ConversionState>,
    output_path: String,
    transcript: String,
    audio_path: String,
    meta: serde_json::Value,
    words: Option<String>,
) -> Result<CreateTsfResult, CreateTsfError> {
    // This import has not been cancelled, whatever the last one did.
    conversion.begin_import();

    let output = PathBuf::from(&output_path);
    let audio = PathBuf::from(&audio_path);

    if !audio.is_file() {
        return Err(CreateTsfError::failed(format!(
            "No such audio file: {audio_path}"
        )));
    }

    let mut meta = meta;
    if words.is_some() {
        if let Some(object) = meta.as_object_mut() {
            object.insert(
                "words".into(),
                serde_json::Value::String(WORDS_MEMBER.into()),
            );
        }
    }

    write_tsf(
        &output,
        &transcript,
        &audio,
        meta,
        words.as_deref(),
        Some(&conversion),
    )
    .map_err(CreateTsfError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// Writes a container with nothing watching for a conversion.
    ///
    /// Deliberately shadows the real one so the tests read as they did before
    /// the conversion became observable: what they are about is the archive,
    /// and a window collecting ffmpeg's output is not part of that. The tests
    /// that *are* about the conversion pass a state of their own.
    fn write_tsf(
        output_path: &Path,
        transcript: &str,
        audio_path: &Path,
        meta_draft: serde_json::Value,
        words: Option<&str>,
    ) -> Result<CreateTsfResult, String> {
        super::write_tsf(output_path, transcript, audio_path, meta_draft, words, None)
    }

    /// A valid one-second 8kHz mono 16-bit WAV, built here so the tests need no
    /// fixture file and no ffmpeg. symphonia reads WAV without any optional feature.
    fn wav_bytes(seconds: u32) -> Vec<u8> {
        const RATE: u32 = 8000;
        let samples = RATE * seconds;
        let data_len = samples * 2;
        let mut out = Vec::with_capacity(44 + data_len as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&RATE.to_le_bytes());
        out.extend_from_slice(&(RATE * 2).to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_len.to_le_bytes());
        out.resize(44 + data_len as usize, 0);
        out
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wisty-tsf-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn draft() -> serde_json::Value {
        serde_json::json!({
            "tsf_version": 1,
            "audio": { "file": "placeholder" },
            "source": { "recording": "interview.wav" },
            "generator": { "tool": "wisty" }
        })
    }

    #[test]
    fn audio_member_keeps_the_source_extension() {
        assert_eq!(audio_member_name(Path::new("/x/mum_11.m4a")), "audio.m4a");
        assert_eq!(audio_member_name(Path::new("/x/rec.wav")), "audio.wav");
        assert_eq!(audio_member_name(Path::new("/x/noext")), "audio");
    }

    #[test]
    fn probe_reads_duration_and_codec() {
        let dir = temp_dir("probe");
        let audio = dir.join("a.wav");
        std::fs::write(&audio, wav_bytes(3)).unwrap();

        let facts = probe_audio(&audio).expect("probe");
        assert!(
            (facts.duration - 3.0).abs() < 0.01,
            "duration was {}",
            facts.duration
        );
        assert!(!facts.codec.is_empty());
    }

    #[test]
    fn probe_rejects_a_file_that_is_not_audio() {
        let dir = temp_dir("notaudio");
        let path = dir.join("a.wav");
        std::fs::write(&path, b"definitely not a wave file").unwrap();
        assert!(probe_audio(&path).is_err());
    }

    #[test]
    fn meta_gains_the_audio_facts_and_keeps_unknown_keys() {
        let facts = AudioFacts {
            duration: 12.5,
            codec: "aac".into(),
            playable: true,
        };
        let mut input = draft();
        // A field this side has never heard of must survive: the format's growth
        // depends on producers being able to add keys without readers changing.
        input
            .as_object_mut()
            .unwrap()
            .insert("future_field".into(), serde_json::json!({"a": 1}));

        let bytes = complete_meta(input, &facts, "audio.m4a").expect("meta");
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(value["audio"]["file"], "audio.m4a");
        assert_eq!(value["audio"]["codec"], "aac");
        assert_eq!(value["audio"]["duration"], 12.5);
        assert_eq!(value["future_field"]["a"], 1);
        assert_eq!(value["tsf_version"], 1);
    }

    #[test]
    fn meta_must_be_an_object() {
        let facts = AudioFacts {
            duration: 1.0,
            codec: "x".into(),
            playable: true,
        };
        assert!(complete_meta(serde_json::json!([1, 2]), &facts, "audio.wav").is_err());
    }

    #[test]
    fn writes_a_readable_container() {
        let dir = temp_dir("write");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(2)).unwrap();
        let output = dir.join("out.tsf");
        let transcript = "ALICE: \u{27E6}0.00\u{2013}1.00\u{27E7}Hello.";

        let result = write_tsf(&output, transcript, &audio, draft(), None).expect("write");
        assert!((result.duration - 2.0).abs() < 0.01);
        assert!(result.bytes > 0);

        let mut zip = zip::ZipArchive::new(File::open(&output).unwrap()).unwrap();
        let names: Vec<String> = zip.file_names().map(str::to_string).collect();
        assert!(names.contains(&"transcript.txt".to_string()));
        assert!(names.contains(&"audio.wav".to_string()));
        assert!(names.contains(&"meta.json".to_string()));

        let mut text = String::new();
        zip.by_name("transcript.txt")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, transcript);

        let mut meta = String::new();
        zip.by_name("meta.json")
            .unwrap()
            .read_to_string(&mut meta)
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&meta).unwrap();
        assert_eq!(value["audio"]["file"], "audio.wav");
    }

    #[test]
    fn stores_the_audio_uncompressed_and_byte_identical() {
        let dir = temp_dir("audio");
        let audio = dir.join("rec.wav");
        let original = wav_bytes(1);
        std::fs::write(&audio, &original).unwrap();
        let output = dir.join("out.tsf");

        write_tsf(&output, "text", &audio, draft(), None).expect("write");

        let mut zip = zip::ZipArchive::new(File::open(&output).unwrap()).unwrap();
        let mut member = zip.by_name("audio.wav").unwrap();
        assert_eq!(member.compression(), CompressionMethod::Stored);
        let mut bytes = Vec::new();
        member.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, original, "the recording must survive byte for byte");
    }

    #[test]
    fn leaves_no_partial_file_when_the_audio_cannot_be_read() {
        let dir = temp_dir("partial");
        let output = dir.join("out.tsf");
        let missing = dir.join("nope.wav");

        assert!(write_tsf(&output, "text", &missing, draft(), None).is_err());
        assert!(!output.exists(), "no container should be left behind");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("partial"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no temporary file should be left behind"
        );
    }

    /// A container is built beside its destination and renamed into place, and
    /// every failure removes it on the way out. What none of them covers is the
    /// process ending mid-write — which became reachable when the window gained
    /// a way to close during an import. These are the size of the recording.
    #[test]
    fn closing_takes_the_half_written_container_with_it() {
        let dir = temp_dir("partial-on-close");
        let output = dir.join("out.tsf");
        let (temporary, _file) = create_temporary_file(&dir, &output).expect("temporary");
        assert!(temporary.exists());

        // Scoped to this test's directory: the registry is process-wide and
        // these tests share a process, so draining all of it would take away
        // what the tests running alongside are still writing.
        remove_tracked_partials(Some(&dir));

        assert!(
            !temporary.exists(),
            "the half-written container outlived the window"
        );
    }

    /// What the registry is still tracking under `dir`.
    ///
    /// Filtered by directory because it is process-wide and these tests share a
    /// process; each test has a directory of its own.
    fn tracked_partials_in(dir: &Path) -> Vec<PathBuf> {
        PARTIAL_FILES
            .lock()
            .expect("lock")
            .iter()
            .filter(|path| path.starts_with(dir))
            .cloned()
            .collect()
    }

    #[test]
    fn a_container_that_was_written_is_no_longer_tracked() {
        // The entry is harmless to leave — the path it names has been renamed
        // away, so removing it later would do nothing. It is the accumulation
        // that matters: one every time anything is saved, for the life of the
        // process.
        let dir = temp_dir("partial-forgotten");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(1)).unwrap();
        let output = dir.join("out.tsf");

        write_tsf(&output, "text", &audio, draft(), None).expect("write");

        assert!(
            tracked_partials_in(&dir).is_empty(),
            "a finished container is still being tracked as half-written"
        );
        remove_tracked_partials(Some(&dir));
        assert!(output.exists(), "a finished container was swept away");
    }

    /// Dropping a `Child` neither kills it nor waits for it, so replacing a
    /// running conversion left ffmpeg encoding into a temporary nobody held —
    /// and the startup sweep will not collect that, the owning pid being alive.
    #[test]
    fn a_second_conversion_is_refused_rather_than_replacing_the_first() {
        let state = ConversionState::default();
        // `true` exits at once, but the record is what is under test and it is
        // only cleared by finish(), which has not run.
        let first = std::process::Command::new("true")
            .spawn()
            .expect("spawn the first");
        state.begin(first).expect("the first should start");

        let second = std::process::Command::new("true")
            .spawn()
            .expect("spawn the second");
        let refused = state.begin(second);

        let Err((_reason, mut orphan)) = refused else {
            panic!("the second conversion replaced the first");
        };
        // Handed back, which is the whole point: the caller is the only one
        // left who can stop it.
        let _ = orphan.kill();
        let _ = orphan.wait();

        // And the first is still the one on record.
        let mut guard = state.lock().expect("lock");
        let running = guard.as_mut().expect("the first was thrown away");
        let mut child = running.child.take().expect("the first's process");
        let _ = child.wait();
    }

    #[test]
    fn a_conversion_may_start_once_the_last_one_has_finished() {
        let state = ConversionState::default();
        let first = std::process::Command::new("true").spawn().expect("spawn");
        state.begin(first).expect("the first should start");
        {
            let mut guard = state.lock().expect("lock");
            if let Some(running) = guard.as_mut() {
                if let Some(mut child) = running.child.take() {
                    let _ = child.wait();
                }
            }
        }
        state.finish();

        let second = std::process::Command::new("true").spawn().expect("spawn");
        assert!(
            state.begin(second).is_ok(),
            "a finished conversion still blocked the next one"
        );
        let mut guard = state.lock().expect("lock");
        if let Some(running) = guard.as_mut() {
            if let Some(mut child) = running.child.take() {
                let _ = child.wait();
            }
        }
    }

    /// The sweep is on the path of every save, and what it collects is what an
    /// earlier process abandoned — so a second look finds nothing a first did
    /// not, and costs a directory listing plus a stat per candidate.
    #[test]
    fn a_directory_is_swept_once_and_not_again() {
        let dir = temp_dir("partial-sweep-once");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(1)).unwrap();

        // The first write sweeps, taking what pid 0 left behind.
        let first_leftover = dir.join(".out.tsf.0.1.partial");
        std::fs::write(&first_leftover, b"half a container").unwrap();
        write_tsf(&dir.join("a.tsf"), "text", &audio, draft(), None).expect("write");
        assert!(!first_leftover.exists(), "the first sweep took nothing");

        // The second does not, so one arriving afterwards survives until the
        // next process looks.
        let later_leftover = dir.join(".out.tsf.0.2.partial");
        std::fs::write(&later_leftover, b"half a container").unwrap();
        write_tsf(&dir.join("b.tsf"), "text", &audio, draft(), None).expect("write");
        assert!(
            later_leftover.exists(),
            "the directory was swept a second time"
        );
    }

    #[test]
    fn the_partial_sweep_reads_the_owner_out_of_the_name() {
        let mine = format!(".out.tsf.{}.0.partial", std::process::id());
        assert_eq!(partial_owner(&mine), Some(std::process::id()));
        // Container names have dots of their own, which is why it reads from
        // the right rather than the left.
        assert_eq!(
            partial_owner(".my.recording.v2.tsf.4321.7.partial"),
            Some(4321)
        );
        assert_eq!(
            partial_owner("out.tsf.4321.7.partial"),
            None,
            "no leading dot"
        );
        assert_eq!(partial_owner(".out.tsf.4321.7.tmp"), None, "not a partial");
        assert_eq!(partial_owner(".out.tsf.partial"), None, "no pid to read");
    }

    /// The startup sweep cannot find these: it knows where converted recordings
    /// go because this process chose that directory, but a container goes
    /// wherever the user said and nothing records where. Tidying the directory
    /// on the way past is what covers a process that was killed outright.
    #[test]
    fn writing_a_container_clears_out_abandoned_ones_beside_it() {
        let dir = temp_dir("partial-sweep");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(1)).unwrap();
        // Owned by pid 0, which no process has.
        let abandoned = dir.join(".out.tsf.0.9.partial");
        std::fs::write(&abandoned, b"half a container").unwrap();
        // Owned by a process that is very much alive, and so not ours to take.
        let live = dir.join(format!(".out.tsf.{}.9.partial", std::process::id()));
        std::fs::write(&live, b"someone else is writing this").unwrap();

        write_tsf(&dir.join("out.tsf"), "text", &audio, draft(), None).expect("write");

        assert!(
            !abandoned.exists(),
            "an abandoned container was left behind"
        );
        assert!(live.exists(), "a live process's container was taken away");
    }

    #[test]
    fn replaces_an_existing_container() {
        let dir = temp_dir("replace");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(1)).unwrap();
        let output = dir.join("out.tsf");
        std::fs::write(&output, b"stale contents").unwrap();

        write_tsf(&output, "fresh", &audio, draft(), None).expect("write");

        let mut zip = zip::ZipArchive::new(File::open(&output).unwrap()).unwrap();
        let mut text = String::new();
        zip.by_name("transcript.txt")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "fresh");
    }

    #[test]
    fn includes_the_word_timings_when_given_them() {
        let dir = temp_dir("words");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(1)).unwrap();
        let output = dir.join("out.tsf");

        let mut meta = draft();
        meta.as_object_mut()
            .unwrap()
            .insert("words".into(), serde_json::json!("words.json"));
        write_tsf(&output, "text", &audio, meta, Some("[{\"start\":0}]")).expect("write");

        let mut zip = zip::ZipArchive::new(File::open(&output).unwrap()).unwrap();
        let mut words = String::new();
        zip.by_name("words.json")
            .unwrap()
            .read_to_string(&mut words)
            .unwrap();
        assert_eq!(words, "[{\"start\":0}]");
    }

    #[test]
    fn omits_the_words_member_when_there_are_none() {
        let dir = temp_dir("nowords");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(1)).unwrap();
        let output = dir.join("out.tsf");

        write_tsf(&output, "text", &audio, draft(), None).expect("write");

        let zip = zip::ZipArchive::new(File::open(&output).unwrap()).unwrap();
        let names: Vec<&str> = zip.file_names().collect();
        assert!(!names.contains(&"words.json"), "got {names:?}");
    }

    #[test]
    fn the_reported_size_is_the_whole_container() {
        // The byte count used to be measured before the word timings were added,
        // so it under-reported whenever they were present.
        let dir = temp_dir("size");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(1)).unwrap();
        let output = dir.join("out.tsf");

        let result =
            write_tsf(&output, "text", &audio, draft(), Some(&"x".repeat(50_000))).expect("write");
        assert_eq!(result.bytes, std::fs::metadata(&output).unwrap().len());
    }

    /// A container on disk, for the reading tests.
    fn written(dir: &Path, transcript: &str, words: Option<&str>) -> PathBuf {
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(2)).unwrap();
        let output = dir.join("out.tsf");
        let mut meta = draft();
        if words.is_some() {
            meta.as_object_mut()
                .unwrap()
                .insert("words".into(), serde_json::json!(WORDS_MEMBER));
        }
        write_tsf(&output, transcript, &audio, meta, words).expect("write");
        output
    }

    #[test]
    fn reads_back_what_was_written() {
        let dir = temp_dir("read");
        let transcript = "ALICE: \u{27E6}0.00\u{2013}1.00\u{27E7}Hello.";
        let path = written(&dir, transcript, None);

        let container = read_tsf(&path).expect("read");
        assert_eq!(container.transcript, transcript);
        assert_eq!(container.audio_member, "audio.wav");
        assert_eq!(container.audio.as_ref(), wav_bytes(2).as_slice());
        assert_eq!(container.meta["tsf_version"], 1);
        assert_eq!(container.path, path);
    }

    #[test]
    fn a_round_trip_preserves_the_audio_exactly() {
        let dir = temp_dir("roundtrip");
        let path = written(&dir, "text", None);
        assert_eq!(
            read_tsf(&path).unwrap().audio.as_ref(),
            wav_bytes(2).as_slice()
        );
    }

    #[test]
    fn reads_a_container_that_carries_word_timings() {
        let dir = temp_dir("readwords");
        let path = written(&dir, "text", Some("[{\"start\":0}]"));
        let container = read_tsf(&path).expect("read");
        assert_eq!(container.meta["words"], WORDS_MEMBER);
        assert_eq!(
            container.words.as_deref(),
            Some(b"[{\"start\":0}]".as_slice())
        );
    }

    #[test]
    fn repack_keeps_audio_metadata_and_words() {
        let dir = temp_dir("repack");
        let source = written(&dir, "before", Some("[{\"start\":0}]"));
        let open = read_tsf(&source).expect("open");
        let output = dir.join("saved.tsf");
        let (temporary, file) = create_temporary_file(&dir, &output).expect("temporary");
        write_open_archive(file, "after", &open).expect("repack");
        std::fs::rename(temporary, &output).expect("publish");

        let mut zip = ZipArchive::new(File::open(&output).unwrap()).unwrap();
        let mut transcript = String::new();
        zip.by_name(TRANSCRIPT_MEMBER)
            .unwrap()
            .read_to_string(&mut transcript)
            .unwrap();
        assert_eq!(transcript, "after");
        let mut audio = Vec::new();
        let member = zip.by_name("audio.wav").unwrap();
        assert_eq!(member.compression(), CompressionMethod::Stored);
        drop(member);
        zip.by_name("audio.wav")
            .unwrap()
            .read_to_end(&mut audio)
            .unwrap();
        assert_eq!(audio, wav_bytes(2));
        let mut words = String::new();
        zip.by_name(WORDS_MEMBER)
            .unwrap()
            .read_to_string(&mut words)
            .unwrap();
        assert_eq!(words, "[{\"start\":0}]");
    }

    #[test]
    fn rejects_unsafe_audio_member_names() {
        for name in [
            "",
            "../audio.m4a",
            "audio/part.m4a",
            "audio\\part.m4a",
            "/audio.m4a",
        ] {
            assert!(validate_member_name(name).is_err(), "{name}");
        }
    }

    #[test]
    fn detects_a_changed_source_before_repacking() {
        let dir = temp_dir("changed-save");
        let path = written(&dir, "before", None);
        let open = read_tsf(&path).expect("open");
        std::fs::write(&path, b"replacement").unwrap();
        assert!(source_is_unchanged(&open).is_err());
    }

    /// Pins why the save checks twice with different strength: the cheap check
    /// exists to refuse early, not to decide that publishing is safe.
    #[test]
    fn the_cheap_check_misses_what_the_fingerprint_catches() {
        let dir = temp_dir("same-size-edit");
        let path = written(&dir, "before", None);
        let open = read_tsf(&path).expect("open");

        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&path, &bytes).unwrap();
        // Restore the timestamp too, so nothing but the bytes themselves
        // distinguishes this from the container that was opened.
        let times =
            std::fs::FileTimes::new().set_modified(open.source_metadata.modified().unwrap());
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(times)
            .unwrap();

        assert!(source_metadata_is_unchanged(&open).is_ok());
        assert!(source_is_unchanged(&open).is_err());
    }

    #[test]
    fn save_temporary_paths_are_unique() {
        let dir = temp_dir("unique-temp");
        let output = dir.join("out.tsf");
        assert_ne!(
            temporary_save_path(&dir, &output),
            temporary_save_path(&dir, &output)
        );
    }

    #[test]
    fn temporary_creation_skips_an_existing_path() {
        let dir = temp_dir("temporary-collision");
        let output = dir.join("out.tsf");
        let occupied = temporary_save_path(&dir, &output);
        File::create(&occupied).unwrap();

        let (temporary, file) = create_temporary_file(&dir, &output).expect("temporary");
        drop(file);
        assert_ne!(temporary, occupied);
    }

    #[test]
    fn refuses_a_file_that_is_not_a_container() {
        let dir = temp_dir("notzip");
        let path = dir.join("fake.tsf");
        std::fs::write(&path, b"ALICE: this is just a text file\n").unwrap();
        let error = read_tsf(&path).unwrap_err();
        assert!(error.contains("not a .tsf container"), "got: {error}");
    }

    #[test]
    fn refuses_a_missing_file() {
        let dir = temp_dir("missing");
        assert!(read_tsf(&dir.join("nope.tsf"))
            .unwrap_err()
            .contains("No such file"));
    }

    #[test]
    fn refuses_a_container_from_a_newer_format_version() {
        // Unknown keys are carried through, but a version bump means breaking
        // changes, so opening hopefully would risk misreading the file.
        let dir = temp_dir("newer");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(1)).unwrap();
        let path = dir.join("out.tsf");
        let mut meta = draft();
        meta.as_object_mut()
            .unwrap()
            .insert("tsf_version".into(), serde_json::json!(99));
        write_tsf(&path, "text", &audio, meta, None).expect("write");

        let error = read_tsf(&path).unwrap_err();
        assert!(error.contains("newer version"), "got: {error}");
    }

    #[test]
    fn refuses_a_container_with_no_version() {
        let dir = temp_dir("noversion");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(1)).unwrap();
        let path = dir.join("out.tsf");
        let mut meta = draft();
        meta.as_object_mut().unwrap().remove("tsf_version");
        write_tsf(&path, "text", &audio, meta, None).expect("write");

        assert!(read_tsf(&path).unwrap_err().contains("no tsf_version"));
    }

    #[test]
    fn carries_unknown_metadata_keys_through_to_the_caller() {
        let dir = temp_dir("unknown");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(1)).unwrap();
        let path = dir.join("out.tsf");
        let mut meta = draft();
        meta.as_object_mut().unwrap().insert(
            "written_by_a_later_version".into(),
            serde_json::json!({ "x": 1 }),
        );
        write_tsf(&path, "text", &audio, meta, None).expect("write");

        let container = read_tsf(&path).expect("read");
        assert_eq!(container.meta["written_by_a_later_version"]["x"], 1);
    }

    #[test]
    fn reports_a_container_whose_audio_member_is_missing() {
        // write_tsf cannot produce this — it names the member itself — so the
        // archive is built by hand. This is the shape a hand-edited or
        // truncated container would have, and the error should say which
        // member is absent rather than failing vaguely later.
        let dir = temp_dir("noaudio");
        let path = dir.join("broken.tsf");
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file(TRANSCRIPT_MEMBER, options).unwrap();
        zip.write_all(b"text").unwrap();
        zip.start_file(META_MEMBER, options).unwrap();
        zip.write_all(
            serde_json::json!({
                "tsf_version": 1,
                "audio": { "file": "elsewhere.m4a" }
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        zip.finish().unwrap();

        let error = read_tsf(&path).unwrap_err();
        assert!(error.contains("has no elsewhere.m4a"), "got: {error}");
    }

    #[test]
    fn reports_a_container_with_no_transcript() {
        let dir = temp_dir("notranscript");
        let path = dir.join("broken.tsf");
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        zip.start_file(META_MEMBER, SimpleFileOptions::default())
            .unwrap();
        zip.write_all(
            serde_json::json!({ "tsf_version": 1, "audio": { "file": "a.wav" } })
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        zip.finish().unwrap();

        let error = read_tsf(&path).unwrap_err();
        assert!(error.contains("has no transcript.txt"), "got: {error}");
    }

    #[test]
    fn signature_check_distinguishes_containers_from_text() {
        let dir = temp_dir("signature");
        let zip = written(&dir, "text", None);
        let text = dir.join("plain.txt");
        std::fs::write(&text, b"not a zip").unwrap();

        assert!(looks_like_container(&zip));
        assert!(!looks_like_container(&text));
        assert!(!looks_like_container(&dir.join("absent")));
    }

    #[test]
    fn a_declared_size_never_drives_the_allocation_directly() {
        // The number comes from the file's own header, so it is a claim. An
        // absurd one must not become an allocation request.
        assert_eq!(reserve_for(0), 0);
        assert_eq!(reserve_for(1024), 1024);
        assert_eq!(reserve_for(u64::MAX), 32 * 1024 * 1024);
        assert_eq!(reserve_for(u64::MAX) as u64, 32 * 1024 * 1024);
    }

    #[test]
    fn the_path_recorded_on_open_is_absolute() {
        let dir = temp_dir("relative");
        let path = written(&dir, "text", None);
        let container = read_tsf(&path).expect("read");
        assert!(container.path.is_absolute());
    }

    #[test]
    fn a_truncated_container_fails_with_a_message_not_a_panic() {
        let dir = temp_dir("truncated");
        let path = written(&dir, "some transcript text", None);
        let whole = std::fs::read(&path).unwrap();
        // Keep the zip signature so it gets past the cheap check, then cut it
        // short — an interrupted copy looks exactly like this.
        std::fs::write(&path, &whole[..whole.len() / 2]).unwrap();

        let error = read_tsf(&path).unwrap_err();
        assert!(!error.is_empty());
    }

    #[test]
    fn a_container_whose_transcript_is_not_utf8_is_reported_as_such() {
        let dir = temp_dir("notutf8");
        let path = dir.join("bad.tsf");
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file(META_MEMBER, options).unwrap();
        zip.write_all(
            serde_json::json!({ "tsf_version": 1, "audio": { "file": "a.wav" } })
                .to_string()
                .as_bytes(),
        )
        .unwrap();
        zip.start_file(TRANSCRIPT_MEMBER, options).unwrap();
        zip.write_all(&[0xff, 0xfe, 0xfd]).unwrap();
        zip.start_file("a.wav", options).unwrap();
        zip.write_all(b"x").unwrap();
        zip.finish().unwrap();

        let error = read_tsf(&path).unwrap_err();
        assert!(error.contains("not valid UTF-8"), "got: {error}");
    }

    #[test]
    fn refuses_to_write_the_container_over_its_own_recording() {
        let dir = temp_dir("selfdestruct");
        let audio = dir.join("recording.m4a");
        std::fs::write(&audio, wav_bytes(2)).unwrap();

        let error = write_tsf(&audio, "text", &audio, draft(), None).unwrap_err();
        assert!(error.contains("written over the recording"), "got: {error}");
        assert!(
            std::fs::read(&audio).unwrap().starts_with(b"RIFF"),
            "the recording must be untouched"
        );
    }

    #[test]
    fn recognises_the_same_file_through_a_relative_path() {
        let dir = temp_dir("samefile");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(1)).unwrap();
        let roundabout = dir.join("sub").join("..").join("rec.wav");
        std::fs::create_dir_all(dir.join("sub")).unwrap();

        assert!(same_file(&roundabout, &audio));
        assert!(!same_file(&dir.join("other.tsf"), &audio));
    }

    /// A container deleted while it is open must still be saveable.
    ///
    /// Everything the repack needs is in memory — the transcript from the
    /// editor, the recording in `OpenTsf` — so refusing here would strand the
    /// only copy of a tidied transcript, and its audio with it.
    #[test]
    fn a_deleted_source_does_not_stop_the_repack() {
        let dir = temp_dir("deleted-source-save");
        let path = written(&dir, "before", None);
        let open = read_tsf(&path).expect("open");
        std::fs::remove_file(&path).unwrap();

        assert!(source_is_unchanged(&open).is_ok());
    }

    /// The distinction the fix rests on: gone is not the same as changed.
    #[test]
    fn a_changed_source_still_stops_the_repack_after_one_was_deleted() {
        let dir = temp_dir("changed-not-deleted");
        let path = written(&dir, "before", None);
        let open = read_tsf(&path).expect("open");
        std::fs::remove_file(&path).unwrap();
        // Something else takes the name. That is a different file, not the one
        // this document came from, so publishing over it is refused.
        std::fs::write(&path, b"someone else's file").unwrap();

        assert!(source_is_unchanged(&open).is_err());
    }

    #[test]
    fn a_playable_recording_is_stored_untouched() {
        let dir = temp_dir("no-conversion");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(1)).unwrap();

        let prepared = prepare_audio_for_container(&audio, None).expect("prepare");

        // The file itself, not a copy of it: nothing to convert, nothing to
        // re-encode, and nothing to delete afterwards.
        assert_eq!(prepared.path(), audio);
        assert!(!prepared.temporary);
    }

    #[test]
    fn a_recording_the_player_can_read_is_recognised() {
        let dir = temp_dir("playable");
        let audio = dir.join("rec.wav");
        std::fs::write(&audio, wav_bytes(1)).unwrap();

        assert!(audio_is_playable(&audio));
        assert!(!audio_is_playable(&dir.join("nothing-here.wav")));
    }

    /// Conversion tests run one at a time.
    ///
    /// Leftover temporary files are counted by process id, and the whole test
    /// binary is one process: two conversions running at once would each see
    /// the other's file and call it litter.
    static CONVERSIONS: Mutex<()> = Mutex::new(());

    fn one_conversion_at_a_time() -> std::sync::MutexGuard<'static, ()> {
        // A test that panicked while holding it poisoned it; that says nothing
        // about this one's ability to run.
        CONVERSIONS.lock().unwrap_or_else(|held| held.into_inner())
    }

    /// Whether ffmpeg is on this machine at all. The conversion cannot be
    /// tested without it, and a machine that lacks it should not fail the
    /// suite over a dependency the common import path does not need.
    fn ffmpeg_present() -> bool {
        std::process::Command::new("ffmpeg")
            .arg("-version")
            .output()
            .is_ok()
    }

    /// The whole of §5.6 end to end: a recording the player refuses becomes one
    /// it accepts, stored under a name that says what it now is.
    #[test]
    fn an_unplayable_recording_is_converted_into_the_container() {
        let _one_at_a_time = one_conversion_at_a_time();
        if !ffmpeg_present() {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        }
        let dir = temp_dir("conversion");
        let source = dir.join("rec.opus");
        // Opus in ogg: a real file, and one symphonia is not built to decode,
        // so it stands in for the HE-AAC recordings this exists for.
        let made = std::process::Command::new("ffmpeg")
            .args([
                "-nostdin",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
            ])
            .args(["-c:a", "libopus"])
            .arg(&source)
            .output()
            .expect("run ffmpeg");
        if !made.status.success() {
            eprintln!("skipping: this ffmpeg cannot write opus");
            return;
        }
        assert!(!audio_is_playable(&source), "the premise of this test");

        let before = converted_files_in_temp();
        let output = dir.join("out.tsf");
        let result = write_tsf(&output, "hello", &source, draft(), None).expect("write");

        assert_eq!(result.codec, "aac");
        let open = read_tsf(&output).expect("open");
        assert_eq!(open.audio_member, "audio.m4a");
        assert_eq!(open.meta["audio"]["file"], "audio.m4a");
        // The conversion's output belongs to the import and to nothing after
        // it. Counted here rather than in a test of its own: the count is by
        // process, and two conversions running at once in the same test binary
        // would each see the other's file.
        assert_eq!(
            converted_files_in_temp(),
            before,
            "a converted file was left behind"
        );
    }

    /// ffmpeg's own output is what the window shows, so it has to reach the
    /// buffer the window collects from *while the conversion is still running*.
    /// Collecting it afterwards would prove nothing: a window that fills up
    /// once the work is over has shown the user an empty box throughout.
    #[test]
    fn the_conversion_reports_what_ffmpeg_says_while_it_runs() {
        let _one_at_a_time = one_conversion_at_a_time();
        if !ffmpeg_present() {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        }
        let dir = temp_dir("conversion-output");
        let source = dir.join("rec.opus");
        // Long enough that there is a middle to catch it in.
        if !make_opus_of_length(&source, 600) {
            return;
        }
        let state = Arc::new(ConversionState::default());

        let watcher = Arc::clone(&state);
        let watching = std::thread::spawn(move || {
            let mut said = Vec::new();
            let mut duration = None;
            let mut position = None;
            for _ in 0..600 {
                {
                    let mut guard = watcher.lock().expect("lock");
                    if let Some(running) = guard.as_mut() {
                        said.append(&mut running.lines);
                        duration = duration.or(running.duration_secs);
                        position = position.or(running.position_secs);
                    }
                }
                if !said.is_empty() && duration.is_some() && position.is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            // Stop it: the point is what arrived by now, not the whole file.
            watcher.request_cancel();
            (said, duration, position)
        });

        let error = convert_to_playable_audio(&source, Some(&state)).unwrap_err();
        let (said, duration, position) = watching.join().expect("watcher");

        assert_eq!(error, CONVERSION_CANCELLED);
        assert!(
            said.iter().any(|line| line.contains("Stream mapping")),
            "the window saw none of ffmpeg's own words: {said:?}"
        );
        assert!(
            said.iter().all(|line| !line.starts_with("out_time=")),
            "the progress fields were shown as if they were words: {said:?}"
        );
        // Near enough 600: the container's own duration, rounded as ffmpeg
        // prints it, not the length asked for.
        assert!(
            duration.is_some_and(|duration| (duration - 600.0).abs() < 1.0),
            "the recording's length was not read: {duration:?}"
        );
        assert!(
            position.is_some_and(|position| position >= 0.0),
            "no position to put a bar at"
        );
        let guard = state.lock().expect("lock");
        let running = guard
            .as_ref()
            .expect("the record was cleared, taking ffmpeg's last words with it");
        assert!(running.finished, "left running");
    }

    /// What ffmpeg says last is what says why it failed: the error is printed
    /// immediately before it exits, after the window's final collection has
    /// been scheduled but before it happens. Clearing the record at the end
    /// threw exactly those lines away.
    #[test]
    fn what_ffmpeg_says_at_the_end_outlives_the_conversion() {
        let state = ConversionState::default();
        state.begin_import();
        // Stands in for a running ffmpeg. No child, because none is spawned:
        // what is under test is the record's lifetime, not the process's.
        *state.lock().expect("lock") = Some(RunningConversion {
            child: None,
            finished: false,
            lines: Vec::new(),
            duration_secs: None,
            position_secs: None,
        });

        state.record("Stream mapping:".to_string());
        // Collected once while it runs, as the window does.
        let collected =
            std::mem::take(&mut state.lock().expect("lock").as_mut().expect("record").lines);
        assert_eq!(collected, vec!["Stream mapping:".to_string()]);

        // Said after that collection and before the next one, which is where
        // the reason for a failure always lands.
        state.record("[aac] Invalid data found when processing input".to_string());
        state.finish();

        let guard = state.lock().expect("lock");
        let running = guard.as_ref().expect("the record was cleared");
        assert_eq!(
            running.lines,
            vec!["[aac] Invalid data found when processing input".to_string()],
            "the last words were thrown away"
        );
        assert!(running.finished, "still claiming to run");
    }

    /// The record outliving the conversion must not outlive the import: the
    /// next one would open showing the previous one's output, and one that
    /// converts nothing would show a length and a bar it never earned.
    #[test]
    fn a_new_import_does_not_inherit_the_last_conversions_words() {
        let state = ConversionState::default();
        *state.lock().expect("lock") = Some(RunningConversion {
            child: None,
            finished: false,
            lines: vec!["Stream mapping:".to_string()],
            duration_secs: Some(600.0),
            position_secs: Some(12.0),
        });
        state.finish();

        state.begin_import();

        assert!(
            state.lock().expect("lock").is_none(),
            "the new import inherited the last conversion's record"
        );
    }

    /// Converting is one step of an import; packaging the container is the
    /// next, and takes seconds of its own on a long recording. A cancellation
    /// arriving during those seconds used to be read by nobody, and the import
    /// the user stopped finished and opened anyway.
    #[test]
    fn cancelling_after_the_conversion_still_stops_the_import() {
        let dir = temp_dir("cancel-while-packing");
        let source = dir.join("rec.wav");
        // Playable as it is, so nothing converts and the cancellation can only
        // be caught by the packaging step.
        std::fs::write(&source, wav_bytes(1)).expect("write wav");
        let output = dir.join("out.tsf");
        let state = ConversionState::default();
        state.begin_import();
        state.request_cancel();

        let error = super::write_tsf(&output, "hello", &source, draft(), None, Some(&state))
            .expect_err("a cancelled import should not produce a container");

        assert_eq!(error, CONVERSION_CANCELLED);
        assert!(
            !output.exists(),
            "a cancelled import left a container behind"
        );
        assert_eq!(
            std::fs::read_dir(&dir).expect("read dir").count(),
            1,
            "a cancelled import left its temporary file behind"
        );
    }

    /// A cancellation belongs to the import it stopped, and to no later one.
    #[test]
    fn a_new_import_is_not_cancelled_by_the_last_one() {
        let dir = temp_dir("cancel-not-sticky");
        let source = dir.join("rec.wav");
        std::fs::write(&source, wav_bytes(1)).expect("write wav");
        let state = ConversionState::default();
        state.request_cancel();

        state.begin_import();

        let output = dir.join("out.tsf");
        super::write_tsf(&output, "hello", &source, draft(), None, Some(&state))
            .expect("the next import should run");
        assert!(output.exists());
    }

    /// The filter drops ffmpeg's progress fields and nothing else. Anything it
    /// takes for one vanishes from the output with nothing left to say it was
    /// ever printed.
    #[test]
    fn only_the_progress_fields_are_treated_as_progress() {
        for field in [
            "out_time=00:00:01.000000",
            "bitrate=  66.1kbits/s",
            "progress=continue",
            "total_size=742950",
            "speed= 215x",
            "stream_0_0_q=-1.0",
            "size=     726kB",
        ] {
            assert!(is_progress_field(field), "should be a reading: {field}");
        }

        for said in [
            "  Duration: 00:01:30.01, start: 0.000000, bitrate: 80 kb/s",
            "  configuration: --prefix=/usr --extra-version=3ubuntu5",
            "[aac @ 0x5581f2a] Queue input is backward in time",
            "Input #0, ogg, from 'rec.opus':",
            "deprecated_pixel_format=yuvj420p is used",
            "Stream mapping:",
        ] {
            assert!(!is_progress_field(said), "should be shown: {said}");
        }
    }

    /// ffmpeg's last line is reliably the least useful thing it said. These are
    /// its real endings, from actual failing conversions.
    #[test]
    fn the_failure_reason_is_the_line_that_explains_it() {
        let disk_full = [
            "[out#0/ipod @ 0x5f9a] video:0kB audio:708kB",
            "Error writing trailer of /tmp/out.m4a: No space left on device",
            "[aac @ 0x58e3] Qavg: nan",
            "Conversion failed!",
        ]
        .map(String::from);
        assert_eq!(
            failure_reason(&disk_full),
            "Error writing trailer of /tmp/out.m4a: No space left on device"
        );

        let bad_input = [
            "[in#0 @ 0x55ed] Error opening input: Invalid data found when processing input",
            "Error opening input file bogus.opus.",
            "Error opening input files: Invalid data found when processing input",
        ]
        .map(String::from);
        assert_eq!(
            failure_reason(&bad_input),
            "Error opening input files: Invalid data found when processing input"
        );

        // Nothing that explains itself: the sign-offs are still worth less than
        // the line before them.
        let unhelpful = ["[aac @ 0x1] Qavg: 110.383", "Conversion failed!"].map(String::from);
        assert_eq!(failure_reason(&unhelpful), "[aac @ 0x1] Qavg: 110.383");

        assert_eq!(failure_reason(&[]), "no output");
    }

    /// The bar's scale is the recording's length, and it must not move partway
    /// through because ffmpeg mentioned another duration.
    #[test]
    fn the_length_is_the_first_one_reported() {
        let state = ConversionState::default();
        state
            .begin(
                std::process::Command::new("true")
                    .spawn()
                    .expect("spawn true"),
            )
            .expect("begin");

        state.record("  Duration: 00:10:00.00, start: 0.000000, bitrate: 80 kb/s".to_string());
        state.record("  Duration: 00:00:03.00, start: 0.000000, bitrate: 64 kb/s".to_string());

        let mut guard = state.lock().expect("lock");
        assert_eq!(guard.as_mut().expect("running").duration_secs, Some(600.0));
    }

    /// The sweep deletes recording-sized litter, so what it will not touch
    /// matters more than what it will: a conversion belonging to a Wisty that
    /// is still running must survive it.
    #[test]
    fn the_sweep_takes_only_what_no_process_owns() {
        let temp = std::env::temp_dir();
        // A pid no process can have: the kernel's maximum is far below this.
        let abandoned = temp.join(format!("{CONVERSION_PREFIX}4294967295-77.m4a"));
        let ours = temp.join(format!("{CONVERSION_PREFIX}{}-77.m4a", std::process::id()));
        let innocent = temp.join("wisty-something-else.m4a");
        for path in [&abandoned, &ours, &innocent] {
            std::fs::write(path, b"x").expect("write");
        }

        sweep_conversion_leftovers();

        assert!(!abandoned.exists(), "the abandoned conversion was kept");
        assert!(ours.exists(), "a live Wisty's conversion was deleted");
        assert!(innocent.exists(), "a file that is not ours was deleted");

        let _ = std::fs::remove_file(&ours);
        let _ = std::fs::remove_file(&innocent);
    }

    /// The bar's two readings, out of the stream they share with the log.
    #[test]
    fn progress_is_read_out_of_the_output_and_kept_out_of_it() {
        let state = ConversionState::default();
        state
            .begin(
                std::process::Command::new("true")
                    .spawn()
                    .expect("spawn true"),
            )
            .expect("begin");

        for line in [
            "Input #0, ogg, from 'rec.opus':",
            "  Duration: 00:01:30.01, start: 0.000000, bitrate: 80 kb/s",
            "Stream mapping:",
            "bitrate=N/A",
            "out_time=N/A",
            "progress=continue",
            "out_time=00:00:12.500000",
        ] {
            state.record(line.to_string());
        }

        let mut guard = state.lock().expect("lock");
        let running = guard.as_mut().expect("running");
        assert_eq!(running.duration_secs, Some(90.01));
        assert_eq!(running.position_secs, Some(12.5));
        assert_eq!(
            running.lines,
            [
                "Input #0, ogg, from 'rec.opus':",
                "  Duration: 00:01:30.01, start: 0.000000, bitrate: 80 kb/s",
                "Stream mapping:",
            ],
            "the progress fields are unreadable and are not for reading"
        );
    }

    /// Cancelling stops the conversion, says so distinctly, and leaves nothing.
    #[test]
    fn cancelling_stops_the_conversion_and_reports_it_as_cancelled() {
        let _one_at_a_time = one_conversion_at_a_time();
        if !ffmpeg_present() {
            eprintln!("skipping: ffmpeg is not installed");
            return;
        }
        let dir = temp_dir("conversion-cancel");
        let source = dir.join("rec.opus");
        // Long enough that the cancellation lands while ffmpeg is still working.
        if !make_opus_of_length(&source, 600) {
            return;
        }
        let before = converted_files_in_temp();
        let state = Arc::new(ConversionState::default());

        let stopper = Arc::clone(&state);
        let stopping = std::thread::spawn(move || {
            // Wait for the conversion to be registered, then stop it.
            for _ in 0..200 {
                if stopper.lock().map(|guard| guard.is_some()).unwrap_or(false) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            stopper.request_cancel();
        });

        let error = convert_to_playable_audio(&source, Some(&state)).unwrap_err();
        stopping.join().expect("stopper");

        assert_eq!(error, CONVERSION_CANCELLED);
        assert_eq!(
            converted_files_in_temp(),
            before,
            "a cancelled conversion left its output behind"
        );
    }

    fn make_opus_of_length(path: &Path, seconds: u32) -> bool {
        let made = std::process::Command::new("ffmpeg")
            .args(["-nostdin", "-y", "-f", "lavfi", "-i"])
            .arg(format!("sine=frequency=440:duration={seconds}"))
            .args(["-c:a", "libopus"])
            .arg(path)
            .output()
            .expect("run ffmpeg");
        if !made.status.success() {
            eprintln!("skipping: this ffmpeg cannot write opus");
        }
        made.status.success()
    }

    fn converted_files_in_temp() -> usize {
        let prefix = format!("wisty-import-{}-", std::process::id());
        std::fs::read_dir(std::env::temp_dir())
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok())
                    .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
                    .count()
            })
            .unwrap_or(0)
    }
}
