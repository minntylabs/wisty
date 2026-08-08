use tauri::Manager;

#[tauri::command]
pub async fn set_window_title(
    app: tauri::AppHandle,
    label: String,
    title: String,
) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("Window '{label}' not found"))?;

    window
        .set_title(&title)
        .map_err(|error| format!("Unable to set window title: {error}"))?;

    {
        if is_wayland_session() {
            // Wayland workaround for upstream issue where set_title updates taskbar metadata
            // but does not update the visible GTK header bar title.
            // Reference: https://github.com/tauri-apps/tauri/issues/13749
            if let Err(error) = apply_wayland_headerbar_title(&app, &label, &title) {
                log_warn(&format!(
                    "Window title fallback failed for '{label}': {error}"
                ));
            }
        }
    }

    Ok(())
}

fn is_wayland_session() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|value| value.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
}

fn apply_wayland_headerbar_title(
    app: &tauri::AppHandle,
    label: &str,
    title: &str,
) -> Result<(), String> {
    use gtk::prelude::{BinExt, Cast, GtkWindowExt, HeaderBarExt};
    use gtk::{EventBox, HeaderBar};
    use std::sync::mpsc;

    let label_owned = label.to_string();
    let title_owned = title.to_string();
    let app_handle = app.clone();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    app.run_on_main_thread(move || {
        let result = (|| {
            let window = app_handle
                .get_webview_window(&label_owned)
                .ok_or_else(|| format!("Window '{label_owned}' not found"))?;

            let gtk_window = window
                .gtk_window()
                .map_err(|error| format!("No GTK window handle available: {error}"))?;

            let titlebar: gtk::Widget = gtk_window
                .titlebar()
                .ok_or_else(|| "GTK titlebar not available".to_string())?;

            if let Ok(header_bar) = titlebar.clone().downcast::<HeaderBar>() {
                header_bar.set_title(Some(&title_owned));
                return Ok(());
            }

            if let Ok(event_box) = titlebar.clone().downcast::<EventBox>() {
                let child: gtk::Widget = event_box
                    .child()
                    .ok_or_else(|| "GTK titlebar container has no child".to_string())?;

                let header_bar = child
                    .downcast::<HeaderBar>()
                    .map_err(|_| "GTK titlebar child is not HeaderBar".to_string())?;

                header_bar.set_title(Some(&title_owned));
                return Ok(());
            }

            Err("Unsupported GTK titlebar widget type".to_string())
        })();

        let _ = tx.send(result);
    })
    .map_err(|error| error.to_string())?;

    rx.recv()
        .map_err(|error| format!("Failed to receive title fallback result: {error}"))?
}

fn log_warn(message: &str) {
    use log::{Level, Metadata, Record};

    let metadata = Metadata::builder()
        .level(Level::Warn)
        .target("wisty::window_title")
        .build();

    if !log::logger().enabled(&metadata) {
        return;
    }

    let args = format_args!("{message}");

    let record = Record::builder().metadata(metadata).args(args).build();

    log::logger().log(&record);
}
