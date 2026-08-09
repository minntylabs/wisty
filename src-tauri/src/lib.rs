use log::LevelFilter;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::fs::{File, Metadata};
use std::io::BufWriter;
use std::io::ErrorKind;
use std::io::{IsTerminal, Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const CLI_SOFT_LIMIT_BYTES: u64 = 50 * 1024 * 1024;
const CLI_HARD_LIMIT_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(serde::Serialize)]
struct EditorFontSelection {
    #[serde(rename = "fontFamily")]
    font_family: String,
    #[serde(rename = "fontSize")]
    font_size: f64,
    #[serde(rename = "fontStyle")]
    font_style: String,
    #[serde(rename = "fontWeight")]
    font_weight: i32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorFontInput {
    font_family: String,
    font_size: f64,
    font_style: String,
    font_weight: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchFileArg {
    path: String,
    exists: bool,
    #[serde(rename = "fileSizeBytes")]
    file_size_bytes: Option<u64>,
}

struct LaunchFileStream {
    file: File,
    file_path: String,
    file_size_bytes: u64,
    bytes_read_total: u64,
    utf8_carry: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchFileStreamStartResult {
    stream_id: String,
    file_path: String,
    file_size_bytes: u64,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum LaunchFileStreamChunkResult {
    Chunk {
        text: String,
        #[serde(rename = "bytesReadTotal")]
        bytes_read_total: u64,
        #[serde(rename = "fileSizeBytes")]
        file_size_bytes: u64,
    },
    Eof {
        #[serde(rename = "bytesReadTotal")]
        bytes_read_total: u64,
        #[serde(rename = "fileSizeBytes")]
        file_size_bytes: u64,
    },
}

struct LaunchArgState {
    pending_file: Mutex<Option<LaunchFileArg>>,
    approved_launch_file_path: Option<String>,
    launch_stream_counter: Mutex<u64>,
    active_launch_streams: Mutex<HashMap<String, LaunchFileStream>>,
    save_stream_counter: Mutex<u64>,
    active_save_streams: Mutex<HashMap<String, SaveFileStream>>,
}

struct SaveFileStream {
    target_path: PathBuf,
    temp_path: PathBuf,
    writer: BufWriter<File>,
    bytes_written_total: u64,
    expected_source: Option<ExpectedSource>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextFileVersion {
    size: u64,
    modified_ms: Option<i64>,
    device: Option<u64>,
    inode: Option<u64>,
}

/// What the caller asserts about the target path, rechecked before the rename.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum ExpectedSource {
    /// The file the document was opened from, unchanged since.
    Present { version: TextFileVersion },
    /// No file at all: the document is creating one there.
    Absent,
}

/// A save failure the frontend has to tell apart, rather than read a message for.
///
/// The external-change codes drive the conflict banner; every other failure is
/// an ordinary save error. Serialized as `{ code, message }`, which the
/// frontend's `AppError` already understands.
#[derive(Serialize)]
struct SaveStreamError {
    code: &'static str,
    message: String,
}

const SAVE_FAILED: &str = "SAVE_FAILED";
const SAVE_EXTERNAL_CHANGE: &str = "SAVE_EXTERNAL_CHANGE";
const SAVE_EXTERNAL_DELETE: &str = "SAVE_EXTERNAL_DELETE";
const SAVE_EXTERNAL_APPEARED: &str = "SAVE_EXTERNAL_APPEARED";
const SAVE_EXTERNAL_NOT_A_FILE: &str = "SAVE_EXTERNAL_NOT_A_FILE";

impl SaveStreamError {
    fn failed(message: String) -> Self {
        Self {
            code: SAVE_FAILED,
            message,
        }
    }

    fn conflict(code: &'static str, message: &str) -> Self {
        Self {
            code,
            message: message.to_string(),
        }
    }
}

impl From<String> for SaveStreamError {
    fn from(message: String) -> Self {
        Self::failed(message)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveFileStreamStartResult {
    stream_id: String,
    file_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveFileStreamWriteResult {
    bytes_written_total: u64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SaveFileStreamFinishResult {
    bytes_written_total: u64,
}

impl LaunchArgState {
    fn new(pending_file: Option<LaunchFileArg>) -> Self {
        let approved_launch_file_path = pending_file.as_ref().and_then(|file| {
            if file.exists {
                Some(file.path.clone())
            } else {
                None
            }
        });

        Self {
            pending_file: Mutex::new(pending_file),
            approved_launch_file_path,
            launch_stream_counter: Mutex::new(0),
            active_launch_streams: Mutex::new(HashMap::new()),
            save_stream_counter: Mutex::new(0),
            active_save_streams: Mutex::new(HashMap::new()),
        }
    }
}

fn parse_positional_launch_args() -> Result<Option<String>, String> {
    let mut positional: Vec<String> = Vec::new();
    let mut passthrough_mode = false;

    for arg in std::env::args().skip(1) {
        if !passthrough_mode && arg == "--" {
            passthrough_mode = true;
            continue;
        }
        if !passthrough_mode && arg.starts_with('-') {
            continue;
        }
        positional.push(arg);
    }

    if positional.len() > 1 {
        return Err("Only one file path argument is supported".to_string());
    }

    Ok(positional.into_iter().next())
}

/// Decodes `%XX` escapes in a `file://` URI path (e.g. `%20` for a space).
fn percent_decode(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .and_then(|pair| std::str::from_utf8(pair).ok())
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| "Invalid percent-encoding in file:// path argument".to_string())?;
            decoded.push(hex);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(decoded)
        .map_err(|_| "file:// path argument is not valid UTF-8 after decoding".to_string())
}

fn normalize_cli_path(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("Empty file path argument".to_string());
    }

    let maybe_file_uri = raw.strip_prefix("file://");
    let path = if let Some(uri_path) = maybe_file_uri {
        if uri_path.is_empty() {
            return Err("Invalid file:// path argument".to_string());
        }
        PathBuf::from(percent_decode(uri_path)?)
    } else {
        PathBuf::from(raw)
    };

    if path.is_absolute() {
        return Ok(path);
    }

    let cwd = std::env::current_dir()
        .map_err(|error| format!("Unable to determine current directory: {error}"))?;
    Ok(cwd.join(path))
}

fn is_interactive_tty() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

fn format_size_mb(size_bytes: u64) -> String {
    format!("{:.1}", size_bytes as f64 / (1024.0 * 1024.0))
}

fn confirm_large_cli_open(path: &Path, size_bytes: u64) -> Result<(), String> {
    if size_bytes < CLI_SOFT_LIMIT_BYTES {
        return Ok(());
    }

    if size_bytes >= CLI_HARD_LIMIT_BYTES {
        return Err(format!(
            "File is too large to open safely ({} MB, hard limit is {} MB): {}",
            format_size_mb(size_bytes),
            format_size_mb(CLI_HARD_LIMIT_BYTES),
            path.to_string_lossy()
        ));
    }

    if !is_interactive_tty() {
        return Err(format!(
            "File is large ({} MB). Run from an interactive terminal to confirm opening: {}",
            format_size_mb(size_bytes),
            path.to_string_lossy()
        ));
    }

    eprintln!(
        "wisty: warning: '{}' is a large file ({} MB).",
        path.to_string_lossy(),
        format_size_mb(size_bytes)
    );
    eprint!("Open anyway? [y/N] ");
    std::io::stderr()
        .flush()
        .map_err(|error| format!("Unable to prompt for confirmation: {error}"))?;

    let mut input = String::new();
    std::io::stdin()
        .read_line(&mut input)
        .map_err(|error| format!("Unable to read confirmation input: {error}"))?;

    let answer = input.trim().to_ascii_lowercase();
    if answer == "y" || answer == "yes" {
        return Ok(());
    }

    Err(format!(
        "Opening cancelled for large file: {}",
        path.to_string_lossy()
    ))
}

fn validate_launch_file_arg(path: &Path) -> Result<LaunchFileArg, String> {
    match std::fs::metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err(format!(
                    "Path is not a regular file: {}",
                    path.to_string_lossy()
                ));
            }
            confirm_large_cli_open(path, metadata.len())?;
            let canonical_path = std::fs::canonicalize(path).map_err(|error| {
                format!(
                    "Unable to normalize file path '{}': {error}",
                    path.to_string_lossy()
                )
            })?;

            Ok(LaunchFileArg {
                path: canonical_path.to_string_lossy().to_string(),
                exists: true,
                file_size_bytes: Some(metadata.len()),
            })
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let parent = path.parent().ok_or_else(|| {
                format!(
                    "Cannot determine parent directory for '{}'",
                    path.to_string_lossy()
                )
            })?;

            if !parent.exists() {
                return Err(format!(
                    "Parent directory does not exist for '{}'",
                    path.to_string_lossy()
                ));
            }

            if !parent.is_dir() {
                return Err(format!(
                    "Parent path is not a directory for '{}'",
                    path.to_string_lossy()
                ));
            }

            let canonical_parent = std::fs::canonicalize(parent).map_err(|error| {
                format!(
                    "Unable to normalize parent directory for '{}': {error}",
                    path.to_string_lossy()
                )
            })?;
            let file_name = path.file_name().ok_or_else(|| {
                format!(
                    "Cannot determine file name for '{}'",
                    path.to_string_lossy()
                )
            })?;
            let normalized_path = canonical_parent.join(file_name);

            Ok(LaunchFileArg {
                path: normalized_path.to_string_lossy().to_string(),
                exists: false,
                file_size_bytes: None,
            })
        }
        Err(error) => Err(format!(
            "Unable to access '{}': {error}",
            path.to_string_lossy()
        )),
    }
}

fn resolve_launch_file_arg() -> Result<Option<LaunchFileArg>, String> {
    let raw = parse_positional_launch_args()?;
    let Some(raw_path) = raw else {
        return Ok(None);
    };

    let normalized = normalize_cli_path(&raw_path)?;
    validate_launch_file_arg(&normalized).map(Some)
}

fn to_pango_style(value: &str) -> gtk::pango::Style {
    match value {
        "italic" => gtk::pango::Style::Italic,
        "oblique" => gtk::pango::Style::Oblique,
        _ => gtk::pango::Style::Normal,
    }
}

fn to_pango_weight(value: i32) -> gtk::pango::Weight {
    match value {
        ..=149 => gtk::pango::Weight::Thin,
        150..=249 => gtk::pango::Weight::Ultralight,
        250..=324 => gtk::pango::Weight::Light,
        325..=374 => gtk::pango::Weight::Book,
        375..=474 => gtk::pango::Weight::Normal,
        475..=549 => gtk::pango::Weight::Medium,
        550..=649 => gtk::pango::Weight::Semibold,
        650..=774 => gtk::pango::Weight::Bold,
        775..=849 => gtk::pango::Weight::Ultrabold,
        _ => gtk::pango::Weight::Heavy,
    }
}

fn px_to_pango_size(px: f64) -> i32 {
    (px.max(1.0) * gtk::pango::SCALE as f64).round() as i32
}

fn pango_size_to_px(description: &gtk::pango::FontDescription) -> f64 {
    if description.size() <= 0 {
        return 14.0;
    }
    description.size() as f64 / gtk::pango::SCALE as f64
}

#[tauri::command]
fn choose_editor_font(
    app: tauri::AppHandle,
    current: Option<EditorFontInput>,
) -> Result<Option<EditorFontSelection>, String> {
    {
        use gtk::glib::translate::IntoGlib;
        use gtk::prelude::*;
        use std::sync::mpsc;

        let (tx, rx) = mpsc::channel::<Option<EditorFontSelection>>();

        app.run_on_main_thread(move || {
            if !gtk::is_initialized() {
                if let Err(_error) = gtk::init() {
                    let _ = tx.send(None);
                    return;
                }
            }

            let dialog =
                gtk::FontChooserDialog::new(Some("Choose Editor Font"), None::<&gtk::Window>);
            dialog.set_modal(true);

            if let Some(current_font) = current {
                let mut description = gtk::pango::FontDescription::new();
                description.set_family(&current_font.font_family);
                description.set_style(to_pango_style(&current_font.font_style));
                description.set_weight(to_pango_weight(current_font.font_weight));
                description.set_size(px_to_pango_size(current_font.font_size.clamp(9.0, 40.0)));
                dialog.set_font_desc(&description);
            }

            let response = dialog.run();

            let selected = if matches!(
                response,
                gtk::ResponseType::Accept | gtk::ResponseType::Ok | gtk::ResponseType::Yes
            ) {
                let description = dialog
                    .font_desc()
                    .unwrap_or_else(|| gtk::pango::FontDescription::from_string("Sans 11"));

                let family = description
                    .family()
                    .map(|value| value.to_string())
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| "Sans".to_string());

                let pixels = pango_size_to_px(&description).round();

                let style = match description.style() {
                    gtk::pango::Style::Italic => "italic",
                    gtk::pango::Style::Oblique => "oblique",
                    _ => "normal",
                };

                let selection = EditorFontSelection {
                    font_family: family,
                    font_size: pixels,
                    font_style: style.to_string(),
                    font_weight: description.weight().into_glib(),
                };

                Some(selection)
            } else {
                None
            };

            dialog.close();
            let _ = tx.send(selected);
        })
        .map_err(|error| error.to_string())?;

        rx.recv().map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn take_launch_file_arg(
    state: tauri::State<'_, LaunchArgState>,
) -> Result<Option<LaunchFileArg>, String> {
    let mut guard = state
        .pending_file
        .lock()
        .map_err(|error| format!("Unable to read launch args state: {error}"))?;

    Ok(guard.take())
}

fn split_utf8_prefix(input: &[u8]) -> Result<(String, Vec<u8>), String> {
    match std::str::from_utf8(input) {
        Ok(text) => Ok((text.to_string(), Vec::new())),
        Err(error) => {
            let valid_up_to = error.valid_up_to();
            if let Some(_error_len) = error.error_len() {
                return Err("Launch stream contains invalid UTF-8 data".to_string());
            }

            let valid = std::str::from_utf8(&input[..valid_up_to])
                .map_err(|_| "Failed to decode launch stream UTF-8 prefix".to_string())?;

            Ok((valid.to_string(), input[valid_up_to..].to_vec()))
        }
    }
}

#[tauri::command]
fn start_launch_file_stream(
    state: tauri::State<'_, LaunchArgState>,
    file_path: String,
) -> Result<LaunchFileStreamStartResult, String> {
    let approved_path = state
        .approved_launch_file_path
        .as_ref()
        .ok_or_else(|| "No launch file is available for streaming".to_string())?;

    if &file_path != approved_path {
        return Err("Requested path is not an approved launch file".to_string());
    }

    let metadata = std::fs::metadata(&file_path).map_err(|error| {
        format!(
            "Unable to read launch file metadata '{}': {error}",
            file_path
        )
    })?;
    if !metadata.is_file() {
        return Err(format!("Launch path is not a regular file: {}", file_path));
    }

    let file = File::open(&file_path)
        .map_err(|error| format!("Unable to open launch file '{}': {error}", file_path))?;

    let stream_id = {
        let mut counter = state
            .launch_stream_counter
            .lock()
            .map_err(|error| format!("Unable to allocate launch stream id: {error}"))?;
        *counter += 1;
        format!("launch-{}", *counter)
    };

    {
        let mut streams = state
            .active_launch_streams
            .lock()
            .map_err(|error| format!("Unable to store launch stream state: {error}"))?;
        streams.insert(
            stream_id.clone(),
            LaunchFileStream {
                file,
                file_path: file_path.clone(),
                file_size_bytes: metadata.len(),
                bytes_read_total: 0,
                utf8_carry: Vec::new(),
            },
        );
    }

    Ok(LaunchFileStreamStartResult {
        stream_id,
        file_path,
        file_size_bytes: metadata.len(),
    })
}

#[tauri::command]
fn read_launch_file_chunk(
    state: tauri::State<'_, LaunchArgState>,
    stream_id: String,
    max_bytes: usize,
) -> Result<LaunchFileStreamChunkResult, String> {
    let mut streams = state
        .active_launch_streams
        .lock()
        .map_err(|error| format!("Unable to read launch stream state: {error}"))?;

    let stream = streams
        .get_mut(&stream_id)
        .ok_or_else(|| format!("Launch stream '{}' not found", stream_id))?;

    let read_size = max_bytes.clamp(4 * 1024, 1024 * 1024);
    let mut buffer = vec![0_u8; read_size];
    let read_count = stream
        .file
        .read(&mut buffer)
        .map_err(|error| format!("Unable to read launch file '{}': {error}", stream.file_path))?;

    if read_count == 0 {
        if stream.utf8_carry.is_empty() {
            return Ok(LaunchFileStreamChunkResult::Eof {
                bytes_read_total: stream.bytes_read_total,
                file_size_bytes: stream.file_size_bytes,
            });
        }

        let trailing = std::str::from_utf8(&stream.utf8_carry)
            .map_err(|_| "Launch stream ended with invalid UTF-8 sequence".to_string())?
            .to_string();
        stream.utf8_carry.clear();

        return Ok(LaunchFileStreamChunkResult::Chunk {
            text: trailing,
            bytes_read_total: stream.bytes_read_total,
            file_size_bytes: stream.file_size_bytes,
        });
    }

    stream.bytes_read_total += read_count as u64;

    let mut combined = Vec::with_capacity(stream.utf8_carry.len() + read_count);
    if !stream.utf8_carry.is_empty() {
        combined.extend_from_slice(&stream.utf8_carry);
    }
    combined.extend_from_slice(&buffer[..read_count]);

    let (decoded, carry) = split_utf8_prefix(&combined)?;
    stream.utf8_carry = carry;

    Ok(LaunchFileStreamChunkResult::Chunk {
        text: decoded,
        bytes_read_total: stream.bytes_read_total,
        file_size_bytes: stream.file_size_bytes,
    })
}

#[tauri::command]
fn cancel_launch_file_stream(
    state: tauri::State<'_, LaunchArgState>,
    stream_id: String,
) -> Result<(), String> {
    let mut streams = state
        .active_launch_streams
        .lock()
        .map_err(|error| format!("Unable to cancel launch stream state: {error}"))?;
    streams.remove(&stream_id);
    Ok(())
}

#[tauri::command]
fn close_launch_file_stream(
    state: tauri::State<'_, LaunchArgState>,
    stream_id: String,
) -> Result<(), String> {
    let mut streams = state
        .active_launch_streams
        .lock()
        .map_err(|error| format!("Unable to close launch stream state: {error}"))?;
    streams.remove(&stream_id);
    Ok(())
}

/// The file a save actually writes to.
///
/// A save is published by renaming a temporary file over the target, and rename
/// replaces the *path*: a symlink would be replaced by an ordinary file, and the
/// file it pointed at left holding the old text — the edit silently detached
/// from the file that was opened. A dotfile linked into a repository is the
/// everyday case, and nothing about it would look wrong afterwards.
///
/// Resolving first puts the temporary file beside the real one, on the same
/// filesystem, and renames over that instead. It also aligns the save with the
/// version check, which has always followed links: `stat` reports the target's
/// size, device and inode, so those are the ones the rename should replace.
///
/// A path that does not resolve — a file being created, or a dangling link — is
/// used exactly as given.
fn resolve_save_target(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn build_save_temp_path(target_path: &Path, stream_id: &str) -> Result<PathBuf, String> {
    let parent = target_path.parent().ok_or_else(|| {
        format!(
            "Cannot determine parent directory for '{}'",
            target_path.to_string_lossy()
        )
    })?;

    if !parent.exists() {
        return Err(format!(
            "Parent directory does not exist for '{}'",
            target_path.to_string_lossy()
        ));
    }

    if !parent.is_dir() {
        return Err(format!(
            "Parent path is not a directory for '{}'",
            target_path.to_string_lossy()
        ));
    }

    let file_name = target_path.file_name().ok_or_else(|| {
        format!(
            "Cannot determine file name for '{}'",
            target_path.to_string_lossy()
        )
    })?;

    // Include the process id and a timestamp so the name can't collide with a
    // temp file left behind by a crashed earlier session (stream ids restart
    // at 1 on every launch, and creation uses create_new).
    let unique_suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let temp_name = format!(
        ".{}.wisty-save-{}-{}-{}.tmp",
        file_name.to_string_lossy(),
        std::process::id(),
        stream_id,
        unique_suffix
    );
    Ok(parent.join(temp_name))
}

fn modified_ms(metadata: &Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis()
        .try_into()
        .ok()
}

const CHANGED_MESSAGE: &str =
    "The file changed on disk after it was opened. Reload it, save a copy, or explicitly overwrite it.";
const DELETED_MESSAGE: &str =
    "The file was deleted on disk after it was opened. Save a copy, or recreate it.";
const APPEARED_MESSAGE: &str =
    "Another file has appeared at this path since Wisty last looked. Save a copy, or explicitly overwrite it.";
const NOT_A_FILE_MESSAGE: &str =
    "This path is no longer a file, so it cannot be saved over. Save a copy somewhere else.";

/// Refuses to publish a stream save whose target no longer matches what the
/// document asserts about it.
///
/// The check happens immediately before rename; an external writer can still
/// race that final syscall, because portable rename is not conditional. Each
/// refusal carries the code the banner needs, so a caller never has to read a
/// message to tell a change from a deletion.
fn ensure_expected_source(path: &Path, expected: &ExpectedSource) -> Result<(), SaveStreamError> {
    let version = match expected {
        ExpectedSource::Absent => {
            return match std::fs::metadata(path) {
                // A directory cannot be renamed over at all, so saying "another
                // file appeared" would be both wrong and unhelpful advice.
                Ok(metadata) if !metadata.is_file() => Err(SaveStreamError::conflict(
                    SAVE_EXTERNAL_NOT_A_FILE,
                    NOT_A_FILE_MESSAGE,
                )),
                Ok(_) => Err(SaveStreamError::conflict(
                    SAVE_EXTERNAL_APPEARED,
                    APPEARED_MESSAGE,
                )),
                Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
                Err(error) => Err(SaveStreamError::failed(format!(
                    "Unable to check '{}' on disk before saving: {error}",
                    path.display()
                ))),
            };
        }
        ExpectedSource::Present { version } => version,
    };

    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        // A missing target is a deletion, not a fault, and not a change: it is
        // its own conflict, and "Reload from Disk" is not among its answers.
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(SaveStreamError::conflict(
                SAVE_EXTERNAL_DELETE,
                DELETED_MESSAGE,
            ));
        }
        Err(error) => {
            return Err(SaveStreamError::failed(format!(
                "Unable to check '{}' on disk before saving: {error}",
                path.display()
            )));
        }
    };

    if !metadata.is_file() {
        return Err(SaveStreamError::conflict(
            SAVE_EXTERNAL_NOT_A_FILE,
            NOT_A_FILE_MESSAGE,
        ));
    }

    let changed = metadata.len() != version.size
        || version
            .modified_ms
            .is_some_and(|modified| modified_ms(&metadata) != Some(modified))
        || version
            .device
            .is_some_and(|device| device != metadata.dev())
        || version.inode.is_some_and(|inode| inode != metadata.ino());
    if changed {
        return Err(SaveStreamError::conflict(
            SAVE_EXTERNAL_CHANGE,
            CHANGED_MESSAGE,
        ));
    }
    Ok(())
}

#[tauri::command]
fn start_save_file_stream(
    state: tauri::State<'_, LaunchArgState>,
    file_path: String,
    expected_source: Option<ExpectedSource>,
) -> Result<SaveFileStreamStartResult, String> {
    start_save_stream(&state, file_path, expected_source)
}

/// The body of the command, over the state rather than Tauri's handle to it, so
/// the save protocol can be exercised against real files in tests.
fn start_save_stream(
    state: &LaunchArgState,
    file_path: String,
    expected_source: Option<ExpectedSource>,
) -> Result<SaveFileStreamStartResult, String> {
    if file_path.trim().is_empty() {
        return Err("Save path cannot be empty".to_string());
    }

    // The document keeps the path it was opened with; only the write follows
    // it to the file it names.
    let target_path = resolve_save_target(&PathBuf::from(&file_path));

    let stream_id = {
        let mut counter = state
            .save_stream_counter
            .lock()
            .map_err(|error| format!("Unable to allocate save stream id: {error}"))?;
        *counter += 1;
        format!("save-{}", *counter)
    };

    let temp_path = build_save_temp_path(&target_path, &stream_id)?;
    let existing_mode = match std::fs::metadata(&target_path) {
        Ok(metadata) => Some(metadata.permissions().mode()),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "Unable to read permissions for '{}': {error}",
                target_path.to_string_lossy()
            ));
        }
    };

    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(|error| {
            format!(
                "Unable to create temporary save file '{}': {error}",
                temp_path.to_string_lossy()
            )
        })?;

    if let Some(mode) = existing_mode {
        if let Err(error) =
            std::fs::set_permissions(&temp_path, std::fs::Permissions::from_mode(mode))
        {
            let _ = std::fs::remove_file(&temp_path);
            return Err(format!(
                "Unable to copy permissions to temporary save file '{}': {error}",
                temp_path.to_string_lossy()
            ));
        }
    }

    let stream = SaveFileStream {
        target_path,
        temp_path,
        writer: BufWriter::new(file),
        bytes_written_total: 0,
        expected_source,
    };

    {
        let mut streams = state
            .active_save_streams
            .lock()
            .map_err(|error| format!("Unable to store save stream state: {error}"))?;
        streams.insert(stream_id.clone(), stream);
    }

    Ok(SaveFileStreamStartResult {
        stream_id,
        file_path,
    })
}

#[tauri::command]
fn write_save_file_chunk(
    state: tauri::State<'_, LaunchArgState>,
    stream_id: String,
    text_chunk: String,
) -> Result<SaveFileStreamWriteResult, String> {
    write_save_chunk(&state, stream_id, text_chunk)
}

fn write_save_chunk(
    state: &LaunchArgState,
    stream_id: String,
    text_chunk: String,
) -> Result<SaveFileStreamWriteResult, String> {
    let mut streams = state
        .active_save_streams
        .lock()
        .map_err(|error| format!("Unable to read save stream state: {error}"))?;

    let stream = streams
        .get_mut(&stream_id)
        .ok_or_else(|| format!("Save stream '{}' not found", stream_id))?;

    let bytes = text_chunk.as_bytes();
    stream.writer.write_all(bytes).map_err(|error| {
        format!(
            "Unable to write save chunk for '{}': {error}",
            stream.target_path.to_string_lossy()
        )
    })?;

    stream.bytes_written_total += bytes.len() as u64;

    Ok(SaveFileStreamWriteResult {
        bytes_written_total: stream.bytes_written_total,
    })
}

#[tauri::command]
fn finish_save_file_stream(
    state: tauri::State<'_, LaunchArgState>,
    stream_id: String,
) -> Result<SaveFileStreamFinishResult, SaveStreamError> {
    finish_save_stream(&state, stream_id)
}

fn finish_save_stream(
    state: &LaunchArgState,
    stream_id: String,
) -> Result<SaveFileStreamFinishResult, SaveStreamError> {
    let mut stream = {
        let mut streams = state
            .active_save_streams
            .lock()
            .map_err(|error| format!("Unable to finalize save stream state: {error}"))?;
        streams
            .remove(&stream_id)
            .ok_or_else(|| format!("Save stream '{}' not found", stream_id))?
    };

    if let Err(error) = stream.writer.flush() {
        let _ = std::fs::remove_file(&stream.temp_path);
        return Err(SaveStreamError::failed(format!(
            "Unable to flush save stream for '{}': {error}",
            stream.target_path.to_string_lossy()
        )));
    }

    // Sync before the rename so a crash or power loss right after saving
    // cannot leave the target pointing at unwritten data.
    if let Err(error) = stream.writer.get_ref().sync_all() {
        let _ = std::fs::remove_file(&stream.temp_path);
        return Err(SaveStreamError::failed(format!(
            "Unable to sync save stream for '{}': {error}",
            stream.target_path.to_string_lossy()
        )));
    }

    drop(stream.writer);

    if let Some(expected) = &stream.expected_source {
        if let Err(error) = ensure_expected_source(&stream.target_path, expected) {
            let _ = std::fs::remove_file(&stream.temp_path);
            return Err(error);
        }
    }

    if let Err(error) = std::fs::rename(&stream.temp_path, &stream.target_path) {
        let _ = std::fs::remove_file(&stream.temp_path);
        return Err(SaveStreamError::failed(format!(
            "Unable to finalize save for '{}': {error}",
            stream.target_path.to_string_lossy()
        )));
    }

    Ok(SaveFileStreamFinishResult {
        bytes_written_total: stream.bytes_written_total,
    })
}

#[tauri::command]
fn cancel_save_file_stream(
    state: tauri::State<'_, LaunchArgState>,
    stream_id: String,
) -> Result<(), String> {
    cancel_save_stream(&state, stream_id)
}

fn cancel_save_stream(state: &LaunchArgState, stream_id: String) -> Result<(), String> {
    let maybe_stream = {
        let mut streams = state
            .active_save_streams
            .lock()
            .map_err(|error| format!("Unable to cancel save stream state: {error}"))?;
        streams.remove(&stream_id)
    };

    if let Some(stream) = maybe_stream {
        drop(stream.writer);
        match std::fs::remove_file(&stream.temp_path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Unable to remove temporary save file '{}': {error}",
                    stream.temp_path.to_string_lossy()
                ))
            }
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Whether to point the web process at a dead accessibility bus, and why not to.
///
/// WebKitGTK 2.52.3 aborts its web process while emitting an AT-SPI
/// selection-changed event: the caret's UTF-16 offset is converted to a UTF-8
/// offset over the editable's accessible text and runs off the end of the
/// buffer (`UTF16OffsetToUTF8`, AccessibilityObjectTextAtspi.cpp:257). It takes
/// a replaced element inside the editable, a non-ASCII character after it, and
/// the caret at the end of the text — which is an ordinary transcript line, as
/// CodeMirror emits `<img class="cm-widgetBuffer">` around every replace
/// decoration and the markers themselves are separated by an en dash. See
/// dev_notes/webkit-replace-freeze-progress.md.
///
/// An invalid bus address is what stops it: the web process cannot reach the
/// bus, so it never emits the event. `NO_AT_BRIDGE=1` does not help.
///
/// The cost is real — this makes Wisty inaccessible to screen readers — so
/// `WISTY_ENABLE_A11Y` turns it off for anyone who needs the accessibility tree
/// more than they need the editor not to crash. Drop the whole thing once a
/// fixed WebKitGTK is widely shipped.
fn atspi_bus_override(a11y_requested: bool) -> Option<&'static str> {
    if a11y_requested {
        None
    } else {
        Some("disabled:")
    }
}

/// Must run before GTK is initialised, since the web process inherits it.
fn disable_atspi_bridge() {
    if let Some(address) = atspi_bus_override(std::env::var_os("WISTY_ENABLE_A11Y").is_some()) {
        std::env::set_var("AT_SPI_BUS_ADDRESS", address);
    }
}

pub fn run() {
    disable_atspi_bridge();

    let launch_file = match resolve_launch_file_arg() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("wisty: {error}");
            std::process::exit(1);
        }
    };

    let is_debug_build = cfg!(debug_assertions);
    let log_plugin = tauri_plugin_log::Builder::new()
        .level(if is_debug_build {
            LevelFilter::Info
        } else {
            LevelFilter::Warn
        })
        .level_for("arboard", LevelFilter::Warn)
        .level_for("arboard::platform::linux::x11", LevelFilter::Warn)
        .filter(move |metadata| {
            if is_debug_build {
                return true;
            }
            metadata.target().starts_with("wisty::")
        })
        .build();

    tauri::Builder::default()
        .manage(LaunchArgState::new(launch_file))
        .manage(spellcheck::SpellState::default())
        .manage(tsf::TsfState::default())
        .manage(tsf::ConversionState::default())
        .manage(playback::PlaybackState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(log_plugin)
        .invoke_handler(tauri::generate_handler![
            choose_editor_font,
            take_launch_file_arg,
            start_launch_file_stream,
            read_launch_file_chunk,
            cancel_launch_file_stream,
            close_launch_file_stream,
            start_save_file_stream,
            write_save_file_chunk,
            finish_save_file_stream,
            cancel_save_file_stream,
            window_title::set_window_title,
            spellcheck::spell_list_dictionaries,
            spellcheck::spell_load_dictionary,
            spellcheck::spell_check_words,
            spellcheck::spell_suggest,
            spellcheck::spell_add_word,
            spellcheck::spell_ignore_word,
            spellcheck::spell_list_added_words,
            spellcheck::spell_remove_word,
            tsf::create_tsf,
            tsf::probe_audio_file,
            tsf::take_conversion_output,
            tsf::cancel_audio_conversion,
            tsf::open_tsf,
            tsf::save_tsf,
            tsf::close_tsf,
            playback::play_span,
            playback::stop_playback,
            playback::release_playback
        ])
        // A conversion is a child process, and a child process outlives the
        // parent that spawned it. Quitting mid-import would otherwise leave
        // ffmpeg encoding into a temporary file that nothing will collect and
        // nothing will ever read.
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                window
                    .app_handle()
                    .state::<tsf::ConversionState>()
                    .request_cancel();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
mod playback;
mod spellcheck;
mod tsf;
mod window_title;

#[cfg(test)]
mod tests {
    use super::{
        atspi_bus_override, cancel_save_stream, ensure_expected_source, finish_save_stream,
        modified_ms, start_save_stream, write_save_chunk, ExpectedSource, LaunchArgState,
        TextFileVersion, SAVE_EXTERNAL_APPEARED, SAVE_EXTERNAL_CHANGE, SAVE_EXTERNAL_DELETE,
        SAVE_EXTERNAL_NOT_A_FILE,
    };
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::path::Path;

    fn expect_present(path: &std::path::Path) -> ExpectedSource {
        let metadata = std::fs::metadata(path).unwrap();
        ExpectedSource::Present {
            version: TextFileVersion {
                size: metadata.len(),
                modified_ms: modified_ms(&metadata),
                device: Some(metadata.dev()),
                inode: Some(metadata.ino()),
            },
        }
    }

    /// A directory of this test's own, so tests cannot collide over one path.
    fn test_directory(name: &str) -> std::path::PathBuf {
        let directory =
            std::env::temp_dir().join(format!("wisty-save-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn disables_the_bus_by_default() {
        assert_eq!(atspi_bus_override(false), Some("disabled:"));
    }

    #[test]
    fn leaves_the_bus_alone_when_accessibility_is_asked_for() {
        assert_eq!(atspi_bus_override(true), None);
    }

    #[test]
    fn save_refuses_a_replaced_text_file() {
        let directory = test_directory("replaced");
        let path = directory.join("notes.txt");
        std::fs::write(&path, "before").unwrap();
        let expected = expect_present(&path);

        let replacement = directory.join("replacement.txt");
        std::fs::write(&replacement, "after!").unwrap();
        std::fs::rename(&replacement, &path).unwrap();

        let error = ensure_expected_source(&path, &expected).unwrap_err();
        assert_eq!(error.code, SAVE_EXTERNAL_CHANGE);
    }

    /// A deletion is not a change: the banner it raises offers no reload.
    #[test]
    fn save_reports_a_deleted_text_file_as_a_deletion() {
        let directory = test_directory("deleted");
        let path = directory.join("notes.txt");
        std::fs::write(&path, "before").unwrap();
        let expected = expect_present(&path);
        std::fs::remove_file(&path).unwrap();

        let error = ensure_expected_source(&path, &expected).unwrap_err();
        assert_eq!(error.code, SAVE_EXTERNAL_DELETE);
    }

    #[test]
    fn save_allows_a_new_file_where_none_is_expected() {
        let directory = test_directory("absent");
        let path = directory.join("notes.txt");

        assert!(ensure_expected_source(&path, &ExpectedSource::Absent).is_ok());
    }

    /// Creating a document at an empty path must not silently overwrite a file
    /// that something else has put there in the meantime.
    #[test]
    fn save_refuses_a_file_that_appeared_where_none_was_expected() {
        let directory = test_directory("appeared");
        let path = directory.join("notes.txt");
        std::fs::write(&path, "not yours").unwrap();

        let error = ensure_expected_source(&path, &ExpectedSource::Absent).unwrap_err();
        assert_eq!(error.code, SAVE_EXTERNAL_APPEARED);
    }

    /// Drives the whole save protocol the frontend drives, against a real file.
    ///
    /// Everything below this point tests the save as it actually runs: real
    /// temporary files, a real rename, a real `stat` for the assertion. The
    /// interleavings are exact rather than timed — the test writes to the file
    /// between the steps of the save, which is precisely the window an external
    /// writer gets.
    fn save(
        state: &LaunchArgState,
        path: &Path,
        text: &str,
        expected: Option<ExpectedSource>,
    ) -> Result<(), &'static str> {
        let started = start_save_stream(state, path.to_string_lossy().to_string(), expected)
            .expect("save stream should start");
        write_save_chunk(state, started.stream_id.clone(), text.to_string())
            .expect("chunk should be written");
        finish_save_stream(state, started.stream_id)
            .map(|_| ())
            .map_err(|error| error.code)
    }

    fn state() -> LaunchArgState {
        LaunchArgState::new(None)
    }

    /// Nothing of the save may be left behind, whether it landed or not.
    fn only_file_in(directory: &Path) -> Option<std::path::PathBuf> {
        let mut entries: Vec<_> = std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert!(
            entries.len() <= 1,
            "save left extra files behind: {entries:?}"
        );
        entries.pop()
    }

    #[test]
    fn a_save_over_an_unchanged_file_lands() {
        // The ordinary case, and the one that runs on every Ctrl+S: the
        // assertion has to *pass* against a file nothing else has touched.
        let directory = test_directory("unchanged");
        let path = directory.join("notes.txt");
        std::fs::write(&path, "before").unwrap();
        let expected = expect_present(&path);

        save(&state(), &path, "after", Some(expected)).expect("save should land");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after");
        assert_eq!(only_file_in(&directory), Some(path));
    }

    #[test]
    fn a_save_refuses_a_file_rewritten_while_it_was_writing() {
        let directory = test_directory("rewritten-midsave");
        let path = directory.join("notes.txt");
        std::fs::write(&path, "before").unwrap();
        let expected = expect_present(&path);
        let state = state();

        let started =
            start_save_stream(&state, path.to_string_lossy().to_string(), Some(expected)).unwrap();
        write_save_chunk(&state, started.stream_id.clone(), "after".to_string()).unwrap();
        // The writer lands between the last chunk and the rename.
        std::fs::write(&path, "theirs, not ours").unwrap();

        let error = finish_save_stream(&state, started.stream_id).unwrap_err();

        assert_eq!(error.code, SAVE_EXTERNAL_CHANGE);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "theirs, not ours");
        assert_eq!(only_file_in(&directory), Some(path));
    }

    #[test]
    fn a_save_reports_a_file_deleted_while_it_was_writing() {
        let directory = test_directory("deleted-midsave");
        let path = directory.join("notes.txt");
        std::fs::write(&path, "before").unwrap();
        let expected = expect_present(&path);
        let state = state();

        let started =
            start_save_stream(&state, path.to_string_lossy().to_string(), Some(expected)).unwrap();
        write_save_chunk(&state, started.stream_id.clone(), "after".to_string()).unwrap();
        std::fs::remove_file(&path).unwrap();

        let error = finish_save_stream(&state, started.stream_id).unwrap_err();

        assert_eq!(error.code, SAVE_EXTERNAL_DELETE);
        // Refused, so the file stays deleted rather than quietly reappearing.
        assert!(!path.exists());
        assert_eq!(only_file_in(&directory), None);
    }

    #[test]
    fn a_save_creating_a_file_lands_when_the_path_is_still_empty() {
        let directory = test_directory("creating");
        let path = directory.join("new.txt");

        save(&state(), &path, "fresh", Some(ExpectedSource::Absent)).expect("save should land");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "fresh");
        assert_eq!(only_file_in(&directory), Some(path));
    }

    #[test]
    fn a_save_creating_a_file_refuses_one_that_appeared_under_it() {
        let directory = test_directory("appeared-midsave");
        let path = directory.join("new.txt");
        let state = state();

        let started = start_save_stream(
            &state,
            path.to_string_lossy().to_string(),
            Some(ExpectedSource::Absent),
        )
        .unwrap();
        write_save_chunk(&state, started.stream_id.clone(), "ours".to_string()).unwrap();
        std::fs::write(&path, "someone else's").unwrap();

        let error = finish_save_stream(&state, started.stream_id).unwrap_err();

        assert_eq!(error.code, SAVE_EXTERNAL_APPEARED);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "someone else's");
        assert_eq!(only_file_in(&directory), Some(path));
    }

    #[test]
    fn a_cancelled_save_leaves_the_file_and_the_directory_alone() {
        let directory = test_directory("cancelled");
        let path = directory.join("notes.txt");
        std::fs::write(&path, "before").unwrap();
        let state = state();

        let started = start_save_stream(&state, path.to_string_lossy().to_string(), None).unwrap();
        write_save_chunk(&state, started.stream_id.clone(), "abandoned".to_string()).unwrap();
        cancel_save_stream(&state, started.stream_id).unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "before");
        assert_eq!(only_file_in(&directory), Some(path));
    }

    /// The rename replaces the file, so the mode has to be carried across or
    /// every save would reset it to the process umask.
    #[test]
    fn a_save_keeps_the_file_mode_it_replaced() {
        let directory = test_directory("mode");
        let path = directory.join("notes.txt");
        std::fs::write(&path, "before").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        let expected = expect_present(&path);

        save(&state(), &path, "after", Some(expected)).expect("save should land");

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }

    /// Characterises what mtime can and cannot separate, rather than Wisty.
    ///
    /// A version carries mtime in whole milliseconds, because that is what a
    /// JavaScript `Date` holds and the baseline is taken on that side. ext4
    /// timestamps in nanoseconds, so the resolution Wisty actually gets is the
    /// millisecond, and this is where that lands.
    #[test]
    fn a_same_size_rewrite_a_millisecond_later_is_visible() {
        let directory = test_directory("mtime-resolution");
        let path = directory.join("notes.txt");
        std::fs::write(&path, "aaaa").unwrap();
        let before = modified_ms(&std::fs::metadata(&path).unwrap());

        std::thread::sleep(std::time::Duration::from_millis(2));
        std::fs::write(&path, "bbbb").unwrap();
        let after = modified_ms(&std::fs::metadata(&path).unwrap());

        assert_ne!(
            before, after,
            "mtime cannot separate writes a millisecond apart"
        );
    }

    /// The documented blind spot, demonstrated rather than assumed.
    ///
    /// Detection is exactly as fine as the millisecond it records: two writes
    /// that leave the size and the inode alone are one version if they share a
    /// millisecond, and two if they do not. In practice the baseline is taken
    /// when a file is opened and the external write comes later, so the window
    /// is a millisecond wide — a script rewriting a file the instant Wisty
    /// reads it is what falls into it. Closing it would mean carrying the
    /// nanoseconds `stat` already returns, which a JavaScript `Date` cannot
    /// hold, so the baseline would have to move to the Rust side.
    #[test]
    fn a_same_size_rewrite_is_seen_only_if_the_millisecond_moved() {
        let directory = test_directory("mtime-blind-spot");
        let path = directory.join("notes.txt");
        std::fs::write(&path, "aaaa").unwrap();
        let expected = expect_present(&path);
        let before = modified_ms(&std::fs::metadata(&path).unwrap());

        std::fs::write(&path, "bbbb").unwrap();
        let after = modified_ms(&std::fs::metadata(&path).unwrap());

        let detected = ensure_expected_source(&path, &expected).is_err();
        assert_eq!(
            detected,
            before != after,
            "a same-size rewrite is detectable exactly when its millisecond differs"
        );
    }

    /// A symlinked file — a dotfile linked into a repository, most often — is
    /// the file that must change, not the link.
    #[test]
    fn a_save_through_a_symlink_writes_the_file_it_points_at() {
        let directory = test_directory("symlink");
        let real = directory.join("real.txt");
        std::fs::write(&real, "before").unwrap();
        let link = directory.join("link.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let expected = expect_present(&link);

        save(&state(), &link, "after", Some(expected)).expect("save should land");

        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "the link was replaced by an ordinary file"
        );
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "after");
    }

    /// The version check has always followed the link, and now the write does
    /// too: an edit to the file behind it is the conflict it looks like.
    #[test]
    fn a_save_through_a_symlink_still_sees_an_edit_to_the_file_behind_it() {
        let directory = test_directory("symlink-conflict");
        let real = directory.join("real.txt");
        std::fs::write(&real, "before").unwrap();
        let link = directory.join("link.txt");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let expected = expect_present(&link);
        std::thread::sleep(std::time::Duration::from_millis(2));
        std::fs::write(&real, "theirs").unwrap();

        let code = save(&state(), &link, "ours", Some(expected)).unwrap_err();

        assert_eq!(code, SAVE_EXTERNAL_CHANGE);
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "theirs");
    }

    /// Nothing to resolve, so the path is taken as given and a file appears
    /// where the link was.
    #[test]
    fn a_save_to_a_dangling_symlink_creates_a_file_at_the_link() {
        let directory = test_directory("symlink-dangling");
        let link = directory.join("link.txt");
        std::os::unix::fs::symlink(directory.join("gone.txt"), &link).unwrap();

        save(&state(), &link, "fresh", None).expect("save should land");

        assert_eq!(std::fs::read_to_string(&link).unwrap(), "fresh");
    }

    /// A directory cannot be renamed over, so "the file changed" would be both
    /// the wrong description and the wrong advice.
    #[test]
    fn save_reports_a_target_that_is_no_longer_a_file() {
        let directory = test_directory("not-a-file");
        let path = directory.join("notes.txt");
        std::fs::write(&path, "before").unwrap();
        let expected = expect_present(&path);
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();

        let error = ensure_expected_source(&path, &expected).unwrap_err();

        assert_eq!(error.code, SAVE_EXTERNAL_NOT_A_FILE);
    }

    #[test]
    fn save_reports_a_directory_where_a_new_file_was_going() {
        let directory = test_directory("not-a-file-absent");
        let path = directory.join("new.txt");
        std::fs::create_dir(&path).unwrap();

        let error = ensure_expected_source(&path, &ExpectedSource::Absent).unwrap_err();

        assert_eq!(error.code, SAVE_EXTERNAL_NOT_A_FILE);
    }
}
