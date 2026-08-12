# Project workflow rules

- After every build or update of the Tauri/Rust app, immediately run `cargo clean` inside `src-tauri/` to reclaim disk space (it removes 1-2 GB of build artifacts).
