// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer Abdullah and Concat contributors

//! The edit, in a browser tab.
//!
//! `concat-project` is headless and has no native dependencies, so it
//! compiles to WebAssembly as it is. This crate is the thin surface a web
//! page calls: every method takes and returns JSON strings, the same JSON
//! the desktop app's API speaks (`Command` is tagged by `op`, the project
//! and the saved `concat.json` are the documents the desktop app writes).
//! A project saved here opens in the desktop app and the other way round.
//!
//! What is *not* here: decoding, compositing and encoding. Those are the
//! browser's (WebCodecs, canvas, Web Audio); see `web/PORTING.md`.
//!
//! [`Session`] holds the logic and speaks `String` errors, so it is tested
//! on the host. [`WebEditor`] (wasm32 only) is the binding over it.

use concat_project::{Command, DocumentSettings, Editor};
use serde_json::Value;

/// One open project: the editor (project, id mint, undo history) and the
/// manifest settings saved around it.
pub struct Session {
    editor: Editor,
    settings: DocumentSettings,
}

fn json_err(error: serde_json::Error) -> String {
    format!("Bad JSON: {error}")
}

impl Session {
    /// A fresh, empty project whose first timeline renders at this frame.
    pub fn new(name: &str, width: u32, height: u32, rate_num: i64, rate_den: i64) -> Self {
        let settings = DocumentSettings {
            name: name.to_owned(),
            width,
            height,
            rate_num,
            rate_den,
            canvas: [0, 0, 0, 255],
        };
        Self {
            editor: Editor::with_video(settings.video()),
            settings,
        }
    }

    /// Opens a saved `concat.json`. Errors when the text is not JSON or holds
    /// nothing recognisable as a project. Older documents load, as they do
    /// on the desktop.
    pub fn from_document(text: &str) -> Result<Self, String> {
        let document: Value = serde_json::from_str(text).map_err(json_err)?;
        let editor = Editor::from_document(&document)
            .ok_or_else(|| "That file is not a Concat project.".to_owned())?;
        let video = &editor.project().active().video;
        let settings = DocumentSettings {
            name: document
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Untitled")
                .to_owned(),
            width: video.width,
            height: video.height,
            rate_num: video.rate_num,
            rate_den: video.rate_den,
            canvas: video.canvas,
        };
        Ok(Self { editor, settings })
    }

    /// Applies one command, given as JSON, as a step of `gesture` when one
    /// is named. Returns the outcome as JSON (`{"createdId":..,"applied":..}`)
    /// or the sentence the desktop app would show.
    pub fn apply(&mut self, gesture: Option<&str>, command: &str) -> Result<String, String> {
        let command: Command = serde_json::from_str(command).map_err(json_err)?;
        let outcome = self
            .editor
            .apply_within(gesture, command)
            .map_err(|error| error.to_string())?;
        serde_json::to_string(&outcome).map_err(json_err)
    }

    /// Ends the gesture in progress; call when the pointer goes up.
    pub fn end_gesture(&mut self) {
        self.editor.end_gesture();
    }

    /// Steps back one edit; whether anything changed.
    pub fn undo(&mut self) -> bool {
        self.editor.undo()
    }

    /// Steps forward one edit; whether anything changed.
    pub fn redo(&mut self) -> bool {
        self.editor.redo()
    }

    /// Whether undo would do anything.
    pub fn can_undo(&self) -> bool {
        self.editor.can_undo()
    }

    /// Whether redo would do anything.
    pub fn can_redo(&self) -> bool {
        self.editor.can_redo()
    }

    /// The whole project as JSON: media bin, timelines, tracks, clips.
    pub fn project(&self) -> Result<String, String> {
        serde_json::to_string(self.editor.project()).map_err(json_err)
    }

    /// The `concat.json` document, for saving.
    pub fn document(&self) -> Result<String, String> {
        serde_json::to_string_pretty(&self.editor.to_document(&self.settings)).map_err(json_err)
    }

    /// Renames the project, as saved.
    pub fn set_name(&mut self, name: &str) {
        self.settings.name = name.to_owned();
    }
}

#[cfg(target_arch = "wasm32")]
mod bindings {
    use super::Session;
    use wasm_bindgen::prelude::*;

    /// Runs once when the module loads: panics reach the console with a
    /// message instead of `unreachable executed`.
    #[wasm_bindgen(start)]
    pub fn start() {
        console_error_panic_hook::set_once();
    }

    /// The engine's version, for the page's About box.
    #[wasm_bindgen]
    pub fn version() -> String {
        env!("CARGO_PKG_VERSION").to_owned()
    }

    /// One open project, held in the page.
    #[wasm_bindgen]
    pub struct WebEditor {
        session: Session,
    }

    #[wasm_bindgen]
    impl WebEditor {
        /// A fresh, empty project.
        #[wasm_bindgen(constructor)]
        pub fn new(name: &str, width: u32, height: u32, rate_num: i64, rate_den: i64) -> WebEditor {
            WebEditor {
                session: Session::new(name, width, height, rate_num, rate_den),
            }
        }

        /// Opens the text of a saved `concat.json`.
        #[wasm_bindgen(js_name = fromDocument)]
        pub fn from_document(text: &str) -> Result<WebEditor, JsError> {
            Session::from_document(text)
                .map(|session| WebEditor { session })
                .map_err(|message| JsError::new(&message))
        }

        /// Applies a command (JSON). Returns the outcome (JSON); throws the
        /// refusal sentence.
        pub fn apply(&mut self, command: &str) -> Result<String, JsError> {
            self.session
                .apply(None, command)
                .map_err(|message| JsError::new(&message))
        }

        /// [`WebEditor::apply`] as one move of a named gesture: a drag is
        /// one undo step.
        #[wasm_bindgen(js_name = applyWithin)]
        pub fn apply_within(&mut self, gesture: &str, command: &str) -> Result<String, JsError> {
            self.session
                .apply(Some(gesture), command)
                .map_err(|message| JsError::new(&message))
        }

        /// Ends the gesture in progress.
        #[wasm_bindgen(js_name = endGesture)]
        pub fn end_gesture(&mut self) {
            self.session.end_gesture();
        }

        /// Steps back; whether anything changed.
        pub fn undo(&mut self) -> bool {
            self.session.undo()
        }

        /// Steps forward; whether anything changed.
        pub fn redo(&mut self) -> bool {
            self.session.redo()
        }

        /// Whether undo would do anything.
        #[wasm_bindgen(js_name = canUndo)]
        pub fn can_undo(&self) -> bool {
            self.session.can_undo()
        }

        /// Whether redo would do anything.
        #[wasm_bindgen(js_name = canRedo)]
        pub fn can_redo(&self) -> bool {
            self.session.can_redo()
        }

        /// The project as JSON.
        pub fn project(&self) -> Result<String, JsError> {
            self.session
                .project()
                .map_err(|message| JsError::new(&message))
        }

        /// The `concat.json` text, for saving.
        pub fn document(&self) -> Result<String, JsError> {
            self.session
                .document()
                .map_err(|message| JsError::new(&message))
        }

        /// Renames the project, as saved.
        #[wasm_bindgen(js_name = setName)]
        pub fn set_name(&mut self, name: &str) {
            self.session.set_name(name);
        }
    }
}

#[cfg(target_arch = "wasm32")]
pub use bindings::*;

#[cfg(test)]
mod tests {
    use super::Session;
    use serde_json::{Value, json};

    fn media(name: &str) -> String {
        json!({
            "op": "addMedia",
            "item": {
                "path": format!("web://{name}"), "name": name, "duration": 10.0,
                "kind": "video", "width": 1920, "height": 1080,
                "frameRate": 30.0, "frameRateFraction": "30/1",
                "videoCodec": "h264", "audioCodec": "aac", "hasAudio": true
            }
        })
        .to_string()
    }

    fn created(outcome: &str) -> String {
        let value: Value = serde_json::from_str(outcome).unwrap();
        value["createdId"].as_str().unwrap().to_owned()
    }

    fn project(session: &Session) -> Value {
        serde_json::from_str(&session.project().unwrap()).unwrap()
    }

    #[test]
    fn add_split_undo_save_reload() {
        let mut session = Session::new("Test", 1920, 1080, 30, 1);
        let media_id = created(&session.apply(None, &media("a.mp4")).unwrap());
        let track_id = project(&session)["timelines"][0]["tracks"][0]["id"]
            .as_str()
            .unwrap()
            .to_owned();
        let add = json!({"op": "addClip", "mediaId": media_id, "trackId": track_id, "start": 0.0});
        let clip_id = created(&session.apply(None, &add.to_string()).unwrap());

        let split = json!({"op": "splitClips", "clipIds": [clip_id], "time": 4.0});
        session.apply(None, &split.to_string()).unwrap();
        assert_eq!(
            project(&session)["timelines"][0]["clips"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        assert!(session.undo());
        assert_eq!(
            project(&session)["timelines"][0]["clips"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(session.redo());

        let saved = session.document().unwrap();
        let reopened = Session::from_document(&saved).unwrap();
        assert_eq!(
            project(&reopened)["timelines"][0]["clips"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn refusal_is_the_desktop_sentence() {
        let mut session = Session::new("Test", 1280, 720, 30, 1);
        let add = json!({"op": "addClip", "mediaId": "nope", "trackId": "T1", "start": 0.0});
        let error = session.apply(None, &add.to_string()).unwrap_err();
        assert_eq!(error, "That media is no longer in the bin.");
    }

    #[test]
    fn rejects_non_projects_and_bad_json() {
        assert!(Session::from_document("not json").is_err());
        let mut session = Session::new("Test", 1280, 720, 30, 1);
        assert!(session.apply(None, "{\"op\":\"nonsense\"}").is_err());
    }
}
