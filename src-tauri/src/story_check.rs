//! Runs the game's own Generica script checker for the editor.
//!
//! The checker is `godot --headless --path <game> -- --story-check <folder>`.
//! Given a folder it reads every `.tale` file in it and prints
//! `<folder>/<file>:<line>: <fault>` lines, leaving the game's own files alone.
//! To check what is on screen rather than what was last saved, the story
//! folder's `.tale` files are copied into a scratch folder with the open
//! file's text swapped in, and the checker is pointed there.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static RUNS: AtomicU64 = AtomicU64::new(0);
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Serialize, Debug, PartialEq)]
pub struct StoryFault {
    /// Path relative to the story folder, with `/` separators.
    file: String,
    line: u32,
    text: String,
}

/// Where the Godot program is: `WISTY_GODOT`, then the search path, then the
/// usual places (a program started from a menu may not have `~/.local/bin`).
fn find_godot() -> Option<PathBuf> {
    if let Some(own) = std::env::var_os("WISTY_GODOT") {
        return Some(PathBuf::from(own));
    }
    let mut spots: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        spots.extend(std::env::split_paths(&path).map(|d| d.join("godot")));
    }
    if let Some(home) = std::env::var_os("HOME") {
        spots.push(Path::new(&home).join(".local/bin/godot"));
    }
    spots.push(PathBuf::from("/usr/local/bin/godot"));
    spots.push(PathBuf::from("/usr/bin/godot"));
    spots.into_iter().find(|p| p.is_file())
}

fn copy_tales(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name();
        if path.is_dir() {
            copy_tales(&path, &to.join(name))?;
        } else if path.extension().is_some_and(|x| x == "tale") {
            fs::copy(&path, to.join(name)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Reads the checker's output: lines `<scratch>/<file>:<line>: <fault>`.
fn parse_faults(output: &str, scratch: &str) -> Vec<StoryFault> {
    let prefix = format!("{}/", scratch.trim_end_matches('/'));
    let mut faults = Vec::new();
    for raw in output.lines() {
        let Some(rest) = raw.strip_prefix(&prefix) else {
            continue;
        };
        let mut parts = rest.splitn(3, ':');
        let (Some(file), Some(line), Some(text)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let Ok(line) = line.trim().parse::<u32>() else {
            continue;
        };
        faults.push(StoryFault {
            file: file.to_string(),
            line,
            text: text.trim().to_string(),
        });
    }
    faults
}

fn run_check(
    game_dir: &str,
    story_dir: &str,
    file: &str,
    text: &str,
) -> Result<Vec<StoryFault>, String> {
    let godot = find_godot().ok_or("Godot was not found (set WISTY_GODOT to its path)")?;
    let story = Path::new(story_dir);
    let relative = Path::new(file)
        .strip_prefix(story)
        .map_err(|_| "the file is not inside the story folder".to_string())?
        .to_path_buf();

    let scratch = std::env::temp_dir().join(format!(
        "wisty-story-check-{}-{}",
        std::process::id(),
        RUNS.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&scratch);
    copy_tales(story, &scratch)?;
    let target = scratch.join(&relative);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&target, text).map_err(|e| e.to_string())?;

    let result = run_godot(&godot, game_dir, &scratch);
    let _ = fs::remove_dir_all(&scratch);
    let output = result?;
    Ok(parse_faults(&output, &scratch.to_string_lossy()))
}

fn run_godot(godot: &Path, game_dir: &str, scratch: &Path) -> Result<String, String> {
    let out_file = scratch.with_extension("out");
    let out = fs::File::create(&out_file).map_err(|e| e.to_string())?;
    let mut child = Command::new(godot)
        .args(["--headless", "--path", game_dir, "--", "--story-check"])
        .arg(scratch)
        .stdout(out)
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start Godot: {e}"))?;
    let started = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if started.elapsed() > CHECK_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = fs::remove_file(&out_file);
                return Err("the checker took too long".to_string());
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    let text = fs::read_to_string(&out_file).unwrap_or_default();
    let _ = fs::remove_file(&out_file);
    // 0: no faults, 1: faults. Anything else means the checker itself broke.
    match status.code() {
        Some(0) | Some(1) => Ok(text),
        other => Err(format!("the checker stopped unexpectedly ({other:?})")),
    }
}

/// Checks the script with `text` standing in for the open file's saved text.
#[tauri::command]
pub async fn run_story_check(
    game_dir: String,
    story_dir: String,
    file: String,
    text: String,
) -> Result<Vec<StoryFault>, String> {
    tauri::async_runtime::spawn_blocking(move || run_check(&game_dir, &story_dir, &file, &text))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_fault_lines_and_ignores_the_rest() {
        let out = "Godot Engine v4\n/tmp/x/tasks.tale:4: task has no done when line\n/tmp/x/conversations/001.tale:12: nothing leads to section a\nstory: 2 faults\n";
        let faults = parse_faults(out, "/tmp/x");
        assert_eq!(faults.len(), 2);
        assert_eq!(faults[0].file, "tasks.tale");
        assert_eq!(faults[0].line, 4);
        assert_eq!(faults[1].file, "conversations/001.tale");
        assert_eq!(faults[1].text, "nothing leads to section a");
    }
}
