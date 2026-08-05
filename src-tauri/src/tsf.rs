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

use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::Timestamp;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

/// The transcript member's name inside the archive. Fixed: a reader looks for it by
/// name, and meta.json names only the audio member, which can vary.
const TRANSCRIPT_MEMBER: &str = "transcript.txt";
const META_MEMBER: &str = "meta.json";
const WORDS_MEMBER: &str = "words.json";

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
}
