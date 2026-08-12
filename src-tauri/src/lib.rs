use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // The real UI is served by the local Node server (server.js) on
            // 127.0.0.1:3000 — same as the dev URL. Release builds embed a
            // placeholder frontend, so point the window at the live server so
            // everything (tracking, voice, window switching) keeps working.
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(url) = tauri::Url::parse("http://127.0.0.1:3000") {
                    let _ = window.navigate(url);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}