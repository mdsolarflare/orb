use orb_ir::{DocumentIr, EditOperation};
use orb_pdf::FormFieldUpdate;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SamplePayload {
    filename: String,
    bytes: Vec<u8>,
    hint_pem: Option<String>,
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    value
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn open_document(
    bytes: &[u8],
    filename: Option<String>,
    trusted_roots_json: &str,
) -> Result<JsValue, JsValue> {
    let roots: Vec<String> = serde_json::from_str(trusted_roots_json).unwrap_or_default();
    let opened = orb_engine::open_document(bytes, filename.as_deref(), &roots)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    to_js(&opened)
}

#[wasm_bindgen]
pub fn parse_markdown_live(markdown: &str, filename: Option<String>) -> Result<JsValue, JsValue> {
    let ir = orb_engine::parse_markdown_live(markdown, filename.as_deref());
    to_js(&ir)
}

#[wasm_bindgen]
pub fn apply_ir_edit(ir_json: &str, op_json: &str) -> Result<JsValue, JsValue> {
    let ir: DocumentIr =
        serde_json::from_str(ir_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let op: EditOperation =
        serde_json::from_str(op_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let updated =
        orb_engine::apply_ir_edit(ir, op).map_err(|e| JsValue::from_str(&e.to_string()))?;
    to_js(&updated)
}

#[wasm_bindgen]
pub fn export_ir_to_markdown(ir_json: &str) -> Result<String, JsValue> {
    let ir: DocumentIr =
        serde_json::from_str(ir_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(orb_engine::export_ir_to_markdown(&ir))
}

#[wasm_bindgen]
pub fn export_ir_to_docx(ir_json: &str) -> Result<Vec<u8>, JsValue> {
    let ir: DocumentIr =
        serde_json::from_str(ir_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    orb_engine::export_ir_to_docx(&ir).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn export_pdf_forms(raw_pdf: &[u8], updates_json: &str) -> Result<Vec<u8>, JsValue> {
    let updates: Vec<FormFieldUpdate> =
        serde_json::from_str(updates_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
    orb_engine::export_pdf_forms(raw_pdf, &updates).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn reverify_pdf(
    raw_pdf: &[u8],
    filename: Option<String>,
    trusted_roots_json: &str,
) -> Result<JsValue, JsValue> {
    let roots: Vec<String> = serde_json::from_str(trusted_roots_json).unwrap_or_default();
    let inspection = orb_engine::reverify_pdf(raw_pdf, filename.as_deref(), &roots)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    to_js(&inspection)
}

#[wasm_bindgen]
pub fn list_samples() -> Result<JsValue, JsValue> {
    to_js(&orb_engine::list_samples())
}

#[wasm_bindgen]
pub fn generate_sample(sample_id: &str) -> Result<JsValue, JsValue> {
    let sample =
        orb_engine::generate_sample(sample_id).map_err(|e| JsValue::from_str(&e.to_string()))?;
    to_js(&SamplePayload {
        filename: sample.filename,
        bytes: sample.bytes,
        hint_pem: sample.hint_pem,
    })
}
