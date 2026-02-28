use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as TokioMutex;

use crate::utils::log_info;

// ─── API response types (HuggingFace) ───────────────────────────────────────

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct HfModelEntry {
    #[serde(rename = "modelId")]
    model_id: String,
    id: String,
    #[serde(default)]
    likes: i64,
    #[serde(default)]
    downloads: i64,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default, rename = "pipeline_tag")]
    pipeline_tag: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
    #[serde(default, rename = "trendingScore")]
    trending_score: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct HfModelDetail {
    #[serde(rename = "modelId")]
    model_id: String,
    id: String,
    #[serde(default)]
    likes: i64,
    #[serde(default)]
    downloads: i64,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    siblings: Vec<HfSibling>,
    #[serde(default)]
    gguf: Option<HfGgufMeta>,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[allow(dead_code)]
struct HfGgufMeta {
    #[serde(default)]
    total: Option<u64>,
    #[serde(default)]
    architecture: Option<String>,
    #[serde(default)]
    context_length: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct HfSibling {
    rfilename: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct HfTreeEntry {
    #[serde(rename = "type")]
    entry_type: String,
    path: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    lfs: Option<HfLfsInfo>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct HfLfsInfo {
    #[serde(default)]
    size: u64,
}

// ─── Frontend-facing types ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HfSearchResult {
    pub model_id: String,
    pub author: String,
    pub likes: i64,
    pub downloads: i64,
    pub tags: Vec<String>,
    pub pipeline_tag: Option<String>,
    pub last_modified: Option<String>,
    pub trending_score: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HfModelFile {
    pub filename: String,
    pub size: u64,
    pub quantization: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HfModelInfo {
    pub model_id: String,
    pub author: String,
    pub likes: i64,
    pub downloads: i64,
    pub tags: Vec<String>,
    pub architecture: Option<String>,
    pub context_length: Option<u64>,
    pub parameter_count: Option<u64>,
    pub files: Vec<HfModelFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HfDownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub status: String,
    pub filename: String,
    pub speed_bytes_per_sec: u64,
}

// ─── Download state ─────────────────────────────────────────────────────────

struct DownloadState {
    progress: HfDownloadProgress,
    cancel_requested: bool,
    is_downloading: bool,
    last_speed_sample: std::time::Instant,
    speed_bytes_window: u64,
}

lazy_static::lazy_static! {
    static ref HF_DOWNLOAD_STATE: Arc<TokioMutex<DownloadState>> = Arc::new(TokioMutex::new(DownloadState {
        progress: HfDownloadProgress {
            downloaded: 0,
            total: 0,
            status: "idle".to_string(),
            filename: String::new(),
            speed_bytes_per_sec: 0,
        },
        cancel_requested: false,
        is_downloading: false,
        last_speed_sample: std::time::Instant::now(),
        speed_bytes_window: 0,
    }));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn hf_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let lettuce_dir = crate::utils::lettuce_dir(app)?;
    let dir = lettuce_dir.join("models").join("gguf");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| {
            crate::utils::err_msg(
                module_path!(),
                line!(),
                format!("Failed to create GGUF models dir: {}", e),
            )
        })?;
    }
    Ok(dir)
}

/// Extract a human-readable quantization label from a GGUF filename.
fn extract_quantization(filename: &str) -> String {
    let upper = filename.to_uppercase();
    // Common quant patterns in GGUF filenames
    let patterns = [
        "IQ1_S",
        "IQ1_M",
        "IQ2_XXS",
        "IQ2_XS",
        "IQ2_S",
        "IQ2_M",
        "IQ3_XXS",
        "IQ3_XS",
        "IQ3_S",
        "IQ3_M",
        "IQ4_XS",
        "IQ4_NL",
        "Q2_K_S",
        "Q2_K_M",
        "Q2_K_L",
        "Q2_K_XL",
        "Q2_K",
        "Q3_K_S",
        "Q3_K_M",
        "Q3_K_L",
        "Q3_K_XL",
        "Q3_K",
        "Q4_K_S",
        "Q4_K_M",
        "Q4_K_L",
        "Q4_K_XL",
        "Q4_K",
        "Q4_0",
        "Q4_1",
        "Q5_K_S",
        "Q5_K_M",
        "Q5_K_L",
        "Q5_K_XL",
        "Q5_K",
        "Q5_0",
        "Q5_1",
        "Q6_K_S",
        "Q6_K_L",
        "Q6_K_XL",
        "Q6_K",
        "Q8_K_S",
        "Q8_K_L",
        "Q8_K_XL",
        "Q8_K",
        "Q8_0",
        "MXFP4_MOE",
        "F16",
        "F32",
        "BF16",
    ];
    for p in &patterns {
        if upper.contains(p) {
            return p.to_string();
        }
    }
    "Unknown".to_string()
}

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("LettuceAI/1.0")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

// ─── Tauri Commands ─────────────────────────────────────────────────────────

/// Search HuggingFace for GGUF models. Always includes the `gguf` filter.
#[tauri::command]
pub async fn hf_search_models(
    app: AppHandle,
    query: String,
    limit: Option<u32>,
    sort: Option<String>,
) -> Result<Vec<HfSearchResult>, String> {
    let limit = limit.unwrap_or(20).min(100);
    let sort_field = sort.unwrap_or_else(|| "trendingScore".to_string());

    let mut url = format!(
        "https://huggingface.co/api/models?filter=gguf&limit={}&sort={}",
        limit, sort_field
    );
    let trimmed = query.trim();
    if !trimmed.is_empty() {
        url.push_str(&format!("&search={}", urlencoding::encode(trimmed)));
    }

    log_info(&app, "hf_browser", format!("searching: {}", url));

    let client = build_client()?;
    let response = client.get(&url).send().await.map_err(|e| {
        crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("HuggingFace API request failed: {}", e),
        )
    })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("HuggingFace API error {}: {}", status, body),
        ));
    }

    let entries: Vec<HfModelEntry> = response.json().await.map_err(|e| {
        crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Failed to parse HuggingFace response: {}", e),
        )
    })?;

    let results: Vec<HfSearchResult> = entries
        .into_iter()
        .map(|e| {
            let author = e.author.unwrap_or_else(|| {
                e.model_id
                    .split('/')
                    .next()
                    .unwrap_or("unknown")
                    .to_string()
            });
            HfSearchResult {
                model_id: e.model_id,
                author,
                likes: e.likes,
                downloads: e.downloads,
                tags: e.tags,
                pipeline_tag: e.pipeline_tag,
                last_modified: e.last_modified,
                trending_score: e.trending_score,
            }
        })
        .collect();

    log_info(
        &app,
        "hf_browser",
        format!("search returned {} results", results.len()),
    );

    Ok(results)
}

/// Fetch model detail + list GGUF files with their sizes.
#[tauri::command]
pub async fn hf_get_model_files(app: AppHandle, model_id: String) -> Result<HfModelInfo, String> {
    log_info(
        &app,
        "hf_browser",
        format!("fetching model info: {}", model_id),
    );

    let client = build_client()?;

    // Fetch model metadata (for tags, gguf info, etc.)
    let detail_url = format!("https://huggingface.co/api/models/{}", model_id);
    let detail_resp = client.get(&detail_url).send().await.map_err(|e| {
        crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Failed to fetch model detail: {}", e),
        )
    })?;

    if !detail_resp.status().is_success() {
        let status = detail_resp.status();
        return Err(crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Model not found ({}): {}", status, model_id),
        ));
    }

    let detail: HfModelDetail = detail_resp.json().await.map_err(|e| {
        crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Failed to parse model detail: {}", e),
        )
    })?;

    // Fetch file tree to get sizes
    let tree_url = format!(
        "https://huggingface.co/api/models/{}/tree/main?recursive=false",
        model_id
    );
    let tree_resp = client.get(&tree_url).send().await.map_err(|e| {
        crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Failed to fetch file tree: {}", e),
        )
    })?;

    let tree_entries: Vec<HfTreeEntry> = if tree_resp.status().is_success() {
        tree_resp.json().await.unwrap_or_default()
    } else {
        vec![]
    };

    // Build a map of filename → size from tree
    let size_map: std::collections::HashMap<String, u64> = tree_entries
        .into_iter()
        .filter(|e| e.entry_type == "file")
        .map(|e| {
            let size = e.lfs.as_ref().map(|l| l.size).unwrap_or(e.size);
            (e.path, size)
        })
        .collect();

    // Filter to .gguf files only
    let mut files: Vec<HfModelFile> = detail
        .siblings
        .iter()
        .filter(|s| {
            let lower = s.rfilename.to_lowercase();
            lower.ends_with(".gguf") && !lower.contains("mmproj") && !lower.contains("imatrix")
        })
        .map(|s| {
            let size = size_map.get(&s.rfilename).copied().unwrap_or(0);
            let quantization = extract_quantization(&s.rfilename);
            HfModelFile {
                filename: s.rfilename.clone(),
                size,
                quantization,
            }
        })
        .collect();

    // Sort by size ascending (smallest quant first)
    files.sort_by_key(|f| f.size);

    let author = detail
        .author
        .unwrap_or_else(|| model_id.split('/').next().unwrap_or("unknown").to_string());

    let architecture = detail.gguf.as_ref().and_then(|g| g.architecture.clone());
    let context_length = detail.gguf.as_ref().and_then(|g| g.context_length);
    let parameter_count = detail.gguf.as_ref().and_then(|g| g.total);

    log_info(
        &app,
        "hf_browser",
        format!(
            "model {} has {} GGUF files, arch={:?}",
            model_id,
            files.len(),
            architecture
        ),
    );

    Ok(HfModelInfo {
        model_id: detail.model_id,
        author,
        likes: detail.likes,
        downloads: detail.downloads,
        tags: detail.tags,
        architecture,
        context_length,
        parameter_count,
        files,
    })
}

/// Download a specific GGUF file from a HuggingFace model repo.
/// Emits `hf_download_progress` events. Returns the local file path on success.
#[tauri::command]
pub async fn hf_download_model(
    app: AppHandle,
    model_id: String,
    filename: String,
) -> Result<String, String> {
    // Guard against concurrent downloads
    {
        let mut state = HF_DOWNLOAD_STATE.lock().await;
        if state.is_downloading {
            return Err("A download is already in progress".to_string());
        }
        state.is_downloading = true;
        state.cancel_requested = false;
        state.progress = HfDownloadProgress {
            downloaded: 0,
            total: 0,
            status: "starting".to_string(),
            filename: filename.clone(),
            speed_bytes_per_sec: 0,
        };
        state.last_speed_sample = std::time::Instant::now();
        state.speed_bytes_window = 0;
    }

    let result = do_download(&app, &model_id, &filename).await;

    // Always reset downloading flag
    {
        let mut state = HF_DOWNLOAD_STATE.lock().await;
        state.is_downloading = false;
        if result.is_ok() {
            state.progress.status = "complete".to_string();
            state.progress.downloaded = state.progress.total;
        } else {
            state.progress.status = "error".to_string();
        }
        let _ = app.emit("hf_download_progress", &state.progress);
    }

    result
}

async fn do_download(app: &AppHandle, model_id: &str, filename: &str) -> Result<String, String> {
    let models_dir = hf_models_dir(app)?;

    // Create a subdirectory named after the model (replace / with --)
    let safe_model_name = model_id.replace('/', "--");
    let model_dir = models_dir.join(&safe_model_name);
    if !model_dir.exists() {
        tokio::fs::create_dir_all(&model_dir).await.map_err(|e| {
            crate::utils::err_msg(
                module_path!(),
                line!(),
                format!("Failed to create model directory: {}", e),
            )
        })?;
    }

    let dest_path = model_dir.join(filename);

    // If the file already exists and has a reasonable size, skip download
    if dest_path.exists() {
        let meta = tokio::fs::metadata(&dest_path).await.ok();
        if let Some(m) = meta {
            if m.len() > 1_000_000 {
                log_info(
                    app,
                    "hf_browser",
                    format!(
                        "File already exists ({} bytes), skipping download: {}",
                        m.len(),
                        dest_path.display()
                    ),
                );
                return Ok(dest_path.to_string_lossy().to_string());
            }
        }
    }

    let download_url = format!(
        "https://huggingface.co/{}/resolve/main/{}",
        model_id, filename
    );

    log_info(
        app,
        "hf_browser",
        format!(
            "starting download: {} → {}",
            download_url,
            dest_path.display()
        ),
    );

    let client = reqwest::Client::builder()
        .user_agent("LettuceAI/1.0")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    let response = client.get(&download_url).send().await.map_err(|e| {
        crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Failed to start download: {}", e),
        )
    })?;

    if !response.status().is_success() {
        return Err(crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Download failed with status: {}", response.status()),
        ));
    }

    let total_size = response.content_length().unwrap_or(0);

    {
        let mut state = HF_DOWNLOAD_STATE.lock().await;
        state.progress.total = total_size;
        state.progress.status = "downloading".to_string();
        state.last_speed_sample = std::time::Instant::now();
        state.speed_bytes_window = 0;
        let _ = app.emit("hf_download_progress", &state.progress);
    }

    let temp_path = dest_path.with_extension("tmp");
    let mut file = tokio::fs::File::create(&temp_path).await.map_err(|e| {
        crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Failed to create temp file: {}", e),
        )
    })?;

    let mut stream = response.bytes_stream();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk_result) = stream.next().await {
        // Check cancellation
        {
            let state = HF_DOWNLOAD_STATE.lock().await;
            if state.cancel_requested {
                drop(file);
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err("Download cancelled".to_string());
            }
        }

        let chunk = chunk_result.map_err(|e| {
            crate::utils::err_msg(
                module_path!(),
                line!(),
                format!("Error reading download chunk: {}", e),
            )
        })?;

        file.write_all(&chunk).await.map_err(|e| {
            crate::utils::err_msg(
                module_path!(),
                line!(),
                format!("Error writing to file: {}", e),
            )
        })?;

        let chunk_len = chunk.len() as u64;

        {
            let mut state = HF_DOWNLOAD_STATE.lock().await;
            state.progress.downloaded += chunk_len;
            state.speed_bytes_window += chunk_len;

            let elapsed = state.last_speed_sample.elapsed();
            if elapsed.as_millis() >= 1000 {
                let secs = elapsed.as_secs_f64();
                if secs > 0.0 {
                    state.progress.speed_bytes_per_sec =
                        (state.speed_bytes_window as f64 / secs) as u64;
                }
                state.speed_bytes_window = 0;
                state.last_speed_sample = std::time::Instant::now();
            }

            if last_emit.elapsed().as_millis() > 150 {
                let _ = app.emit("hf_download_progress", &state.progress);
                last_emit = std::time::Instant::now();
            }
        }
    }

    file.flush().await.map_err(|e| {
        crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Error flushing file: {}", e),
        )
    })?;
    drop(file);

    // Rename temp → final
    tokio::fs::rename(&temp_path, &dest_path)
        .await
        .map_err(|e| {
            crate::utils::err_msg(
                module_path!(),
                line!(),
                format!("Failed to rename temp file: {}", e),
            )
        })?;

    let final_path = dest_path.to_string_lossy().to_string();

    log_info(
        app,
        "hf_browser",
        format!("download complete: {} ({} bytes)", final_path, total_size),
    );

    Ok(final_path)
}

#[tauri::command]
pub async fn hf_get_download_progress() -> Result<HfDownloadProgress, String> {
    let state = HF_DOWNLOAD_STATE.lock().await;
    Ok(state.progress.clone())
}

#[tauri::command]
pub async fn hf_cancel_download(app: AppHandle) -> Result<(), String> {
    log_info(&app, "hf_browser", "cancel requested");
    let mut state = HF_DOWNLOAD_STATE.lock().await;
    if state.is_downloading {
        state.cancel_requested = true;
        state.progress.status = "cancelling".to_string();
        let _ = app.emit("hf_download_progress", &state.progress);
    }
    Ok(())
}

/// List already-downloaded GGUF models on disk.
#[tauri::command]
pub async fn hf_list_downloaded_models(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let models_dir = hf_models_dir(&app)?;

    let mut results = Vec::new();

    let entries = std::fs::read_dir(&models_dir).map_err(|e| {
        crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Failed to read models dir: {}", e),
        )
    })?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let dir_name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Scan for .gguf files in this subdirectory
        if let Ok(files) = std::fs::read_dir(&path) {
            for file_entry in files.flatten() {
                let file_path = file_entry.path();
                let fname = file_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                if fname.to_lowercase().ends_with(".gguf") && !fname.ends_with(".tmp") {
                    let size = file_entry.metadata().map(|m| m.len()).unwrap_or(0);
                    results.push(serde_json::json!({
                        "modelId": dir_name.replace("--", "/"),
                        "filename": fname,
                        "path": file_path.to_string_lossy(),
                        "size": size,
                        "quantization": extract_quantization(&fname),
                    }));
                }
            }
        }
    }

    Ok(results)
}

/// Delete a downloaded GGUF model file from disk.
#[tauri::command]
pub async fn hf_delete_downloaded_model(app: AppHandle, file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);

    if !path.exists() {
        return Ok(());
    }

    // Safety: only allow deleting files inside our managed models directory
    let models_dir = hf_models_dir(&app)?;
    if !path.starts_with(&models_dir) {
        return Err("Cannot delete files outside the models directory".to_string());
    }

    tokio::fs::remove_file(&path).await.map_err(|e| {
        crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Failed to delete model file: {}", e),
        )
    })?;

    // Remove parent dir if empty
    if let Some(parent) = path.parent() {
        if parent != models_dir {
            let _ = tokio::fs::remove_dir(parent).await; // ignore error if not empty
        }
    }

    log_info(
        &app,
        "hf_browser",
        format!("deleted model file: {}", file_path),
    );

    Ok(())
}
