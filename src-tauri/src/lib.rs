#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    eprintln!("[gt] building tauri app");
    let app = tauri::Builder::default()
        .setup(|app| {
            eprintln!("[gt] setup: creating window");
            let win = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("Local Body Deck — Gesture Tracker")
                .inner_size(1100.0, 900.0)
                .build()?;
            eprintln!("[gt] window created: {:?}", win.label());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    eprintln!("[gt] running app");
    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            eprintln!("[gt] exit event received");
        }
    });
    eprintln!("[gt] app run returned");
}
