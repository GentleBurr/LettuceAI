use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

#[derive(Debug)]
pub struct AbortHandle {
    tx: Option<oneshot::Sender<()>>,
}

impl AbortHandle {
    pub fn new(tx: oneshot::Sender<()>) -> Self {
        Self { tx: Some(tx) }
    }

    pub fn abort(&mut self) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(());
        }
    }
}

#[derive(Default)]
struct AbortRegistryState {
    handles: HashMap<String, Vec<AbortHandle>>,
    aborted: HashSet<String>,
}

#[derive(Clone)]
pub struct AbortRegistry {
    inner: Arc<Mutex<AbortRegistryState>>,
}

impl AbortRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(AbortRegistryState::default())),
        }
    }

    pub fn register(&self, request_id: String) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        let handle = AbortHandle::new(tx);

        if let Ok(mut state) = self.inner.lock() {
            state.aborted.remove(&request_id);
            state.handles.entry(request_id).or_default().push(handle);
        }

        rx
    }

    pub fn abort(&self, request_id: &str) -> Result<(), String> {
        if let Ok(mut state) = self.inner.lock() {
            state.aborted.insert(request_id.to_string());
            if let Some(handles) = state.handles.remove(request_id) {
                for mut handle in handles {
                    handle.abort();
                }
            }
            Ok(())
        } else {
            Err(crate::utils::err_msg(
                module_path!(),
                line!(),
                "Failed to acquire lock on abort registry",
            ))
        }
    }

    pub fn unregister(&self, request_id: &str) {
        if let Ok(mut state) = self.inner.lock() {
            let remove_entry = if let Some(handles) = state.handles.get_mut(request_id) {
                handles.pop();
                handles.is_empty()
            } else {
                false
            };
            if remove_entry {
                state.handles.remove(request_id);
            }
        }
    }

    pub fn take_aborted(&self, request_id: &str) -> bool {
        if let Ok(mut state) = self.inner.lock() {
            state.aborted.remove(request_id)
        } else {
            false
        }
    }

    pub fn abort_all(&self) {
        if let Ok(mut state) = self.inner.lock() {
            let pending: Vec<(String, Vec<AbortHandle>)> = state.handles.drain().collect();
            for (request_id, handles) in pending {
                state.aborted.insert(request_id);
                for mut handle in handles {
                    handle.abort();
                }
            }
        }
    }

    #[allow(dead_code)]
    pub fn is_registered(&self, request_id: &str) -> bool {
        if let Ok(state) = self.inner.lock() {
            state
                .handles
                .get(request_id)
                .map(|handles| !handles.is_empty())
                .unwrap_or(false)
        } else {
            false
        }
    }
}

impl Default for AbortRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use tokio::sync::oneshot::error::TryRecvError;

    use super::AbortRegistry;

    #[test]
    fn nested_registration_keeps_existing_receiver_alive() {
        let registry = AbortRegistry::new();
        let mut outer_rx = registry.register("req-1".to_string());
        let _inner_rx = registry.register("req-1".to_string());

        assert!(matches!(outer_rx.try_recv(), Err(TryRecvError::Empty)));
        assert!(registry.is_registered("req-1"));
    }

    #[test]
    fn abort_cancels_all_receivers_for_request_id() {
        let registry = AbortRegistry::new();
        let mut outer_rx = registry.register("req-1".to_string());
        let mut inner_rx = registry.register("req-1".to_string());

        registry.abort("req-1").expect("abort should succeed");

        assert!(matches!(outer_rx.try_recv(), Ok(())));
        assert!(matches!(inner_rx.try_recv(), Ok(())));
        assert!(!registry.is_registered("req-1"));
    }
}
