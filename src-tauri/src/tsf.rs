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
use std::io::{BufReader, BufWriter, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::path::{Path, PathBuf};

use serde::Serialize;
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
struct AudioFacts {
    duration: f64,
    codec: String,
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
        .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
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

    Ok(AudioFacts { duration, codec })
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

    audio.insert("file".into(), serde_json::Value::String(audio_member.to_string()));
    audio.insert("codec".into(), serde_json::Value::String(facts.codec.clone()));
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

    let facts = probe_audio(audio_path)?;
    let audio_member = audio_member_name(audio_path);
    let meta = complete_meta(meta_draft, &facts, &audio_member)?;

    let parent = output_path
        .parent()
        .ok_or_else(|| "Output path has no parent directory".to_string())?;
    let temporary = parent.join(format!(
        ".{}.partial",
        output_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("transcript.tsf")
    ));

    let result = write_archive(&temporary, transcript, audio_path, &meta, &audio_member, words);
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }

    std::fs::rename(&temporary, output_path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("Cannot write {}: {error}", output_path.display())
    })?;

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
    temporary: &Path,
    transcript: &str,
    audio_path: &Path,
    meta: &[u8],
    audio_member: &str,
    words: Option<&str>,
) -> Result<(), String> {
    let file = File::create(temporary)
        .map_err(|error| format!("Cannot create {}: {error}", temporary.display()))?;
    let mut zip = ZipWriter::new(BufWriter::new(file));

    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    // Audio is already compressed; deflating it again costs seconds and saves nothing.
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

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
        return Err(format!("The container has an unsafe audio member name: {name}"));
    }
    Ok(())
}

fn fingerprint_file(path: &Path) -> Result<u64, String> {
    let mut file = File::open(path).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
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

    let meta: serde_json::Value =
        serde_json::from_slice(&read_member_from(&mut zip, META_MEMBER)?)
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
        .filter_map(|index| zip.by_index(index).ok().map(|member| member.name().to_string()))
        .filter(|name| name != TRANSCRIPT_MEMBER && name != META_MEMBER && name != &audio_member && name != WORDS_MEMBER)
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
        Err(_) => None
    };
    let source_metadata = std::fs::metadata(archive)
        .map_err(|error| format!("Cannot stat {}: {error}", archive.display()))?;
    let source_fingerprint = fingerprint_file(archive)?;

    Ok(OpenTsf {
        // Absolute, so saving back later cannot be affected by the working
        // directory having changed since the file was opened.
        path: archive.canonicalize().unwrap_or_else(|_| archive.to_path_buf()),
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
#[tauri::command]
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
#[tauri::command]
pub fn close_tsf(
    state: tauri::State<'_, TsfState>,
    playback: tauri::State<'_, crate::playback::PlaybackState>,
) -> Result<(), String> {
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

fn source_is_unchanged(open: &OpenTsf) -> Result<(), String> {
    let current = std::fs::metadata(&open.path)
        .map_err(|error| format!("Cannot check {} before saving: {error}", open.path.display()))?;
    if current.len() != open.source_metadata.len() || current.modified().ok() != open.source_metadata.modified().ok() {
        return Err("The transcript container changed on disk after it was opened. Reopen it before saving so no changes are lost.".to_string());
    }
    if fingerprint_file(&open.path)? != open.source_fingerprint {
        return Err("The transcript container changed on disk after it was opened. Reopen it before saving so no changes are lost.".to_string());
    }
    Ok(())
}

fn temporary_save_path(parent: &Path, output: &Path) -> PathBuf {
    parent.join(format!(
        ".{}.{}.{}.partial",
        output.file_name().and_then(|name| name.to_str()).unwrap_or("transcript.tsf"),
        std::process::id(),
        SAVE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}

fn write_open_archive(temporary: &Path, transcript: &str, open: &OpenTsf) -> Result<(), String> {
    validate_member_name(&open.audio_member)?;
    let file = OpenOptions::new().write(true).create_new(true).open(temporary)
        .map_err(|error| format!("Cannot create {}: {error}", temporary.display()))?;
    let mut zip = ZipWriter::new(BufWriter::new(file));
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

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
    zip.write_all(&serde_json::to_vec_pretty(&open.meta).map_err(|error| format!("Cannot serialise metadata: {error}"))?)
        .map_err(|error| format!("Cannot write {META_MEMBER}: {error}"))?;
    if let Some(words) = &open.words {
        zip.start_file(WORDS_MEMBER, deflated)
            .map_err(|error| format!("Cannot write {WORDS_MEMBER}: {error}"))?;
        zip.write_all(words)
            .map_err(|error| format!("Cannot write {WORDS_MEMBER}: {error}"))?;
    }
    let writer = zip.finish().map_err(|error| format!("Cannot finalise the container: {error}"))?;
    writer.into_inner().map_err(|error| format!("Cannot flush the container: {error}"))?.sync_all()
        .map_err(|error| format!("Cannot sync the container: {error}"))
}

/// Rebuilds the open container with the edited transcript without routing audio
/// through the webview. The source snapshot must still match disk, and unknown
/// archive members are refused rather than silently discarded.
#[tauri::command]
pub fn save_tsf(state: tauri::State<'_, TsfState>, path: String, transcript: String) -> Result<(), String> {
    // The frontend also blocks duplicate saves, but commands are independently
    // invokable. Keep the archive operation single-flight at the authority.
    let _save = state.1.lock()
        .map_err(|error| format!("Cannot take the container-save lock: {error}"))?;
    let open = state.0.lock()
        .map_err(|error| format!("Cannot take the open-container lock: {error}"))?
        .clone()
        .ok_or_else(|| "No transcript container is open".to_string())?;
    if !open.unsupported_members.is_empty() {
        return Err(format!(
            "This container has unsupported archive members that Wisty cannot preserve: {}",
            open.unsupported_members.join(", ")
        ));
    }
    source_is_unchanged(&open)?;
    let output = PathBuf::from(path);
    let parent = output.parent().ok_or_else(|| "Output path has no parent directory".to_string())?;
    let temporary = temporary_save_path(parent, &output);
    if let Err(error) = write_open_archive(&temporary, &transcript, &open) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    // Check again immediately before replacement. A timestamp/length check
    // alone misses same-sized edits, so source_is_unchanged also fingerprints.
    if let Err(error) = source_is_unchanged(&open) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    std::fs::rename(&temporary, &output).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("Cannot write {}: {error}", output.display())
    })?;
    let mut guard = state.0.lock()
        .map_err(|error| format!("Cannot take the open-container lock: {error}"))?;
    let current = guard.as_mut().ok_or_else(|| "The transcript container was closed while saving".to_string())?;
    if current.path != open.path {
        return Err("A different transcript container was opened while saving".to_string());
    }
    current.path = output.canonicalize().unwrap_or(output);
    current.source_metadata = std::fs::metadata(&current.path)
        .map_err(|error| format!("Cannot stat saved container: {error}"))?;
    current.source_fingerprint = fingerprint_file(&current.path)?;
    Ok(())
}

#[tauri::command]
pub fn create_tsf(
    output_path: String,
    transcript: String,
    audio_path: String,
    meta: serde_json::Value,
    words: Option<String>,
) -> Result<CreateTsfResult, String> {
    let output = PathBuf::from(&output_path);
    let audio = PathBuf::from(&audio_path);

    if !audio.is_file() {
        return Err(format!("No such audio file: {audio_path}"));
    }

    let mut meta = meta;
    if words.is_some() {
        if let Some(object) = meta.as_object_mut() {
            object.insert("words".into(), serde_json::Value::String(WORDS_MEMBER.into()));
        }
    }

    write_tsf(&output, &transcript, &audio, meta, words.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

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
        assert!((facts.duration - 3.0).abs() < 0.01, "duration was {}", facts.duration);
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
        let facts = AudioFacts { duration: 12.5, codec: "aac".into() };
        let mut input = draft();
        // A field this side has never heard of must survive: the format's growth
        // depends on producers being able to add keys without readers changing.
        input.as_object_mut().unwrap().insert("future_field".into(), serde_json::json!({"a": 1}));

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
        let facts = AudioFacts { duration: 1.0, codec: "x".into() };
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
        zip.by_name("transcript.txt").unwrap().read_to_string(&mut text).unwrap();
        assert_eq!(text, transcript);

        let mut meta = String::new();
        zip.by_name("meta.json").unwrap().read_to_string(&mut meta).unwrap();
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
        assert!(leftovers.is_empty(), "no temporary file should be left behind");
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
        zip.by_name("transcript.txt").unwrap().read_to_string(&mut text).unwrap();
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
        zip.by_name("words.json").unwrap().read_to_string(&mut words).unwrap();
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

        let result = write_tsf(&output, "text", &audio, draft(), Some(&"x".repeat(50_000)))
            .expect("write");
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
        assert_eq!(read_tsf(&path).unwrap().audio.as_ref(), wav_bytes(2).as_slice());
    }

    #[test]
    fn reads_a_container_that_carries_word_timings() {
        let dir = temp_dir("readwords");
        let path = written(&dir, "text", Some("[{\"start\":0}]"));
        let container = read_tsf(&path).expect("read");
        assert_eq!(container.meta["words"], WORDS_MEMBER);
        assert_eq!(container.words.as_deref(), Some(b"[{\"start\":0}]".as_slice()));
    }

    #[test]
    fn repack_keeps_audio_metadata_and_words() {
        let dir = temp_dir("repack");
        let source = written(&dir, "before", Some("[{\"start\":0}]"));
        let open = read_tsf(&source).expect("open");
        let output = dir.join("saved.tsf");
        write_open_archive(&output, "after", &open).expect("repack");

        let mut zip = ZipArchive::new(File::open(&output).unwrap()).unwrap();
        let mut transcript = String::new();
        zip.by_name(TRANSCRIPT_MEMBER).unwrap().read_to_string(&mut transcript).unwrap();
        assert_eq!(transcript, "after");
        let mut audio = Vec::new();
        let member = zip.by_name("audio.wav").unwrap();
        assert_eq!(member.compression(), CompressionMethod::Stored);
        drop(member);
        zip.by_name("audio.wav").unwrap().read_to_end(&mut audio).unwrap();
        assert_eq!(audio, wav_bytes(2));
        let mut words = String::new();
        zip.by_name(WORDS_MEMBER).unwrap().read_to_string(&mut words).unwrap();
        assert_eq!(words, "[{\"start\":0}]");
    }

    #[test]
    fn rejects_unsafe_audio_member_names() {
        for name in ["", "../audio.m4a", "audio/part.m4a", "audio\\part.m4a", "/audio.m4a"] {
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

    #[test]
    fn save_temporary_paths_are_unique() {
        let dir = temp_dir("unique-temp");
        let output = dir.join("out.tsf");
        assert_ne!(temporary_save_path(&dir, &output), temporary_save_path(&dir, &output));
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
        assert!(read_tsf(&dir.join("nope.tsf")).unwrap_err().contains("No such file"));
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
        meta.as_object_mut().unwrap().insert("tsf_version".into(), serde_json::json!(99));
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
        meta.as_object_mut()
            .unwrap()
            .insert("written_by_a_later_version".into(), serde_json::json!({ "x": 1 }));
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
        zip.start_file(META_MEMBER, SimpleFileOptions::default()).unwrap();
        zip.write_all(serde_json::json!({ "tsf_version": 1, "audio": { "file": "a.wav" } }).to_string().as_bytes())
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
}
