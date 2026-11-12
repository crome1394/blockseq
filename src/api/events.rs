//! Live updates: server-sent events to every open tab, at most
//! `MAX_EVENT_SUBSCRIBERS` streams.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use tokio::sync::oneshot;
use tokio_stream::Stream;
use tokio_stream::wrappers::BroadcastStream;

use super::{Shared};

/// How many live-update streams one process keeps. Each open tab is one.
/// A connection past this closes the oldest stream. That stream first gets a
/// `replaced` event, and its tab stays disconnected until it is shown again,
/// so tabs beyond the cap do not keep pushing each other off.
pub const MAX_EVENT_SUBSCRIBERS: usize = 32;

/// Open server-sent-event streams, oldest first.
pub struct EventSubs {
    cap: usize,
    next: AtomicU64,
    open: Mutex<VecDeque<(u64, oneshot::Sender<()>)>>,
}

struct EventPermit {
    id: u64,
    subs: Arc<EventSubs>,
}

impl Drop for EventPermit {
    fn drop(&mut self) {
        self.subs.release(self.id);
    }
}

impl EventSubs {
    pub const fn new(cap: usize) -> Self {
        Self { cap, next: AtomicU64::new(1), open: Mutex::new(VecDeque::new()) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<(u64, oneshot::Sender<()>)>> {
        self.open.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Registers this connection and, when over the cap, tells the oldest to end.
    fn admit(self: &Arc<Self>) -> (EventPermit, oneshot::Receiver<()>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        let mut open = self.lock();
        open.push_back((id, tx));
        while open.len() > self.cap {
            if let Some((_, old)) = open.pop_front() {
                // The receiver sees this and ends its stream. It no longer counts.
                let _ = old.send(());
            }
        }
        drop(open);
        (EventPermit { id, subs: Arc::clone(self) }, rx)
    }

    fn release(&self, id: u64) {
        self.lock().retain(|(n, _)| *n != id);
    }
}

/// Ends when the hub closes this subscriber, and turns a lagged broadcast
/// into a resync the same way an uncapped stream did.
struct CappedEvents {
    live: BroadcastStream<String>,
    close: oneshot::Receiver<()>,
    /// The `replaced` event was sent; the stream ends next.
    replaced: bool,
    _permit: EventPermit,
}

impl Stream for CappedEvents {
    type Item = Result<Event, Infallible>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.replaced {
            return Poll::Ready(None);
        }
        if Pin::new(&mut this.close).poll(cx).is_ready() {
            // Tell the tab why, so it does not reconnect straight away.
            this.replaced = true;
            return Poll::Ready(Some(Ok(Event::default().data(r#"{"type":"replaced"}"#))));
        }
        match Pin::new(&mut this.live).poll_next(cx) {
            // A client that fell behind is told to reload everything it shows.
            Poll::Ready(Some(msg)) => {
                let data = msg.unwrap_or_else(|_| r#"{"type":"resync"}"#.to_string());
                Poll::Ready(Some(Ok(Event::default().data(data))))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Server-sent events: tells other open tabs and devices when something changes.
pub async fn events(State(s): Shared) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let (permit, close) = s.event_subs.admit();
    let stream = CappedEvents { live: BroadcastStream::new(s.events.subscribe()), close, replaced: false, _permit: permit };
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_stream::StreamExt;

    fn still_open(rx: &mut oneshot::Receiver<()>) -> bool {
        matches!(rx.try_recv(), Err(oneshot::error::TryRecvError::Empty))
    }

    #[test]
    fn event_subscribers_close_the_oldest_at_the_cap() {
        let subs = Arc::new(EventSubs::new(2));
        let (_a, mut a_rx) = subs.admit();
        let (b, mut b_rx) = subs.admit();
        assert!(still_open(&mut a_rx));
        assert!(still_open(&mut b_rx));
        let (_c, mut c_rx) = subs.admit();
        assert!(a_rx.try_recv().is_ok());
        assert!(still_open(&mut b_rx));
        assert!(still_open(&mut c_rx));

        // A disconnect frees its slot, so the next connection does not close anyone.
        drop(b);
        let (_d, mut d_rx) = subs.admit();
        assert!(still_open(&mut c_rx));
        assert!(still_open(&mut d_rx));
        let _e = subs.admit();
        assert!(c_rx.try_recv().is_ok());
        assert!(still_open(&mut d_rx));
    }

    #[tokio::test]
    async fn a_closed_event_stream_ends_and_a_lag_is_still_a_resync() {
        let (tx, rx) = tokio::sync::broadcast::channel(1);
        let subs = Arc::new(EventSubs::new(4));
        let (permit, close) = subs.admit();
        let mut stream = CappedEvents { live: BroadcastStream::new(rx), close, replaced: false, _permit: permit };
        tx.send("{\"type\":\"page\"}".to_string()).unwrap();
        assert!(stream.next().await.unwrap().is_ok());
        // The channel holds one message, so the second send reports a lag.
        tx.send("lost".to_string()).unwrap();
        tx.send("kept".to_string()).unwrap();
        let lagged = stream.next().await.unwrap().unwrap();
        assert!(format!("{lagged:?}").contains("resync"));

        let one = Arc::new(EventSubs::new(1));
        let (old, old_rx) = one.admit();
        let mut old_stream = CappedEvents {
            live: BroadcastStream::new(tx.subscribe()),
            close: old_rx,
            replaced: false,
            _permit: old,
        };
        let _newer = one.admit();
        // The pushed-off tab is told why, then the stream ends.
        let last = old_stream.next().await.unwrap().unwrap();
        assert!(format!("{last:?}").contains("replaced"));
        assert!(old_stream.next().await.is_none());
    }
}
