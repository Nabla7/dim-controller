//! Backend → page (Desktop's docs/events.md): every event for the pages goes out on zenoh, on this app's frontend topic
//! `events` (`<DIMOS_APP.zenohPrefix>/frontend/events`), where the page's one zenoh-gateway connection hears it. This
//! server links zenoh, so it publishes there itself (on the recorder's session, opened at start); when that session
//! can't be opened it sends the same JSON through Desktop's relay (`POST /gateways/desktop/ui/apps/<name>/frontend/events`). One task
//! sends them, in order.
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

pub const EVENTS_TOPIC: &str = "events";

/// `<prefix>/frontend/<topic>`
pub fn frontend_key(prefix: &str, topic: &str) -> String {
    format!("{}/frontend/{topic}", prefix.trim_end_matches('/'))
}

/// Forwards every event on `events` to the pages until the channel closes. `prefix` = DIMOS_APP's zenohPrefix (no
/// prefix: nothing is published, there is no Desktop to hear it); `relay` = (desktopUrl, name) for the fallback.
pub fn spawn(
    events: &broadcast::Sender<Value>,
    recorder: Arc<crate::recorder::State>,
    prefix: Option<String>,
    relay: Option<(String, String)>,
) {
    let Some(prefix) = prefix.filter(|prefix| !prefix.is_empty()) else {
        eprintln!("controller: no zenohPrefix in DIMOS_APP (not under a Desktop with zenoh events); page events go nowhere");
        return;
    };
    let mut receiver = events.subscribe();
    let (sender, mut queue) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        loop {
            match receiver.recv().await {
                Ok(event) => {
                    if sender.send(event).is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    eprintln!("controller: {skipped} page events skipped (slow publisher)")
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    tokio::spawn(async move {
        let key = frontend_key(&prefix, EVENTS_TOPIC);
        let session = match recorder.session().await {
            Ok(session) => Some(session),
            Err(error) => {
                eprintln!("controller: no zenoh session ({error}); page events go through Desktop's relay");
                None
            }
        };
        let mut warned = false;
        while let Some(event) = queue.recv().await {
            let sent = match &session {
                Some(session) => session
                    .put(&key, event.to_string())
                    .encoding(zenoh::bytes::Encoding::APPLICATION_JSON)
                    .await
                    .map_err(|error| anyhow::anyhow!("{error}")),
                None => match &relay {
                    Some((base, name)) => crate::desktop::post(
                        base,
                        &format!("/gateways/desktop/ui/apps/{name}/frontend/{EVENTS_TOPIC}"),
                        &event,
                    )
                    .await
                    .map(|_| ()),
                    None => Err(anyhow::anyhow!("no Desktop URL")),
                },
            };
            if let Err(error) = sent {
                if !warned {
                    eprintln!("controller: couldn't publish a page event on {key}: {error}");
                    warned = true;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_under_the_prefix() {
        assert_eq!(
            frontend_key("ns/apps/dim-controller", "events"),
            "ns/apps/dim-controller/frontend/events"
        );
        assert_eq!(
            frontend_key("ns/apps/c/", "events"),
            "ns/apps/c/frontend/events"
        );
    }

    /// Events reach a zenoh subscriber on the frontend key, in order, as JSON.
    #[tokio::test(flavor = "multi_thread")]
    async fn publishes_events_in_order_on_zenoh() {
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let locator = format!("tcp/127.0.0.1:{port}");
        let mut config = zenoh::Config::default();
        config
            .insert_json5("listen/endpoints", &format!(r#"["{locator}"]"#))
            .unwrap();
        config
            .insert_json5("scouting/multicast/enabled", "false")
            .unwrap();
        let listener = zenoh::open(config).await.unwrap();
        let subscriber = listener
            .declare_subscriber("test-ns/apps/c/frontend/**")
            .await
            .unwrap();
        let recorder = Arc::new(crate::recorder::State::new(std::env::temp_dir(), locator));
        let (events, _) = broadcast::channel(16);
        spawn(&events, recorder, Some("test-ns/apps/c".into()), None);
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        for n in 0..3 {
            events
                .send(serde_json::json!({ "type": "annotations", "n": n }))
                .unwrap();
        }
        for n in 0..3 {
            let sample =
                tokio::time::timeout(std::time::Duration::from_secs(5), subscriber.recv_async())
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(sample.key_expr().as_str(), "test-ns/apps/c/frontend/events");
            let event: Value = serde_json::from_slice(&sample.payload().to_bytes()).unwrap();
            assert_eq!(event["n"], n);
        }
    }
}
