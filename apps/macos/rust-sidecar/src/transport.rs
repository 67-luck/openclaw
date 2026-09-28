//! One acknowledged message each way; IPC demultiplexing never waits for Gateway consumption.
use base64::{display::Base64Display, engine::general_purpose::STANDARD, Engine as _};
use futures_util::{Sink, Stream};
use openclaw_gateway_client::{
    ClientError, GatewayWebSocket, GatewayWebSocketConnector, WebSocketError, WebSocketMessage,
    WebSocketRequest,
};
use serde::{Serialize, Serializer};
use serde_json::{json, Value};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};
use tokio::sync::{mpsc, oneshot};

type Acknowledgement = Arc<Mutex<Option<(u64, oneshot::Sender<bool>)>>>;

#[derive(Serialize)]
pub struct TransportWrite(
    &'static str,
    u64,
    &'static str,
    // A closed tuple lets the native decoder consume every field and decode base64
    // directly to Data, without constructing a second full-sized string.
    #[serde(serialize_with = "serialize_message_bytes")] WebSocketMessage,
);

fn serialize_message_bytes<S: Serializer>(
    message: &WebSocketMessage,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let bytes: &[u8] = match message {
        WebSocketMessage::Text(text) => text.as_bytes(),
        WebSocketMessage::Binary(bytes) => bytes,
        // Native control messages carry no data; URLSession owns their wire payload.
        _ => &[],
    };
    // Stream the existing engine's bounded chunks into the authenticated frame.
    // Materializing a base64 String would add another 33 MiB allocation per media result.
    serializer.collect_str(&Base64Display::new(bytes, &STANDARD))
}

pub struct NativeTransport {
    incoming: mpsc::Receiver<WebSocketMessage>,
    outgoing: mpsc::Sender<TransportWrite>,
    receipts: mpsc::Sender<Value>,
    acknowledgement: Acknowledgement,
    pending: Option<oneshot::Receiver<bool>>,
    pong: Option<(WebSocketMessage, oneshot::Receiver<bool>)>,
    pong_acknowledgement: Acknowledgement,
    sequence: u64,
}

pub struct NativeTransportInput {
    incoming: mpsc::Sender<WebSocketMessage>,
    acknowledgement: Acknowledgement,
    pong_acknowledgement: Acknowledgement,
}

impl NativeTransport {
    pub fn new(
        outgoing: mpsc::Sender<TransportWrite>,
        receipts: mpsc::Sender<Value>,
    ) -> (Self, NativeTransportInput) {
        let (incoming_tx, incoming) = mpsc::channel(1);
        let acknowledgement = Arc::new(Mutex::new(None));
        let pong_acknowledgement = Arc::new(Mutex::new(None));
        (
            Self {
                incoming,
                outgoing,
                receipts,
                acknowledgement: acknowledgement.clone(),
                pending: None,
                pong: None,
                pong_acknowledgement: pong_acknowledgement.clone(),
                sequence: 0,
            },
            NativeTransportInput {
                incoming: incoming_tx,
                acknowledgement,
                pong_acknowledgement,
            },
        )
    }
}

impl NativeTransportInput {
    pub fn receive(&self, kind: &str, data: &str) -> Result<(), &'static str> {
        if data.len() > super::GATEWAY_PAYLOAD_LIMIT.div_ceil(3) * 4 {
            return Err("transport frame too large");
        }
        let data = STANDARD
            .decode(data)
            .map_err(|_| "invalid transport bytes")?;
        if data.len() > super::GATEWAY_PAYLOAD_LIMIT {
            return Err("transport frame too large");
        }
        let message = match kind {
            "text" => WebSocketMessage::Text(
                String::from_utf8(data)
                    .map_err(|_| "invalid text frame")?
                    .into(),
            ),
            "binary" => WebSocketMessage::Binary(data.into()),
            _ => return Err("invalid transport message kind"),
        };
        self.incoming
            .try_send(message)
            .map_err(|_| "unacknowledged transport frame")
    }

    pub fn acknowledge(&self, id: u64, ok: bool) -> Result<(), &'static str> {
        acknowledge(&self.acknowledgement, id, ok)
    }

    pub fn pong(&self, id: u64, ok: bool) -> Result<(), &'static str> {
        acknowledge(&self.pong_acknowledgement, id, ok)
    }
}

impl Drop for NativeTransportInput {
    fn drop(&mut self) {
        self.acknowledgement.lock().unwrap().take();
        self.pong_acknowledgement.lock().unwrap().take();
    }
}

fn acknowledge(slot: &Acknowledgement, id: u64, ok: bool) -> Result<(), &'static str> {
    let (expected, reply) = slot
        .lock()
        .unwrap()
        .take()
        .ok_or("unexpected transport receipt")?;
    if expected != id {
        return Err("transport receipt mismatch");
    }
    reply.send(ok).map_err(|_| "transport closed")
}

fn closed() -> WebSocketError {
    WebSocketError::ConnectionClosed
}

impl Stream for NativeTransport {
    type Item = Result<WebSocketMessage, WebSocketError>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if let Some((_, receipt)) = self.pong.as_mut() {
            match Pin::new(receipt).poll(cx) {
                Poll::Ready(Ok(true)) => {
                    let (pong, _) = self.pong.take().unwrap();
                    return Poll::Ready(Some(Ok(pong)));
                }
                Poll::Ready(_) => {
                    self.pong = None;
                    return Poll::Ready(Some(Err(closed())));
                }
                Poll::Pending => {}
            }
        }
        match self.incoming.poll_recv(cx) {
            Poll::Ready(Some(message)) => {
                // The native peer cannot read its next network message before this receipt.
                if self
                    .receipts
                    .try_send(json!({"type":"transport-received"}))
                    .is_err()
                {
                    return Poll::Ready(Some(Err(closed())));
                }
                Poll::Ready(Some(Ok(message)))
            }
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Sink<WebSocketMessage> for NativeTransport {
    type Error = WebSocketError;
    fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.poll_flush(cx)
    }
    fn start_send(mut self: Pin<&mut Self>, message: WebSocketMessage) -> Result<(), Self::Error> {
        if self.pending.is_some() {
            return Err(closed());
        }
        let (kind, pong) = match &message {
            message @ (WebSocketMessage::Text(_) | WebSocketMessage::Binary(_)) => {
                let kind = if message.is_text() { "text" } else { "binary" };
                if message.len() > super::GATEWAY_PAYLOAD_LIMIT {
                    return Err(closed());
                }
                (kind, None)
            }
            WebSocketMessage::Ping(bytes) => {
                if self.pong.is_some() {
                    return Err(closed());
                }
                ("ping", Some(WebSocketMessage::Pong(bytes.clone())))
            }
            WebSocketMessage::Close(_) => ("close", None),
            // URLSession owns unsolicited WebSocket ping/pong responses.
            WebSocketMessage::Pong(_) => return Ok(()),
            _ => return Err(closed()),
        };
        self.sequence = self.sequence.checked_add(1).ok_or_else(closed)?;
        if let Some(pong) = pong {
            let (reply, receipt) = oneshot::channel();
            *self.pong_acknowledgement.lock().unwrap() = Some((self.sequence, reply));
            self.pong = Some((pong, receipt));
        }
        let (reply, receive) = oneshot::channel();
        *self.acknowledgement.lock().unwrap() = Some((self.sequence, reply));
        self.pending = Some(receive);
        let frame = TransportWrite("transport-send", self.sequence, kind, message);
        self.outgoing.try_send(frame).map_err(|_| closed())
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        let Some(pending) = self.pending.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        match Pin::new(pending).poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Ok(true)) => {
                self.pending = None;
                // Flush confirms native submission, never remote Pong. Waiting for Pong here
                // would prevent reading the inbound frame that lets URLSession observe it.
                Poll::Ready(Ok(()))
            }
            Poll::Ready(_) => {
                self.pending = None;
                Poll::Ready(Err(closed()))
            }
        }
    }
    fn poll_close(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        // Closing the product session retires both the helper and the URLSession task.
        self.incoming.close();
        self.poll_flush(cx)
    }
}

pub struct NativeConnector(Mutex<Option<NativeTransport>>);
impl NativeConnector {
    pub fn new(transport: NativeTransport) -> Self {
        Self(Mutex::new(Some(transport)))
    }
}
impl std::fmt::Debug for NativeConnector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeConnector")
    }
}
impl GatewayWebSocketConnector for NativeConnector {
    fn connect(
        &self,
        _: WebSocketRequest<()>,
        _: usize,
    ) -> futures_util::future::BoxFuture<'static, Result<Box<dyn GatewayWebSocket>, ClientError>>
    {
        let socket = self.0.lock().unwrap().take();
        Box::pin(async move {
            socket
                .map(|socket| Box::new(socket) as Box<dyn GatewayWebSocket>)
                .ok_or_else(|| ClientError::Closed("native transport already consumed".into()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};

    #[tokio::test]
    async fn ping_submission_is_not_a_pong_and_does_not_stop_inbound_messages() {
        let (outgoing, mut writes) = mpsc::channel(1);
        let (receipts, mut acknowledgements) = mpsc::channel(1);
        let (mut socket, native) = NativeTransport::new(outgoing, receipts);
        let mut send = Box::pin(socket.send(WebSocketMessage::Ping(b"ping-1".to_vec().into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        let write = serde_json::to_value(writes.recv().await.unwrap()).unwrap();
        native
            .acknowledge(write[1].as_u64().unwrap(), true)
            .unwrap();
        send.await.unwrap();
        // Submission is not evidence of peer liveness. Stream must await the real Pong.
        assert!(futures_util::poll!(socket.next()).is_pending());
        native
            .receive("text", &STANDARD.encode("tick before pong"))
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "tick before pong"
        );
        acknowledgements.recv().await.unwrap();
        let observed = tokio::spawn(async move { socket.next().await });
        tokio::task::yield_now().await;
        native.pong(write[1].as_u64().unwrap(), true).unwrap();
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(1), observed)
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .unwrap(),
            WebSocketMessage::Pong(b"ping-1".to_vec().into())
        );
    }

    #[tokio::test]
    async fn early_pong_survives_submission_and_other_writes_without_overwriting_correlation() {
        let (outgoing, mut writes) = mpsc::channel(1);
        let (receipts, _acknowledgements) = mpsc::channel(1);
        let (mut socket, native) = NativeTransport::new(outgoing, receipts);
        let mut send = Box::pin(socket.send(WebSocketMessage::Ping(b"first".to_vec().into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        let ping = serde_json::to_value(writes.recv().await.unwrap()).unwrap()[1]
            .as_u64()
            .unwrap();
        native.pong(ping, true).unwrap();
        native.acknowledge(ping, true).unwrap();
        send.await.unwrap();
        let mut send = Box::pin(socket.send(WebSocketMessage::Text("result".into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        let text = serde_json::to_value(writes.recv().await.unwrap()).unwrap()[1]
            .as_u64()
            .unwrap();
        native.acknowledge(text, true).unwrap();
        send.await.unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            WebSocketMessage::Pong(b"first".to_vec().into())
        );
        assert!(native.pong(ping, true).is_err());
    }

    #[tokio::test]
    async fn only_one_ping_can_wait_and_failed_pong_is_not_liveness() {
        let (outgoing, mut writes) = mpsc::channel(1);
        let (receipts, _acknowledgements) = mpsc::channel(1);
        let (mut socket, native) = NativeTransport::new(outgoing, receipts);
        let mut send = Box::pin(socket.send(WebSocketMessage::Ping(b"pending".to_vec().into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        let ping = serde_json::to_value(writes.recv().await.unwrap()).unwrap()[1]
            .as_u64()
            .unwrap();
        native.acknowledge(ping, true).unwrap();
        send.await.unwrap();
        assert!(socket
            .send(WebSocketMessage::Ping(b"duplicate".to_vec().into()))
            .await
            .is_err());
        native.pong(ping, false).unwrap();
        assert!(socket.next().await.unwrap().is_err());
    }

    #[tokio::test]
    async fn duplex_receipts_do_not_wait_for_the_gateway_receive_loop() {
        let (outgoing, mut writes) = mpsc::channel(1);
        let (receipts, mut acknowledgements) = mpsc::channel(1);
        let (mut socket, native) = NativeTransport::new(outgoing, receipts);
        native
            .receive("text", &STANDARD.encode("challenge"))
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "challenge"
        );
        assert_eq!(
            acknowledgements.recv().await.unwrap()["type"],
            "transport-received"
        );
        // The Gateway can answer immediately, before URLSession reports the write complete.
        // Delivering that response must not consume or obstruct the independent write receipt.
        let mut send = Box::pin(socket.send(WebSocketMessage::Text("connect".into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        let write = serde_json::to_value(writes.recv().await.unwrap()).unwrap();
        native.receive("text", &STANDARD.encode("hello")).unwrap();
        native
            .acknowledge(write[1].as_u64().unwrap(), true)
            .unwrap();
        send.await.unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "hello"
        );
    }

    #[tokio::test]
    async fn native_input_is_bounded_and_closure_releases_pending_work() {
        let (outgoing, _writes) = mpsc::channel(1);
        let (receipts, _acknowledgements) = mpsc::channel(1);
        let (mut socket, native) = NativeTransport::new(outgoing, receipts);
        native.receive("text", &STANDARD.encode("one")).unwrap();
        assert!(native.receive("text", &STANDARD.encode("two")).is_err());
        let mut send = Box::pin(socket.send(WebSocketMessage::Text("pending".into())));
        assert!(futures_util::poll!(&mut send).is_pending());
        // EOF from the authenticated native reader retires the sole write acknowledgement.
        drop(native);
        assert!(send.await.is_err());
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_text().unwrap(),
            "one"
        );
        assert!(socket.next().await.is_none());
    }

    #[tokio::test]
    async fn full_gateway_payload_survives_base64_relay_and_oversize_is_rejected() {
        for binary in [false, true] {
            let (outgoing, mut writes) = mpsc::channel(1);
            let (receipts, mut acknowledgements) = mpsc::channel(1);
            let (mut socket, native) = NativeTransport::new(outgoing, receipts);
            let bytes = vec![if binary { 0xff } else { b'/' }; super::super::GATEWAY_PAYLOAD_LIMIT];
            let message = if binary {
                WebSocketMessage::Binary(bytes.clone().into())
            } else {
                WebSocketMessage::Text(String::from_utf8(bytes.clone()).unwrap().into())
            };
            let mut send = Box::pin(socket.send(message));
            assert!(futures_util::poll!(&mut send).is_pending());
            let value = serde_json::to_value(writes.recv().await.unwrap()).unwrap();
            assert!(
                serde_json::to_vec(&value).unwrap().len() + 65
                    <= super::super::FRAME_LIMIT as usize
            );
            let tuple = value
                .as_array()
                .expect("native relay requires a fully decoded tuple");
            assert_eq!(tuple.len(), 4);
            assert_eq!(tuple[0], "transport-send");
            let encoded = tuple[3].as_str().unwrap();
            let kind = if binary { "binary" } else { "text" };
            assert_eq!(tuple[2], kind);
            native.receive(kind, encoded).unwrap();
            native
                .acknowledge(tuple[1].as_u64().unwrap(), true)
                .unwrap();
            send.await.unwrap();
            let received = socket.next().await.unwrap().unwrap();
            assert_eq!(received.is_binary(), binary);
            assert_eq!(received.into_data(), bytes);
            acknowledgements.recv().await.unwrap();
            assert!(native
                .receive(
                    "binary",
                    &STANDARD.encode(vec![0; super::super::GATEWAY_PAYLOAD_LIMIT + 1])
                )
                .is_err());
            native
                .receive("text", &STANDARD.encode("still-alive"))
                .unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap().into_text().unwrap(),
                "still-alive"
            );
        }
    }
}
