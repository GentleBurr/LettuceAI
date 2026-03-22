use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::api::{api_request, ApiRequest};
use crate::chat_manager::storage::{get_base_prompt, PromptType};
use crate::utils::{log_info, now_millis};

use super::attachments::persist_attachments;
use super::execution::prepare_sampling_request;
use super::prompt_engine;
use super::prompts;
use super::request::extract_text;
use super::service::{resolve_api_key, ChatContext};
use crate::usage::tracking::UsageOperationType;

use super::storage::{
    default_character_rules, recent_messages, resolve_provider_credential_for_model,
};
use super::turn_builder::{role_swap_enabled, swap_role_for_api, swapped_prompt_entities};
use super::types::{
    Character, ChatAddMessageAttachmentArgs, ChatCompletionArgs, ChatContinueArgs,
    ChatGenerateSceneImageArgs, ChatGenerateScenePromptArgs, ChatRegenerateArgs, ChatTurnResult,
    ContinueResult, ImageAttachment, Persona, PromptScope, RegenerateResult, Session, Settings,
    StoredMessage, SystemPromptEntry, SystemPromptTemplate,
};
use crate::storage_manager::sessions::{messages_upsert_batch_typed, session_upsert_meta_typed};
fn resolve_persona_id<'a>(session: &'a Session, explicit: Option<&'a str>) -> Option<&'a str> {
    if explicit.is_some() {
        return explicit;
    }
    if session.persona_disabled {
        Some("")
    } else {
        session.persona_id.as_deref()
    }
}

#[allow(dead_code)]
fn has_image_generation_model(settings: &Settings) -> bool {
    settings.models.iter().any(|m| {
        m.output_scopes
            .iter()
            .any(|s| s.eq_ignore_ascii_case("image"))
    })
}

pub(crate) fn take_aborted_request(app: &AppHandle, request_id: Option<&str>) -> bool {
    let Some(request_id) = request_id else {
        return false;
    };

    let registry = app.state::<crate::abort_manager::AbortRegistry>();
    registry.take_aborted(request_id)
}

fn help_me_reply_participant_names<'a>(
    prompt_character: &'a Character,
    prompt_persona: Option<&'a Persona>,
) -> (&'a str, &'a str) {
    let effective_user_name = prompt_persona.map(|p| p.title.as_str()).unwrap_or("User");
    let effective_assistant_name = prompt_character.name.as_str();
    (effective_user_name, effective_assistant_name)
}

#[tauri::command]
pub async fn chat_completion(
    app: AppHandle,
    args: ChatCompletionArgs,
) -> Result<ChatTurnResult, String> {
    super::flows::completion::CompletionFlow::new(app)
        .execute(args)
        .await
}

#[tauri::command]
pub async fn chat_regenerate(
    app: AppHandle,
    args: ChatRegenerateArgs,
) -> Result<RegenerateResult, String> {
    super::flows::regenerate::RegenerateFlow::new(app)
        .execute(args)
        .await
}

#[tauri::command]
pub async fn chat_continue(
    app: AppHandle,
    args: ChatContinueArgs,
) -> Result<ContinueResult, String> {
    super::flows::continuation::ContinueFlow::new(app)
        .execute(args)
        .await
}

#[tauri::command]
pub fn get_default_character_rules(pure_mode_level: String) -> Vec<String> {
    default_character_rules(&pure_mode_level)
}

#[tauri::command]
pub fn get_default_system_prompt_template() -> String {
    get_base_prompt(PromptType::SystemPrompt)
}

// ==================== Prompt Template Commands ====================

#[tauri::command]
pub fn list_prompt_templates(app: AppHandle) -> Result<Vec<SystemPromptTemplate>, String> {
    prompts::load_templates(&app)
}

#[tauri::command]
pub fn create_prompt_template(
    app: AppHandle,
    name: String,
    scope: PromptScope,
    target_ids: Vec<String>,
    content: String,
    entries: Option<Vec<SystemPromptEntry>>,
    condense_prompt_entries: Option<bool>,
) -> Result<SystemPromptTemplate, String> {
    prompts::create_template(
        &app,
        name,
        scope,
        target_ids,
        content,
        entries,
        condense_prompt_entries,
    )
}

#[tauri::command]
pub fn update_prompt_template(
    app: AppHandle,
    id: String,
    name: Option<String>,
    scope: Option<PromptScope>,
    target_ids: Option<Vec<String>>,
    content: Option<String>,
    entries: Option<Vec<SystemPromptEntry>>,
    condense_prompt_entries: Option<bool>,
) -> Result<SystemPromptTemplate, String> {
    prompts::update_template(
        &app,
        id,
        name,
        scope,
        target_ids,
        content,
        entries,
        condense_prompt_entries,
    )
}

#[tauri::command]
pub fn delete_prompt_template(app: AppHandle, id: String) -> Result<(), String> {
    prompts::delete_template(&app, id)
}

#[tauri::command]
pub fn get_prompt_template(
    app: AppHandle,
    id: String,
) -> Result<Option<SystemPromptTemplate>, String> {
    prompts::get_template(&app, &id)
}

#[tauri::command]
pub fn export_prompt_template_as_usc(app: AppHandle, id: String) -> Result<String, String> {
    let template =
        prompts::get_template(&app, &id)?.ok_or_else(|| format!("Template not found: {}", id))?;
    let card = crate::storage_manager::system_cards::create_system_prompt_template_usc(&template);
    serde_json::to_string_pretty(&card).map_err(|e| {
        crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Failed to serialize USC prompt template export: {}", e),
        )
    })
}

#[tauri::command]
pub fn chat_template_export_as_usc(template_json: String) -> Result<String, String> {
    let value: Value = serde_json::from_str(&template_json).map_err(|e| {
        crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Invalid chat template JSON for export: {}", e),
        )
    })?;

    let id = value
        .get("id")
        .and_then(|item| item.as_str())
        .ok_or_else(|| {
            crate::utils::err_msg(module_path!(), line!(), "Chat template id is required")
        })?
        .to_string();
    let name = value
        .get("name")
        .and_then(|item| item.as_str())
        .ok_or_else(|| {
            crate::utils::err_msg(module_path!(), line!(), "Chat template name is required")
        })?
        .to_string();
    let scene_id = value
        .get("sceneId")
        .and_then(|item| item.as_str())
        .map(|item| item.to_string());
    let prompt_template_id = value
        .get("promptTemplateId")
        .and_then(|item| item.as_str())
        .map(|item| item.to_string());
    let created_at = value
        .get("createdAt")
        .and_then(|item| item.as_i64())
        .unwrap_or_else(|| now_millis().unwrap_or(0) as i64);

    let template = crate::sync::models::ChatTemplate {
        id: id.clone(),
        character_id: String::new(),
        name,
        scene_id,
        prompt_template_id,
        created_at,
    };

    let messages = value
        .get("messages")
        .and_then(|item| item.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
        .map(|(idx, message)| crate::sync::models::ChatTemplateMessage {
            id: message
                .get("id")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
            template_id: id.clone(),
            idx: idx as i64,
            role: message
                .get("role")
                .and_then(|item| item.as_str())
                .unwrap_or("assistant")
                .to_string(),
            content: message
                .get("content")
                .and_then(|item| item.as_str())
                .unwrap_or_default()
                .to_string(),
        })
        .collect::<Vec<_>>();

    let card = crate::storage_manager::system_cards::create_chat_template_usc(&template, &messages);
    serde_json::to_string_pretty(&card).map_err(|e| {
        crate::utils::err_msg(
            module_path!(),
            line!(),
            format!("Failed to serialize USC chat template export: {}", e),
        )
    })
}

#[tauri::command]
pub fn get_app_default_template_id() -> String {
    prompts::APP_DEFAULT_TEMPLATE_ID.to_string()
}

#[tauri::command]
pub fn is_app_default_template(id: String) -> bool {
    prompts::is_app_default_template(&id)
}

#[tauri::command]
pub fn reset_app_default_template(app: AppHandle) -> Result<SystemPromptTemplate, String> {
    prompts::reset_app_default_template(&app)
}

#[tauri::command]
pub fn reset_dynamic_summary_template(app: AppHandle) -> Result<SystemPromptTemplate, String> {
    prompts::reset_dynamic_summary_template(&app)
}

#[tauri::command]
pub fn reset_dynamic_memory_template(app: AppHandle) -> Result<SystemPromptTemplate, String> {
    prompts::reset_dynamic_memory_template(&app)
}

#[tauri::command]
pub fn reset_help_me_reply_template(app: AppHandle) -> Result<SystemPromptTemplate, String> {
    prompts::reset_help_me_reply_template(&app)
}

#[tauri::command]
pub fn reset_help_me_reply_conversational_template(
    app: AppHandle,
) -> Result<SystemPromptTemplate, String> {
    prompts::reset_help_me_reply_conversational_template(&app)
}

#[tauri::command]
pub fn reset_avatar_generation_template(app: AppHandle) -> Result<SystemPromptTemplate, String> {
    prompts::reset_avatar_generation_template(&app)
}

#[tauri::command]
pub fn reset_avatar_edit_template(app: AppHandle) -> Result<SystemPromptTemplate, String> {
    prompts::reset_avatar_edit_template(&app)
}

#[tauri::command]
pub fn reset_scene_generation_template(app: AppHandle) -> Result<SystemPromptTemplate, String> {
    prompts::reset_scene_generation_template(&app)
}

#[tauri::command]
pub fn get_required_template_variables(template_id: String) -> Vec<String> {
    prompts::get_required_variables(&template_id)
}

#[tauri::command]
pub fn validate_template_variables(
    template_id: String,
    content: String,
    entries: Option<Vec<SystemPromptEntry>>,
) -> Result<(), String> {
    let validation_text = if let Some(entries) = entries {
        if entries.is_empty() {
            content
        } else {
            entries
                .iter()
                .map(|entry| entry.content.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        }
    } else {
        content
    };
    prompts::validate_required_variables(&template_id, &validation_text)
        .map_err(|missing| format!("Missing required variables: {}", missing.join(", ")))
}

// Deprecated: get_applicable_prompts_for_* commands removed in favor of global list on client

// ==================== Prompt Preview Command ====================

#[tauri::command]
pub fn render_prompt_preview(
    app: AppHandle,
    content: String,
    character_id: String,
    session_id: Option<String>,
    persona_id: Option<String>,
) -> Result<String, String> {
    let context = super::service::ChatContext::initialize(app.clone())?;
    let settings = &context.settings;

    let character = context.find_character(&character_id)?;

    // Load session if provided, otherwise synthesize a minimal one
    let session: Session = if let Some(sid) = session_id.as_ref() {
        context
            .load_session(sid)
            .and_then(|opt| opt.ok_or_else(|| "Session not found".to_string()))?
    } else {
        // Minimal ephemeral session for preview
        let now = now_millis()?;
        Session {
            id: "preview".to_string(),
            character_id: character.id.clone(),
            title: "Preview".to_string(),
            system_prompt: None,
            selected_scene_id: None,
            prompt_template_id: None,
            persona_id: None,
            persona_disabled: false,
            voice_autoplay: None,
            advanced_model_settings: None,
            messages: vec![],
            archived: false,
            created_at: now,
            updated_at: now,
            memory_status: None,
            memory_error: None,
            memories: vec![
                "Memory 1 (Preview): The user prefers direct communication.".to_string(),
                "Memory 2 (Preview): We met in the tavern last night.".to_string(),
            ],
            memory_embeddings: vec![],
            memory_summary: Some("This is a placeholder for the context summary that will be generated by the AI based on your conversation history.".to_string()),
            memory_summary_token_count: 0,
            memory_tool_events: vec![],
        }
    };

    let effective_persona_id = resolve_persona_id(&session, persona_id.as_deref());
    let persona = context.choose_persona(effective_persona_id);

    let rendered =
        prompt_engine::render_with_context(&app, &content, &character, persona, &session, settings);
    Ok(rendered)
}

#[tauri::command]
pub async fn retry_dynamic_memory(
    app: AppHandle,
    session_id: String,
    model_id: Option<String>,
    update_default: Option<bool>,
) -> Result<(), String> {
    super::memory::flow::retry_dynamic_memory(app, session_id, model_id, update_default).await
}

#[tauri::command]
pub async fn trigger_dynamic_memory(app: AppHandle, session_id: String) -> Result<(), String> {
    super::memory::flow::trigger_dynamic_memory(app, session_id).await
}

#[tauri::command]
pub fn abort_dynamic_memory(app: AppHandle, session_id: String) -> Result<(), String> {
    super::memory::flow::abort_dynamic_memory(app, session_id)
}

#[tauri::command]
pub async fn chat_add_message_attachment(
    app: AppHandle,
    args: ChatAddMessageAttachmentArgs,
) -> Result<StoredMessage, String> {
    let ChatAddMessageAttachmentArgs {
        session_id,
        character_id,
        message_id,
        role,
        attachment_id,
        base64_data,
        mime_type,
        filename,
        width,
        height,
    } = args;

    if base64_data.trim().is_empty() {
        return Err(crate::utils::err_msg(
            module_path!(),
            line!(),
            "base64Data cannot be empty",
        ));
    }

    let mut session = super::storage::load_session(&app, &session_id)?
        .ok_or_else(|| "Session not found".to_string())?;

    let target_index = session
        .messages
        .iter()
        .position(|m| m.id == message_id)
        .ok_or_else(|| "Message not found in loaded session window".to_string())?;

    let new_attachment = persist_attachments(
        &app,
        &character_id,
        &session_id,
        &message_id,
        &role,
        vec![ImageAttachment {
            id: attachment_id,
            data: base64_data,
            mime_type,
            filename,
            width,
            height,
            storage_path: None,
        }],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| "Failed to persist attachment".to_string())?;

    let updated_message = {
        let target = &mut session.messages[target_index];
        if let Some(existing) = target
            .attachments
            .iter_mut()
            .find(|att| att.id == new_attachment.id)
        {
            *existing = new_attachment;
        } else {
            target.attachments.push(new_attachment);
        }
        target.clone()
    };

    session.updated_at = now_millis()?;

    // Persist meta + the updated message (even if it's not the last message).
    let mut meta = session.clone();
    meta.messages = Vec::new();
    session_upsert_meta_typed(&app, &meta)?;
    messages_upsert_batch_typed(&app, &session_id, std::slice::from_ref(&updated_message))?;

    Ok(updated_message)
}

#[tauri::command]
pub async fn chat_generate_scene_image(
    app: AppHandle,
    args: ChatGenerateSceneImageArgs,
) -> Result<StoredMessage, String> {
    super::scene::chat_generate_scene_image(app, args).await
}

#[tauri::command]
pub async fn chat_generate_scene_prompt(
    app: AppHandle,
    args: ChatGenerateScenePromptArgs,
) -> Result<String, String> {
    super::scene::chat_generate_scene_prompt(app, args).await
}

#[tauri::command]
pub async fn search_messages(
    app: AppHandle,
    session_id: String,
    query: String,
) -> Result<Vec<super::types::MessageSearchResult>, String> {
    let context = ChatContext::initialize(app.clone())?;

    let session = match context.load_session(&session_id)? {
        Some(s) => s,
        None => {
            return Err(crate::utils::err_msg(
                module_path!(),
                line!(),
                "Session not found",
            ))
        }
    };

    let query_lower = query.to_lowercase();
    let results: Vec<super::types::MessageSearchResult> = session
        .messages
        .iter()
        .filter(|msg| {
            msg.content.to_lowercase().contains(&query_lower)
                && (msg.role == "user" || msg.role == "assistant")
        })
        .map(|msg| super::types::MessageSearchResult {
            message_id: msg.id.clone(),
            content: msg.content.clone(),
            created_at: msg.created_at,
            role: msg.role.clone(),
        })
        .collect();

    Ok(results)
}

#[tauri::command]
pub async fn chat_generate_user_reply(
    app: AppHandle,
    session_id: String,
    current_draft: Option<String>,
    request_id: Option<String>,
    swap_places: Option<bool>,
) -> Result<String, String> {
    let swap_places = role_swap_enabled(swap_places);
    log_info(
        &app,
        "help_me_reply",
        format!(
            "Generating user reply for session={}, has_draft={}, swap_places={}",
            &session_id,
            current_draft.is_some(),
            swap_places
        ),
    );
    let context = ChatContext::initialize(app.clone())?;
    let settings = &context.settings;

    // Check if help me reply is enabled
    if let Some(advanced) = &settings.advanced_settings {
        if advanced.help_me_reply_enabled == Some(false) {
            return Err(crate::utils::err_msg(
                module_path!(),
                line!(),
                "Help Me Reply is disabled in settings",
            ));
        }
    }

    let session = match context.load_session(&session_id)? {
        Some(s) => s,
        None => {
            return Err(crate::utils::err_msg(
                module_path!(),
                line!(),
                "Session not found",
            ))
        }
    };

    let character = context.find_character(&session.character_id)?;
    let persona = context.choose_persona(resolve_persona_id(&session, None));
    let (prompt_character, prompt_persona) = if swap_places {
        swapped_prompt_entities(&character, persona)
    } else {
        (character.clone(), persona.cloned())
    };

    let recent_msgs = recent_messages(&session, 10);

    if recent_msgs.is_empty() {
        return Err(crate::utils::err_msg(
            module_path!(),
            line!(),
            "No conversation history to base reply on",
        ));
    }

    // Use help me reply model if configured, otherwise fall back to default
    let model_id = settings
        .advanced_settings
        .as_ref()
        .and_then(|advanced| advanced.help_me_reply_model_id.as_ref())
        .or(settings.default_model_id.as_ref())
        .ok_or_else(|| "No model configured for Help Me Reply".to_string())?;

    let model = settings
        .models
        .iter()
        .find(|m| &m.id == model_id)
        .ok_or_else(|| "Help Me Reply model not found".to_string())?;

    let provider_cred = resolve_provider_credential_for_model(settings, model)
        .ok_or_else(|| "Provider credential not found".to_string())?;

    let api_key = resolve_api_key(&app, provider_cred, "help_me_reply")?;

    // Get reply style from settings (default to roleplay)
    let reply_style = settings
        .advanced_settings
        .as_ref()
        .and_then(|advanced| advanced.help_me_reply_style.as_ref())
        .map(|s| s.as_str())
        .unwrap_or("roleplay");

    let base_prompt = prompts::get_help_me_reply_prompt(&app, reply_style);

    // Get max tokens from settings (default to 150)
    let max_tokens = settings
        .advanced_settings
        .as_ref()
        .and_then(|advanced| advanced.help_me_reply_max_tokens)
        .unwrap_or(150) as u32;

    // Get streaming setting (default to true)
    let streaming_enabled = settings
        .advanced_settings
        .as_ref()
        .and_then(|advanced| advanced.help_me_reply_streaming)
        .unwrap_or(true);

    let char_name = &prompt_character.name;
    let char_desc = prompt_character
        .definition
        .as_deref()
        .or(prompt_character.description.as_deref())
        .unwrap_or("");
    let persona_name = prompt_persona
        .as_ref()
        .map(|p| p.title.as_str())
        .unwrap_or("User");
    let persona_desc = prompt_persona
        .as_ref()
        .map(|p| p.description.as_str())
        .unwrap_or("");

    let mut system_prompt = base_prompt;
    system_prompt = system_prompt.replace("{{char.name}}", char_name);
    system_prompt = system_prompt.replace("{{char.desc}}", char_desc);
    system_prompt = system_prompt.replace("{{persona.name}}", persona_name);
    system_prompt = system_prompt.replace("{{persona.desc}}", persona_desc);
    system_prompt = system_prompt.replace("{{user.name}}", persona_name);
    system_prompt = system_prompt.replace("{{user.desc}}", persona_desc);
    let draft_str = current_draft.as_deref().unwrap_or("");
    system_prompt = system_prompt.replace("{{current_draft}}", draft_str);
    // Legacy placeholders
    system_prompt = system_prompt.replace("{{char}}", char_name);
    system_prompt = system_prompt.replace("{{persona}}", persona_name);
    system_prompt = system_prompt.replace("{{user}}", persona_name);

    if let Some(ref draft) = current_draft {
        if !draft.trim().is_empty() {
            system_prompt = system_prompt.replace("{{#if current_draft}}", "");
            system_prompt = system_prompt.replace("{{current_draft}}", draft);
            if let Some(else_start) = system_prompt.find("{{else}}") {
                if let Some(endif_start) = system_prompt[else_start..].find("{{/if}}") {
                    system_prompt.replace_range(else_start..(else_start + endif_start + 7), "");
                }
            }
            system_prompt = system_prompt.replace("{{/if}}", "");
        } else {
            remove_if_block(&mut system_prompt);
        }
    } else {
        remove_if_block(&mut system_prompt);
    }

    let (effective_user_name, effective_assistant_name) =
        help_me_reply_participant_names(&prompt_character, prompt_persona.as_ref());

    let conversation_context = recent_msgs
        .iter()
        .map(|msg| {
            let effective_role = if swap_places {
                swap_role_for_api(msg.role.as_str())
            } else {
                msg.role.as_str()
            };
            let role_label = if effective_role == "user" {
                effective_user_name
            } else {
                effective_assistant_name
            };
            format!("{}: {}", role_label, msg.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let user_prompt = format!(
        "Here is the recent conversation:\n\n{}\n\nGenerate a reply for {} to say next.",
        conversation_context, effective_user_name
    );

    let messages_for_api: Vec<Value> = vec![
        json!({ "role": "system", "content": system_prompt }),
        json!({ "role": "user", "content": user_prompt }),
    ];

    let (request_settings, extra_body_fields) = prepare_sampling_request(
        &provider_cred.provider_id,
        &session,
        model,
        settings,
        max_tokens,
        0.8,
        1.0,
        None,
        None,
        None,
    );
    let built = super::request_builder::build_chat_request(
        provider_cred,
        &api_key,
        &model.name,
        &messages_for_api,
        None,
        request_settings.temperature,
        request_settings.top_p,
        request_settings.max_tokens,
        request_settings.context_length,
        streaming_enabled,
        request_id.clone(),
        request_settings.frequency_penalty,
        request_settings.presence_penalty,
        request_settings.top_k,
        None,
        request_settings.reasoning_enabled,
        request_settings.reasoning_effort.clone(),
        request_settings.reasoning_budget,
        extra_body_fields,
    );

    log_info(
        &app,
        "help_me_reply",
        format!("Sending request to {}", built.url),
    );

    let api_request_payload = ApiRequest {
        url: built.url,
        method: Some("POST".into()),
        headers: Some(built.headers),
        query: None,
        body: Some(built.body),
        timeout_ms: Some(60_000),
        stream: Some(streaming_enabled),
        request_id: request_id.clone(),
        provider_id: Some(provider_cred.provider_id.clone()),
    };

    let api_response = api_request(app.clone(), api_request_payload).await?;

    if !api_response.ok {
        return Err(format!(
            "API request failed with status {}",
            api_response.status
        ));
    }

    let generated_text = extract_text(&api_response.data, Some(&provider_cred.provider_id))
        .ok_or_else(|| "Failed to extract text from response".to_string())?;

    let cleaned = generated_text
        .trim()
        .trim_matches('"')
        .trim_start_matches(&format!("{}:", effective_user_name))
        .trim()
        .to_string();

    log_info(
        &app,
        "help_me_reply",
        format!("Generated reply: {} chars", cleaned.len()),
    );

    let usage = super::sse::usage_from_value(&api_response.data);
    super::service::record_usage_if_available(
        &context,
        &usage,
        &session,
        &prompt_character,
        &model,
        &provider_cred,
        &api_key,
        now_millis().unwrap_or(0),
        UsageOperationType::ReplyHelper,
        "help_me_reply",
    )
    .await;

    Ok(cleaned)
}

/// Helper to remove {{#if current_draft}}...{{else}}...{{/if}} and keep else content
fn remove_if_block(prompt: &mut String) {
    if let Some(if_start) = prompt.find("{{#if current_draft}}") {
        if let Some(else_pos) = prompt.find("{{else}}") {
            prompt.replace_range(if_start..(else_pos + 8), "");
        }
    }
    *prompt = prompt.replace("{{/if}}", "");
}

#[cfg(test)]
mod tests {
    use super::{help_me_reply_participant_names, swapped_prompt_entities};
    use crate::chat_manager::types::{Character, Persona};

    fn make_character() -> Character {
        Character {
            id: "char-1".to_string(),
            name: "Astra".to_string(),
            avatar_path: None,
            design_description: None,
            design_reference_image_ids: Vec::new(),
            background_image_path: None,
            definition: Some("A starship captain".to_string()),
            description: Some("Commanding and curious".to_string()),
            rules: Vec::new(),
            scenes: Vec::new(),
            default_scene_id: None,
            default_model_id: None,
            fallback_model_id: None,
            memory_type: "manual".to_string(),
            prompt_template_id: None,
            system_prompt: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn make_persona() -> Persona {
        Persona {
            id: "persona-1".to_string(),
            title: "Milo".to_string(),
            description: "A reckless smuggler".to_string(),
            nickname: None,
            avatar_path: None,
            design_description: None,
            design_reference_image_ids: Vec::new(),
            is_default: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn help_me_reply_names_match_unswapped_prompt_entities() {
        let character = make_character();
        let persona = make_persona();

        let (effective_user_name, effective_assistant_name) =
            help_me_reply_participant_names(&character, Some(&persona));

        assert_eq!(effective_user_name, "Milo");
        assert_eq!(effective_assistant_name, "Astra");
    }

    #[test]
    fn help_me_reply_names_follow_swapped_prompt_entities() {
        let character = make_character();
        let persona = make_persona();
        let (prompt_character, prompt_persona) =
            swapped_prompt_entities(&character, Some(&persona));

        let (effective_user_name, effective_assistant_name) =
            help_me_reply_participant_names(&prompt_character, prompt_persona.as_ref());

        assert_eq!(effective_user_name, "Astra");
        assert_eq!(effective_assistant_name, "Milo");
    }
}
