use log::LevelFilter;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::BufWriter;
use std::io::ErrorKind;
use std::io::{IsTerminal, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
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

#[derive(Serialize)]
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
        let decoded = percent_decode(uri_path)?;
        #[cfg(windows)]
        {
            let normalized = decoded.strip_prefix('/').unwrap_or(&decoded);
            PathBuf::from(normalized)
        }
        #[cfg(not(windows))]
        {
            PathBuf::from(decoded)
        }
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
    #[cfg(target_os = "linux")]
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

    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Ok(None)
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

#[tauri::command]
fn start_save_file_stream(
    state: tauri::State<'_, LaunchArgState>,
    file_path: String,
) -> Result<SaveFileStreamStartResult, String> {
    if file_path.trim().is_empty() {
        return Err("Save path cannot be empty".to_string());
    }

    let target_path = PathBuf::from(&file_path);

    let stream_id = {
        let mut counter = state
            .save_stream_counter
            .lock()
            .map_err(|error| format!("Unable to allocate save stream id: {error}"))?;
        *counter += 1;
        format!("save-{}", *counter)
    };

    let temp_path = build_save_temp_path(&target_path, &stream_id)?;
    #[cfg(unix)]
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

    #[cfg(unix)]
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
) -> Result<SaveFileStreamFinishResult, String> {
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
        return Err(format!(
            "Unable to flush save stream for '{}': {error}",
            stream.target_path.to_string_lossy()
        ));
    }

    // Sync before the rename so a crash or power loss right after saving
    // cannot leave the target pointing at unwritten data.
    if let Err(error) = stream.writer.get_ref().sync_all() {
        let _ = std::fs::remove_file(&stream.temp_path);
        return Err(format!(
            "Unable to sync save stream for '{}': {error}",
            stream.target_path.to_string_lossy()
        ));
    }

    drop(stream.writer);

    if let Err(error) = std::fs::rename(&stream.temp_path, &stream.target_path) {
        let _ = std::fs::remove_file(&stream.temp_path);
        return Err(format!(
            "Unable to finalize save for '{}': {error}",
            stream.target_path.to_string_lossy()
        ));
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
pub fn run() {
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
            tsf::open_tsf,
            tsf::close_tsf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
mod spellcheck;
mod tsf;
mod window_title;
