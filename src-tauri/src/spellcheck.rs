use hunspell_rs::{CheckResult, Hunspell};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

/// System locations searched for hunspell dictionaries, in priority order.
/// These are the same files LibreOffice reads.
const DICTIONARY_DIRS: &[&str] = &[
    "/usr/share/hunspell",
    "/usr/share/myspell/dicts",
    "/usr/share/myspell",
];

const PERSONAL_DICTIONARY_FILE: &str = "personal_dictionary.txt";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryInfo {
    code: String,
    label: String,
}

struct LoadedDictionary {
    hunspell: Hunspell,
}

// SAFETY: the underlying libhunspell handle is only ever touched while the
// enclosing `Mutex` in `SpellState` is held, so access is serialized and never
// concurrent. libhunspell has no internal synchronization, which is why it is
// not auto-`Send`; serializing every call upholds its requirements.
unsafe impl Send for LoadedDictionary {}

#[derive(Default)]
struct PersonalDictionary {
    path: Option<PathBuf>,
    words: Vec<String>,
}

#[derive(Default)]
pub struct SpellState {
    dictionary: Mutex<Option<LoadedDictionary>>,
    personal: Mutex<PersonalDictionary>,
    /// Words ignored for this session only. Kept separately from `personal`
    /// (which is persisted) so reloading the dictionary can still restore
    /// them; a fresh `Hunspell` instance otherwise has no memory of them.
    ignored: Mutex<Vec<String>>,
}

/// Maps a dictionary code (e.g. `en_US`) to a human-readable label.
fn label_for_code(code: &str) -> String {
    let (lang, region) = match code.split_once(['_', '-']) {
        Some((lang, region)) => (lang, Some(region)),
        None => (code, None),
    };

    let lang_lower = lang.to_ascii_lowercase();
    let language = match lang_lower.as_str() {
        "en" => "English",
        "de" => "German",
        "fr" => "French",
        "es" => "Spanish",
        "it" => "Italian",
        "pt" => "Portuguese",
        "nl" => "Dutch",
        "pl" => "Polish",
        "ru" => "Russian",
        "sv" => "Swedish",
        "da" => "Danish",
        "nb" | "nn" | "no" => "Norwegian",
        "cs" => "Czech",
        "el" => "Greek",
        "uk" => "Ukrainian",
        other => other,
    };

    match region {
        Some(region) => format!("{language} ({})", region.to_ascii_uppercase()),
        None => language.to_string(),
    }
}

/// Scans the system dictionary directories for `.dic`/`.aff` pairs.
fn discover_dictionaries() -> Vec<DictionaryInfo> {
    let mut seen_codes: Vec<String> = Vec::new();
    let mut dictionaries: Vec<DictionaryInfo> = Vec::new();

    for dir in DICTIONARY_DIRS {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("dic") {
                continue;
            }
            let code = match path.file_stem().and_then(|stem| stem.to_str()) {
                Some(stem) => stem.to_string(),
                None => continue,
            };
            if !path.with_extension("aff").exists() || seen_codes.contains(&code) {
                continue;
            }
            seen_codes.push(code.clone());
            dictionaries.push(DictionaryInfo {
                label: label_for_code(&code),
                code,
            });
        }
    }

    dictionaries.sort_by(|a, b| a.label.cmp(&b.label));
    dictionaries
}

/// Resolves the `.aff`/`.dic` path pair for a dictionary code.
fn resolve_dictionary_paths(code: &str) -> Option<(PathBuf, PathBuf)> {
    for dir in DICTIONARY_DIRS {
        let base = Path::new(dir).join(code);
        let aff = base.with_extension("aff");
        let dic = base.with_extension("dic");
        if aff.exists() && dic.exists() {
            return Some((aff, dic));
        }
    }
    None
}

fn personal_dictionary_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Unable to resolve config directory: {error}"))?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Unable to create config directory: {error}"))?;
    Ok(dir.join(PERSONAL_DICTIONARY_FILE))
}

fn read_personal_words(path: &Path) -> Vec<String> {
    match fs::read_to_string(path) {
        Ok(contents) => contents
            .lines()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .map(|line| line.to_string())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Ensures the personal word list is loaded from disk.
fn ensure_personal_loaded(
    state: &tauri::State<'_, SpellState>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let mut personal = state
        .personal
        .lock()
        .map_err(|error| format!("Spell state poisoned: {error}"))?;

    if personal.path.is_none() {
        let path = personal_dictionary_path(app)?;
        personal.words = read_personal_words(&path);
        personal.path = Some(path);
    }

    Ok(())
}

/// Writes the personal dictionary's current words to disk.
///
/// Through a temporary file and a rename, as every other file this application
/// writes is. `fs::write` truncates first, so a crash or a full disk partway
/// through left the file empty or half-written — and this one holds the whole
/// of what the user has taught the spell checker, with no other copy anywhere.
fn save_personal_words(personal: &PersonalDictionary) -> Result<(), String> {
    let Some(path) = personal.path.as_ref() else {
        return Ok(());
    };
    let contents = format!("{}\n", personal.words.join("\n"));
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));

    fs::write(&temporary, contents).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Unable to save personal dictionary: {error}")
    })?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Unable to save personal dictionary: {error}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_and_checks_english() {
        let dictionaries = discover_dictionaries();
        let Some((aff, dic)) = resolve_dictionary_paths("en_US") else {
            eprintln!("en_US dictionary not installed; skipping");
            return;
        };
        assert!(dictionaries.iter().any(|entry| entry.code == "en_US"));

        let hunspell = Hunspell::new(&aff.to_string_lossy(), &dic.to_string_lossy());
        assert_eq!(hunspell.check("hello"), CheckResult::FoundInDictionary);
        assert_eq!(hunspell.check("teh"), CheckResult::MissingInDictionary);
        assert!(hunspell.suggest("teh").iter().any(|s| s == "the"));
    }
}

#[tauri::command]
pub fn spell_list_dictionaries() -> Vec<DictionaryInfo> {
    discover_dictionaries()
}

#[tauri::command]
pub fn spell_load_dictionary(
    app: tauri::AppHandle,
    state: tauri::State<'_, SpellState>,
    code: String,
) -> Result<bool, String> {
    let (aff, dic) = match resolve_dictionary_paths(&code) {
        Some(paths) => paths,
        None => return Ok(false),
    };

    let mut hunspell = Hunspell::new(&aff.to_string_lossy(), &dic.to_string_lossy());

    ensure_personal_loaded(&state, &app)?;
    let personal_words = state
        .personal
        .lock()
        .map_err(|error| format!("Spell state poisoned: {error}"))?
        .words
        .clone();
    for word in personal_words {
        hunspell.add(&word);
    }

    let ignored_words = state
        .ignored
        .lock()
        .map_err(|error| format!("Spell state poisoned: {error}"))?
        .clone();
    for word in ignored_words {
        hunspell.add(&word);
    }

    let mut guard = state
        .dictionary
        .lock()
        .map_err(|error| format!("Spell state poisoned: {error}"))?;
    *guard = Some(LoadedDictionary { hunspell });
    Ok(true)
}

/// Returns, aligned to `words`, whether each word is spelled correctly.
/// Words without alphabetic characters are always treated as correct.
#[tauri::command]
pub fn spell_check_words(
    state: tauri::State<'_, SpellState>,
    words: Vec<String>,
) -> Result<Vec<bool>, String> {
    let guard = state
        .dictionary
        .lock()
        .map_err(|error| format!("Spell state poisoned: {error}"))?;

    let Some(dictionary) = guard.as_ref() else {
        return Ok(vec![true; words.len()]);
    };

    let results = words
        .iter()
        .map(|word| {
            if !word.chars().any(char::is_alphabetic) {
                return true;
            }
            dictionary.hunspell.check(word) == CheckResult::FoundInDictionary
        })
        .collect();

    Ok(results)
}

#[tauri::command]
pub fn spell_suggest(
    state: tauri::State<'_, SpellState>,
    word: String,
) -> Result<Vec<String>, String> {
    let guard = state
        .dictionary
        .lock()
        .map_err(|error| format!("Spell state poisoned: {error}"))?;

    match guard.as_ref() {
        Some(dictionary) => Ok(dictionary.hunspell.suggest(&word)),
        None => Ok(Vec::new()),
    }
}

/// Adds a word to the active dictionary and persists it to the personal list.
#[tauri::command]
pub fn spell_add_word(
    app: tauri::AppHandle,
    state: tauri::State<'_, SpellState>,
    word: String,
) -> Result<(), String> {
    ensure_personal_loaded(&state, &app)?;

    // Stored before the checker is told, and taken back out of the list if it
    // could not be stored. The other order reported a failure while leaving the
    // word live in hunspell, so it looked added, worked until the app was
    // closed, and was gone afterwards.
    {
        let mut personal = state
            .personal
            .lock()
            .map_err(|error| format!("Spell state poisoned: {error}"))?;

        if !personal.words.iter().any(|existing| existing == &word) {
            personal.words.push(word.clone());
            if let Err(error) = save_personal_words(&personal) {
                personal.words.pop();
                return Err(error);
            }
        }
    }

    let mut guard = state
        .dictionary
        .lock()
        .map_err(|error| format!("Spell state poisoned: {error}"))?;
    if let Some(dictionary) = guard.as_mut() {
        dictionary.hunspell.add(&word);
    }
    Ok(())
}

/// Returns the personal dictionary's words, sorted for display.
#[tauri::command]
pub fn spell_list_added_words(
    app: tauri::AppHandle,
    state: tauri::State<'_, SpellState>,
) -> Result<Vec<String>, String> {
    ensure_personal_loaded(&state, &app)?;
    let mut words = state
        .personal
        .lock()
        .map_err(|error| format!("Spell state poisoned: {error}"))?
        .words
        .clone();
    words.sort_by_key(|word| word.to_lowercase());
    Ok(words)
}

/// Removes a word from the personal dictionary. The active in-memory
/// dictionary isn't touched here since libhunspell has no "unlearn" call;
/// callers should reload the dictionary afterwards to pick up the change.
#[tauri::command]
pub fn spell_remove_word(
    app: tauri::AppHandle,
    state: tauri::State<'_, SpellState>,
    word: String,
) -> Result<(), String> {
    ensure_personal_loaded(&state, &app)?;

    let mut personal = state
        .personal
        .lock()
        .map_err(|error| format!("Spell state poisoned: {error}"))?;

    personal.words.retain(|existing| existing != &word);
    save_personal_words(&personal)
}

/// Adds a word to the active dictionary for this session only (not persisted).
/// Recorded separately so a later dictionary reload (e.g. after removing a
/// personal word) can restore it, since a fresh `Hunspell` instance has no
/// memory of words added to the previous one.
#[tauri::command]
pub fn spell_ignore_word(state: tauri::State<'_, SpellState>, word: String) -> Result<(), String> {
    {
        let mut guard = state
            .dictionary
            .lock()
            .map_err(|error| format!("Spell state poisoned: {error}"))?;
        if let Some(dictionary) = guard.as_mut() {
            dictionary.hunspell.add(&word);
        }
    }

    let mut ignored = state
        .ignored
        .lock()
        .map_err(|error| format!("Spell state poisoned: {error}"))?;
    if !ignored.iter().any(|existing| existing == &word) {
        ignored.push(word);
    }
    Ok(())
}
